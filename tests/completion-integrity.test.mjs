import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.mjs";
import { createPublicWebService } from "../lib/public-web.mjs";
import { actionRequirements, evidenceRequirement, recordToolEvidence, evaluateFinish } from "../lib/task-outcome.mjs";

const call = (name, args = {}, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const tools = (...tool_calls) => ({ message: { role: "assistant", content: null, tool_calls } });
const text = content => ({ message: { role: "assistant", content } });
const final = { status: "completed", summary: "Synthetic answer", claimType: "stable", evidenceToolCallIds: [] };
const now = Date.parse("2026-10-03T12:00:00Z");
const page = overrides => ({ ok: true, status: "success", retrievedAt: new Date(now).toISOString(), results: [{
  url: "https://example.test/source", text: "Synthetic current company CEO is Alice", publishedAt: "2026-10-03", ...overrides,
}] });
const outcome = (prompt, result, finish = final) => evaluateFinish({ prompt, toolEvidence: [recordToolEvidence(call("public_web_extract"), result)] }, finish, { now });

async function fixture(t, completion, publicWebService) {
  const dir = await mkdtemp(join(tmpdir(), "luheng-completion-integrity-"));
  const app = await startServer({ port: 0, dataDir: dir, stepDelay: 0, completion, publicWebService });
  const actor = app.store.get("agents", "coordinator");
  // Persisted flags are exercised independently of the local-context allowlist.
  app.store.put("agents", actor.id, { ...actor, permissions: actor.permissions.filter(p => !["files.read", "files.write", "commands.run"].includes(p)) });
  app.store.put("settings", "main", { ...app.store.get("settings", "main"), mode: "api", model: "synthetic-protocol", budget: 30 });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, async run(prompt) {
    const task = app.engine.create({ prompt });
    for (let i = 0; i < 500; i++) {
      const latest = app.engine.liveTask(task.id);
      if (["completed", "failed", "needs_attention", "cancelled"].includes(latest.status)) return latest;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error("Synthetic task did not settle");
  } };
}

for (const finishing of ["direct", "agent_finish"]) test(`file delivery request cannot complete with ${finishing} unsupported stable claim`, async t => {
  const h = await fixture(t, async () => finishing === "direct" ? text("已保存 audit-note.txt") : tools(call("agent_finish", { ...final, summary: "已保存 audit-note.txt" })));
  const result = await h.run("请将合成内容保存为 audit-note.txt，给我下载链接");
  assert.equal(result.status, "needs_attention");
  assert.equal(result.completion.code, "ACTION_RECEIPT_MISSING");
  assert.equal(result.completion.claimType, "action");
  assert.deepEqual(result.artifacts, []);
});

test("real saved artifact receipt completes the same file delivery request", async t => {
  let rounds = 0;
  const h = await fixture(t, async () => ++rounds === 1 ? tools(call("workspace_save", { name: "audit-note.txt", content: "Synthetic content only" })) : text("已保存，下载链接见文件卡片"));
  const result = await h.run("请将合成内容保存为 audit-note.txt，给我下载链接");
  assert.equal(result.status, "completed", result.error);
  assert.ok(result.artifact.url);
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.toolEvidence[0].actionKinds, ["file", "download"]);
});

test("receipts must match the requested action, not an unrelated completed read/reminder/draft", () => {
  const evidence = [recordToolEvidence(call("reminder_create"), { id: "synthetic-reminder" }),
    recordToolEvidence(call("local_read_file"), { operation: { kind: "read", status: "completed" } }),
    recordToolEvidence(call("mail_create_draft"), { id: "synthetic-draft", status: "draft", sent: false })];
  for (const prompt of ["保存文件并提供下载链接", "发送这封邮件"]) {
    const result = evaluateFinish({ prompt, toolEvidence: evidence }, final);
    assert.equal(result.code, "ACTION_RECEIPT_MISSING", prompt);
  }
  const localWrite = recordToolEvidence(call("local_write_file"), { operation: { kind: "write", status: "completed" } });
  assert.equal(evaluateFinish({ prompt: "将文字保存到授权目录", toolEvidence: [localWrite] }, final).status, "completed");
  assert.equal(evaluateFinish({ prompt: "保存文件并提供下载链接", toolEvidence: [localWrite] }, final).code, "ACTION_RECEIPT_MISSING");
});

test("ordinary composition, how-to and historical questions remain answerable", () => {
  for (const prompt of ["你好", "解释天气形成原理", "写一首诗", "Write a short story", "How do I save a file?", "解释如何发送邮件", "写一篇关于保存文件的教程", "Do not save files; just explain this topic", "不要发送邮件，只写一段说明", "Who is the company CEO in 2020?", "谁是2020年的总统？", "What was the weather in 2020?"]) {
    assert.deepEqual(actionRequirements(prompt), [], prompt);
    assert.equal(evidenceRequirement(prompt), "none", prompt);
    assert.equal(evaluateFinish({ prompt, toolEvidence: [] }, final).status, "completed", prompt);
  }
});

test("current facts require fresh substantive content, not a new retrieval timestamp", () => {
  const prompt = "Who is the current CEO?";
  for (const overrides of [{ publishedAt: "2020-01-01", text: "2020-01-01 CEO was Alice" },
    { publishedAt: undefined }, { publishedAt: undefined, text: "2020-01-01 CEO was Alice" },
    { text: "2020-01-01 CEO was Alice" }, { text: "" }, { text: "  \n  " },
    { publishedAt: "2030-01-01" }]) {
    assert.equal(outcome(prompt, page(overrides)).code, "CURRENT_SOURCE_MISSING", JSON.stringify(overrides));
  }
  assert.equal(outcome(prompt, page({})).status, "completed");
  assert.equal(outcome(prompt, page({ publishedAt: undefined, text: "2026-10-03 current CEO is Alice" })).status, "completed");
  assert.equal(outcome(prompt, page({}), { ...final, evidenceToolCallIds: ["unknown"] }).code, "FINISH_EVIDENCE_UNKNOWN");
});

test("actual MCP entry containing only a URL, title and recent date is not answer evidence", async () => {
  const response = (packet, status = 200) => ({ status, headers: { "content-type": "application/json" }, text: async () => typeof packet === "string" ? packet : JSON.stringify(packet) });
  const service = createPublicWebService({ clock: () => now, resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: async (_url, options) => {
      const packet = JSON.parse(options.body);
      if (packet.method === "initialize") return response({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } });
      if (packet.method === "notifications/initialized") return response("", 202);
      return response({ jsonrpc: "2.0", id: 2, result: { structuredContent: { results: [{ url: "https://example.test/entry", title: "Synthetic entry", publishedAt: new Date(now).toISOString() }] } } });
    } });
  const result = await service.search({ query: "Synthetic current company CEO" });
  const evidence = recordToolEvidence(call("public_web_search"), result);
  assert.equal(evidence.nonempty, false);
  assert.deepEqual(evidence.sources, []);
  assert.equal(evaluateFinish({ prompt: "Who is the CEO?", toolEvidence: [evidence] }, final, { now }).code, "CURRENT_SOURCE_MISSING");
});

for (const withKnowledge of [false, true]) test(`read-only delegation ${withKnowledge ? "with shared knowledge disables" : "without knowledge permits"} later public tools`, async t => {
  let mainRounds = 0, childCalls = 0, publicCalls = 0, h;
  const service = { networkState: () => ({ status: "unobserved" }), search: async () => { publicCalls++; return page({}); } };
  h = await fixture(t, async request => {
    if (!request.tools) {
      childCalls++;
      const task = [...h.app.engine.running.keys()].map(id => h.app.engine.liveTask(id))[0];
      assert.equal(task.nonPublicContext, withKnowledge, "boundary exists before child sees any reference data");
      assert.equal(h.app.store.get("tasks", task.id).nonPublicContext, withKnowledge, "safe context flag is already persisted");
      return text("Synthetic read-only research");
    }
    if (++mainRounds === 1) return tools(call("agent_delegate", { agentId: "researcher", instruction: "Read-only synthetic research" }));
    assert.equal(request.tools.some(tool => tool.function.name === "public_web_search"), !withKnowledge);
    if (!withKnowledge && mainRounds === 2) return tools(call("public_web_search", { query: "Synthetic public topic" }));
    return text("Synthetic explanation");
  }, service);
  if (withKnowledge) h.app.store.put("memories", "synthetic-note", { id: "synthetic-note", scope: "workspace", title: "Synthetic note", content: "Synthetic workspace content", source: "synthetic-only" });
  const result = await h.run("请资料员只读研究合成主题");
  assert.equal(result.status, "completed", result.error);
  assert.equal(childCalls, 1);
  assert.equal(result.nonPublicContext, withKnowledge);
  assert.equal(publicCalls, withKnowledge ? 0 : 1);
});

for (const change of ["revoke_permission", "disable_role"]) test(`HTTP role ${change} during actual MCP DNS prevents a later query transmission`, { timeout: 5000 }, async t => {
  let releaseDNS, dnsReady;
  const waiting = new Promise(resolve => { releaseDNS = resolve; });
  const ready = new Promise(resolve => { dnsReady = resolve; });
  let lookups = 0, rounds = 0;
  const packets = [];
  const response = (packet, status = 200) => ({ status, headers: { "content-type": "application/json" }, text: async () => typeof packet === "string" ? packet : JSON.stringify(packet) });
  const service = createPublicWebService({ resolver: async () => {
    if (++lookups === 3) { dnsReady(); await waiting; }
    return [{ address: "93.184.216.34", family: 4 }];
  }, requestImpl: async (_url, options) => {
    const packet = JSON.parse(options.body); packets.push(packet);
    if (packet.method === "initialize") return response({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } });
    if (packet.method === "notifications/initialized") return response("", 202);
    return response({ jsonrpc: "2.0", id: 2, result: { structuredContent: { results: page({}).results } } });
  } });
  const h = await fixture(t, async () => ++rounds === 1 ? tools(call("public_web_search", { query: "Synthetic public information" })) : text("Synthetic result"), service);
  try {
    const pending = h.run("Search for synthetic public information");
    await ready;
    const pageResponse = await fetch(h.app.url), cookie = pageResponse.headers.get("set-cookie").split(";")[0];
    const actor = h.app.store.get("agents", "coordinator");
    const altered = change === "disable_role" ? { ...actor, enabled: false } : { ...actor, permissions: actor.permissions.filter(p => p !== "web.read") };
    const changed = await fetch(h.app.url + "/api/agents/coordinator", { method: "PUT", headers: { cookie, origin: h.app.url, "content-type": "application/json" }, body: JSON.stringify(altered) });
    assert.equal(changed.status, 200, await changed.text());
    assert.deepEqual(packets.map(p => p.method), ["initialize", "notifications/initialized"]);
    releaseDNS();
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.deepEqual(packets.map(p => p.method), ["initialize", "notifications/initialized"]);
    assert.equal(rounds, 1);
  } finally { releaseDNS(); }
});
