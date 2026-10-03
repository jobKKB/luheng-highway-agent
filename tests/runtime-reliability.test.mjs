import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../lib/store.mjs";
import { Engine } from "../lib/engine.mjs";
import { BrowserPolicyError } from "../lib/controlled-browser.mjs";
import { ToolInputError } from "../lib/runtime-errors.mjs";
import { searchKnowledge } from "../lib/knowledge-search.mjs";
import { aggregateUsage } from "../lib/model-usage.mjs";
import { startServer } from "../server.mjs";

const tc = (name, args, id) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const tools = (...calls) => ({ message: { role: "assistant", content: null, tool_calls: calls }, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const text = content => ({ message: { role: "assistant", content }, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const SYNTHETIC_KNOWLEDGE = { id: "synthetic-runtime-note", scope: "workspace", title: "合成检索记录",
  content: "排水沟淤积；仅用于离线测试", source: "SYNTHETIC-SOURCE-RUNTIME-001", version: 1 };
const controlledFixture = overrides => ({
  listTargets: () => [{ id: "synthetic-target", enabled: true }],
  cancel: async () => {},
  ...overrides,
});
async function fixture(t, completion = async () => text("完成"), options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "luheng-runtime-"));
  const store = new Store(dir);
  store.put("settings", "main", { ...store.get("settings", "main"), mode: "api", budget: 100 });
  const engine = new Engine(store, { close: async () => {}, stop: async () => {} }, { delay: 0, getKey: () => "offline-synthetic", completion, ...options });
  t.after(async () => { await engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const task = engine.create({ prompt: "离线通用任务", budget: 100 });
  task.status = "running"; task.modelRounds = 0; task.modelMessages = []; task.toolQueue = []; task.executedToolIds = [];
  engine.save(task);
  return { dir, store, engine, task, signal: new AbortController().signal };
}

test("malformed JSON is a structured safe input error; planner can correct it", async t => {
  let n = 0;
  const h = await fixture(t, async ({ messages }) => {
    if (++n === 1) {
      const error = JSON.parse(messages.at(-1).content);
      assert.equal(error.code, "TOOL_ARGUMENTS_JSON"); assert.equal(error.recoverable, true); assert.equal(error.inputStarted, false);
      return tools(tc("knowledge_search", { query: "排水沟 淤积" }, "corrected"));
    }
    const result = JSON.parse(messages.at(-1).content);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].id, SYNTHETIC_KNOWLEDGE.id);
    assert.equal(result.records[0].source, SYNTHETIC_KNOWLEDGE.source);
    return text("已查到有来源的排水沟记录");
  });
  assert.deepEqual(h.store.all("memories"), [], "fresh installs have no demo knowledge");
  h.store.put("memories", SYNTHETIC_KNOWLEDGE.id, SYNTHETIC_KNOWLEDGE);
  h.task.toolQueue = [tc("knowledge_search", "{", "malformed")];
  await h.engine.runAgentLoop(h.task, h.signal);
  assert.equal(n, 2); assert.match(h.task.output, /已查到/);
  assert.equal(h.task.completion.status, "completed");
  assert.deepEqual(h.task.completion.evidenceToolCallIds, ["corrected"]);
  assert.deepEqual(h.task.toolEvidence.map(({ callId, success, nonempty }) => ({ callId, success, nonempty })),
    [{ callId: "malformed", success: false, nonempty: false }, { callId: "corrected", success: true, nonempty: true }]);
});
test("a malformed call defers its dependent batch without writing a file", async t => {
  const h = await fixture(t, async ({ messages }) => {
    const skipped = JSON.parse(messages.at(-1).content);
    assert.equal(skipped.code, "TOOL_BATCH_DEFERRED"); assert.equal(skipped.inputStarted, false);
    return text("输入需要修正，文件未保存");
  });
  h.task.toolQueue = [tc("knowledge_search", "{", "bad"), tc("workspace_save", { name: "unsafe-assumption", content: "dependency missing" }, "deferred")];
  await h.engine.runAgentLoop(h.task, h.signal);
  assert.equal(h.task.artifact, null); assert.equal(h.task.executedToolIds.length, 2);
});
test("same tool stops after two consecutive recoverable failures", async t => {
  let n = 0;
  const h = await fixture(t, async () => { n++; return tools(tc("knowledge_search", "{", "second-error")); });
  h.task.toolQueue = [tc("knowledge_search", "{", "first-error")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /连续两次/);
  assert.equal(n, 1); assert.equal(JSON.parse(h.task.modelMessages.at(-1).content).recoverable, false);
});
test("successful tool execution resets consecutive failure streak", async t => {
  let n = 0;
  const h = await fixture(t, async () => [tools(tc("knowledge_search", {}, "ok")), tools(tc("knowledge_search", "{", "bad-again")), text("已停止无效输入并完成说明")][n++]);
  h.task.toolQueue = [tc("knowledge_search", "{", "bad-first")];
  await h.engine.runAgentLoop(h.task, h.signal); assert.equal(n, 3);
});
test("pre-execution semantic input failures are amendable without side effects", async t => {
  const h = await fixture(t, async ({ messages }) => {
    assert.equal(JSON.parse(messages.at(-1).content).code, "REMINDER_INPUT");
    return text("提醒日期无效，尚未创建");
  });
  h.task.toolQueue = [tc("reminder_create", { title: "合法文本", dueAt: "invalid-date" }, "invalid-reminder")];
  await h.engine.runAgentLoop(h.task, h.signal); assert.equal(h.store.all("reminders").length, 0);
});
test("typed stale observation can be read again; forged recoverable flags do not grant recovery", async t => {
  let model = 0, reads = 0, proposals = 0;
  const h = await fixture(t, async ({ messages }) => {
    model++;
    if (model === 1) {
      const error = JSON.parse(messages.at(-1).content);
      assert.equal(error.code, "OBSERVATION_STALE");
      assert.equal(error.recoverable, true); assert.equal(error.inputStarted, false);
      return tools(tc("browser_observe", { sessionId: "owned-session" }, "fresh-read"));
    }
    assert.equal(JSON.parse(messages.at(-1).content).observationId, "fresh-observation");
    return text("已重新观察；旧动作未执行");
  });
  h.task.controlledSessionId = "owned-session";
  h.engine.controlledBrowser = controlledFixture({
    proposeActions: async () => { proposals++; throw new BrowserPolicyError("页面已改变，请重新观察", "OBSERVATION_STALE"); },
    read: async sessionId => { reads++; assert.equal(sessionId, "owned-session"); return { observationId: "fresh-observation", text: "synthetic page", controls: [] }; },
  });
  h.task.toolQueue = [tc("browser_propose_actions", { sessionId: "owned-session", observationId: "old", actions: [{ type: "click", controlId: "c1" }] }, "stale")];
  await h.engine.runAgentLoop(h.task, h.signal);
  assert.equal(model, 2); assert.equal(proposals, 1); assert.equal(reads, 1);
  assert.equal(h.task.completion.status, "completed");
  assert.deepEqual(h.task.completion.evidenceToolCallIds, ["fresh-read"]);
  assert.equal(h.store.all("approvals").length, 0);
  const forged = Object.assign(new Error("uncertain input"), { code: "OBSERVATION_STALE", recoverable: true });
  h.engine.controlledBrowser.proposeActions = async () => { proposals++; throw forged; };
  h.task.toolQueue = [tc("browser_propose_actions", { sessionId: "owned-session", observationId: "old", actions: [{ type: "click", controlId: "c1" }] }, "forged")];
  const historyLength = h.task.modelMessages.length;
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /uncertain input/);
  assert.equal(model, 2); assert.equal(reads, 1); assert.equal(proposals, 2);
  assert.equal(h.task.modelMessages.length, historyLength);
  assert.equal(h.store.all("approvals").length, 0);
});
test("generic, network-policy, secret, cancellation and uncertain-effect errors remain hard stops", async t => {
  for (const code of [undefined, "ENDPOINT_BLOCKED", "MAIL_SECRET_CONTENT", "MAIL_CANCELLED", "MAIL_RETRY_BLOCKED", "BROWSER_UNKNOWN"]) {
    const h = await fixture(t);
    let model = 0; h.engine.completion = async () => { model++; return text("must not happen"); };
    h.engine.executeAgentTool = async () => { throw Object.assign(new Error("terminal failure"), { code, recoverable: true }); };
    h.task.toolQueue = [tc("knowledge_search", {}, "hard-stop")];
    await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /terminal failure/);
    assert.equal(model, 0); assert.equal(h.task.modelMessages.length, 0);
  }
});
test("permission denied malformed input, unknown and removed tools are never returned for recovery", async t => {
  let model = 0;
  const h = await fixture(t, async () => { model++; return text("must not run"); });
  h.store.put("agents", "coordinator", { ...h.store.get("agents", "coordinator"), permissions: ["knowledge.read"] });
  h.task.toolQueue = [tc("workspace_save", "{", "forbidden")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /workspace.write/);
  assert.equal(h.task.modelMessages.length, 0);
  h.task.toolQueue = [tc("unknown_tool", "{", "unknown")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /未开放/);
  for (const name of ["browser_read", "browser_submit", "mail_draft"]) {
    h.task.toolQueue = [tc(name, "{", "removed-" + name)];
    await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), error => error.code === "TOOL_UNIMPLEMENTED");
  }
  assert.equal(model, 0); assert.equal(h.task.modelMessages.length, 0); assert.equal(h.task.budgetUsed, 0);
});
test("duplicate IDs in a batch stop before the first side effect", async t => {
  const h = await fixture(t);
  h.task.toolQueue = [tc("workspace_save", { name: "file", content: "x" }, "same"), tc("workspace_save", { name: "file2", content: "y" }, "same")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /重复工具调用/);
  assert.equal(h.task.artifact, null);
});
test("closed, aborted, cancelled and rejected tasks cannot replan malformed input", async t => {
  for (const state of ["closed", "aborted", "cancelled", "rejected"]) {
    const h = await fixture(t); h.task.toolQueue = [tc("knowledge_search", "{", "bad")];
    const controller = new AbortController();
    if (state === "closed") h.engine.closed = true;
    if (state === "aborted") controller.abort();
    if (["cancelled", "rejected"].includes(state)) h.engine.save({ ...h.task, status: state });
    await assert.rejects(h.engine.runAgentLoop(h.task, controller.signal), /已停止/);
    assert.equal(h.task.modelMessages.length, 0);
    h.engine.closed = false;
  }
});
test("cross-task browser and cross-role private-context attempts remain terminal", async t => {
  let reads = 0, model = 0;
  const h = await fixture(t, async () => { model++; return text("must not run"); });
  h.engine.controlledBrowser = controlledFixture({ read: async () => { reads++; throw Error("must not read"); } });
  h.task.controlledSessionId = "owned";
  h.task.toolQueue = [tc("browser_observe", { sessionId: "other-task" }, "cross-task")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /本任务/);
  h.task.privateContextOwner = "coordinator";
  h.task.toolQueue = [tc("agent_delegate", { agentId: "researcher", instruction: "transfer private" }, "cross-role")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /私有知识/);
  assert.equal(reads, 0); assert.equal(model, 0);
  assert.equal(h.task.modelMessages.length, 0); assert.equal(h.task.budgetUsed, 0);
});
test("identifiable forbidden targets still hard stop when other schema fields are malformed", async t => {
  const h = await fixture(t); let model = 0, reads = 0, sends = 0;
  h.engine.completion = async () => { model++; return text("must not run"); };
  h.engine.controlledBrowser = controlledFixture({ read: async () => { reads++; throw Error("must not read"); } });
  h.task.controlledSessionId = "owned";
  h.task.toolQueue = [tc("browser_observe", { sessionId: "other-task", unexpected: true }, "bad-target")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /本任务/);
  h.task.privateContextOwner = "coordinator";
  h.task.toolQueue = [tc("agent_delegate", { agentId: "writer", instruction: 17 }, "bad-delegate")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /跨角色/);
  h.task.mailDraftId = "owned-draft";
  h.engine.mail = {
    getPublicConfig: () => [{ accountId: "synthetic-account", smtp: {}, hasCredentials: { smtp: true } }],
    getOutbox: () => ({ taskId: "other-task" }),
    requestSend: async () => { sends++; throw Error("must not request send"); },
  };
  h.task.toolQueue = [tc("mail_request_send", { draftId: "foreign", unexpected: true }, "bad-draft")];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /当前任务/);
  assert.equal(model, 0); assert.equal(reads, 0); assert.equal(sends, 0);
  assert.equal(h.task.modelMessages.length, 0); assert.equal(h.task.budgetUsed, 0);
  assert.equal(h.store.all("approvals").length, 0);
});
test("stale and expired evidence is recorded as unexecuted, never completed, in bounded summary", async t => {
  const h = await fixture(t); h.task.budgetUsed = h.task.budget;
  for (const status of ["stale", "expired"]) {
    h.task.modelMessages.push({ role: "tool", tool_call_id: status, content: JSON.stringify({ status, inputStarted: false, actionsCompleted: 0 }) });
  }
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  assert.equal(h.task.completionSummary.completed.length, 0); assert.equal(h.task.completionSummary.incomplete.length, 2);
  assert.equal(h.task.completionSummary.recorded.every(item => !item.success), true);
});
test("manual handoff invalidates the previous proposed action and cannot claim it completed", async t => {
  const h = await fixture(t); h.task.budgetUsed = h.task.budget;
  const call = tc("browser_propose_actions", {}, "handoff");
  h.task.modelMessages = [{ role: "assistant", tool_calls: [call] }, { role: "tool", tool_call_id: call.id,
    content: JSON.stringify({ status: "manual_handoff_complete", previousApprovalInvalidated: true, observation: { observationId: "fresh" } }) }];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  assert.equal(h.task.completionSummary.recorded[0].success, false);
  assert.deepEqual(h.task.completionSummary.completed, []); assert.deepEqual(h.task.completionSummary.incomplete, ["handoff"]);
});
test("bounded summary stores only small metadata and limits total excerpts, preserving evidence hashes", async t => {
  const h = await fixture(t); h.task.budgetUsed = h.task.budget;
  const marker = "SYNTHETIC-FULL-EVIDENCE-NOT-IN-SUMMARY";
  for (let i = 0; i < 8; i++) {
    const call = tc("knowledge_search", {}, "large-" + i);
    const content = JSON.stringify({ records: Array.from({ length: 12 }, (_, n) => ({ id: "fixture-" + n, title: "synthetic", content: "测".repeat(19900) + marker, source: "offline" })) });
    h.task.modelMessages.push({ role: "assistant", tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content });
  }
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  const serialized = JSON.stringify(h.task.completionSummary);
  assert.ok(serialized.length < 10000); assert.ok(h.task.output.length <= 12000);
  assert.equal(serialized.includes(marker), false); assert.equal(serialized.includes("测"), false);
  assert.equal(h.task.completionSummary.recorded.some(item => Object.hasOwn(item, "evidence")), false);
  for (const item of h.task.completionSummary.recorded) {
    const content = h.task.modelMessages[item.evidenceRef.messageIndex].content;
    assert.equal(item.evidenceCharacters, content.length); assert.equal(item.evidenceBytes, Buffer.byteLength(content));
    assert.equal(item.evidenceSha256, createHash("sha256").update(content).digest("hex"));
  }
  assert.deepEqual(h.task.completionSummary.completed, Array.from({ length: 8 }, (_, i) => "large-" + i));
});
test("unidentified legacy evidence remains unknown in bounded summary", async t => {
  const h = await fixture(t); h.task.budgetUsed = h.task.budget;
  h.task.modelMessages = [{ role: "tool", tool_call_id: "legacy", content: "legacy evidence" }];
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  assert.equal(h.task.completionSummary.recorded[0].success, null); assert.deepEqual(h.task.completionSummary.completed, []);
  assert.deepEqual(h.task.completionSummary.incomplete, ["legacy"]);
});
test("worst-size bounded batch keeps metadata under 64KiB and full output under 12000 characters", async t => {
  const h = await fixture(t); h.task.budgetUsed = h.task.budget;
  for (let i = 0; i < 64; i++) {
    const call = tc("knowledge_search", {}, String(i).padEnd(200, "x"));
    h.task.modelMessages.push({ role: "assistant", tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ records: [{ content: "large".repeat(1000) }] }) });
  }
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  assert.ok(Buffer.byteLength(JSON.stringify(h.task.completionSummary)) < 65536);
  assert.ok(h.task.output.length <= 12000); assert.equal(h.task.completionSummary.outputTruncated, true);
});
test("8-round cap preserves eight results and 96 tokens with no ninth request", async t => {
  let n = 0;
  const h = await fixture(t, async () => tools(tc("knowledge_search", {}, "round-" + ++n)));
  assert.deepEqual(h.store.all("memories"), []);
  h.store.put("memories", SYNTHETIC_KNOWLEDGE.id, SYNTHETIC_KNOWLEDGE);
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /8轮/);
  assert.equal(n, 8); assert.equal(h.task.usage.total_tokens, 96);
  assert.equal(h.task.completionSummary.completed.length, 8);
  assert.equal(h.task.completionSummary.finalModelAnswerAvailable, false);
  assert.equal(h.task.modelRounds, 8); assert.equal(h.task.budgetUsed, 16);
  assert.equal(h.task.modelMessages.filter(message => message.role === "tool").length, 8);
  assert.deepEqual(h.task.executedToolIds, Array.from({ length: 8 }, (_, i) => "round-" + (i + 1)));
  assert.equal(h.task.toolEvidence.every(item => item.success && item.nonempty), true);
  assert.match(h.task.output, /未完成/); assert.match(h.task.output, /SYNTHETIC-SOURCE-RUNTIME-001/);
  assert.doesNotMatch(h.task.output, /DEMO-/);
});
test("budget exhaustion preserves saved artifact and reports unexecuted tool", async t => {
  let n = 0;
  const h = await fixture(t, async () => { n++; return tools(tc("workspace_save", { name: "真实结果", content: "verified local file" }, "saved"), tc("knowledge_search", {}, "pending")); });
  h.task.budget = 2;
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  assert.equal(n, 1); assert.equal(h.task.modelRounds, 1); assert.equal(h.task.budgetUsed, 2);
  assert.equal(await readFile(join(h.dir, "artifacts", h.task.artifact.filename), "utf8"), "verified local file");
  assert.equal(h.task.completionSummary.incomplete[0], "pending"); assert.match(h.task.output, /真实结果.txt/);
});
test("default 12-operation budget stops before the next side effect with two hashed files and no extra request", async t => {
  let n = 0;
  const h = await fixture(t, async () => {
    n++;
    if (n === 1) return tools(tc("workspace_save", { name: "文稿一", content: "first" }, "save1"), tc("workspace_save", { name: "文稿二", content: "second" }, "save2"));
    return tools(tc(n === 6 ? "reminder_create" : "knowledge_search", n === 6 ? { title: "未执行提醒", dueAt: "2030-01-01T00:00:00Z" } : {}, "step" + n));
  });
  h.task.budget = 12;
  await assert.rejects(h.engine.runAgentLoop(h.task, h.signal), /预算/);
  assert.equal(n, 6); assert.equal(h.task.budgetUsed, 12); assert.equal(h.task.artifacts.length, 2); assert.equal(h.store.all("reminders").length, 0);
  for (const artifact of h.task.artifacts) assert.equal(artifact.sha256, createHash("sha256").update(await readFile(join(h.dir, "artifacts", artifact.filename))).digest("hex"));
  assert.equal(h.task.completionSummary.pending[0].tool, "reminder_create"); assert.match(h.task.output, /SHA256/);
});
test("main and delegated usage accumulates at the shared request entry point", async t => {
  let n = 0;
  const h = await fixture(t, async ({ messages }) => {
    if (messages[0]?.content?.includes("受限只读子智能体")) return text("子角色只读结论");
    return ++n === 1 ? tools(tc("agent_delegate", { agentId: "researcher", instruction: "只读核验" }, "delegate")) : text("最终总结");
  });
  await h.engine.runAgentLoop(h.task, h.signal);
  assert.equal(h.task.usage.total_tokens, 36); assert.equal(h.task.usage.main_requests, 2); assert.equal(h.task.usage.delegate_requests, 1);
  assert.equal(h.task.modelUsageCalls.length, 3);
});
test("missing or invalid usage is honest and failed calls are never invented as zero", async t => {
  const h = await fixture(t, async () => ({ message: { role: "assistant", content: "answer" } }));
  await h.engine.modelRequest(h.task, [], h.signal);
  h.engine.completion = async () => text("known"); await h.engine.modelRequest(h.task, [], h.signal);
  h.engine.completion = async () => { throw Error("offline failure"); }; await assert.rejects(h.engine.modelRequest(h.task, [], h.signal), /offline failure/);
  assert.equal(h.task.usage.total_tokens, null); assert.equal(h.task.usage.known_total_tokens, 12);
  assert.equal(h.task.usage.missing_requests, 2); assert.equal(h.task.usage.partial, true);
  assert.equal(aggregateUsage([{ usage: { total_tokens: -5, prompt_tokens: "1" } }]).known_total_tokens, 0);
});
test("persisted usage identities do not recount completed calls on resumed planning", async t => {
  const h = await fixture(t, async () => text("before pause"));
  await h.engine.modelRequest(h.task, [], h.signal);
  const recovered = h.store.get("tasks", h.task.id);
  recovered.toolQueue = []; recovered.modelMessages = []; recovered.executedToolIds = [];
  await h.engine.runAgentLoop(recovered, h.signal);
  assert.equal(recovered.usage.total_tokens, 24); assert.equal(recovered.modelUsageCalls.length, 2);
  assert.equal(new Set(recovered.modelUsageCalls.map(call => call.id)).size, 2);
});
test("legacy last-response usage is preserved as a lower bound without claiming a full total", async t => {
  const h = await fixture(t); h.task.usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }; h.task.modelRounds = 3;
  await h.engine.modelRequest(h.task, [], h.signal);
  assert.equal(h.task.usage.total_tokens, null); assert.equal(h.task.usage.known_total_tokens, 24); assert.equal(h.task.usage.legacy_history_unknown, true);
});
test("knowledge search tokenizes keywords, supports Han bigrams and deterministically ranks", () => {
  const rows = [{ id: "b", title: "记录", content: "排水沟淤积", source: "s" }, { id: "a", title: "排水沟", content: "淤积", source: "s2" }, { id: "c", title: "记录", content: "排水，水沟，沟淤，淤积", source: "s3" }];
  assert.deepEqual(searchKnowledge(rows, "排水沟 淤积").map(row => row.id), ["a", "b", "c"]);
  assert.deepEqual(searchKnowledge(rows, "排水沟　淤积").map(row => row.id), ["a", "b", "c"]);
  assert.deepEqual(searchKnowledge(rows, "排水沟，淤积").map(row => row.id), ["a", "b", "c"]);
  assert.deepEqual(searchKnowledge(rows, "排水沟淤积").map(row => row.id), ["b", "c"]);
  assert.equal(searchKnowledge(rows, "排水沟 缺失词").length, 0);
  assert.deepEqual(searchKnowledge([...rows].reverse(), "").map(row => row.id), searchKnowledge(rows, "").map(row => row.id));
});
test("keyword search preserves role ACL, source metadata and 12-record bound", async t => {
  const h = await fixture(t);
  h.store.put("memories", "other-private", { id: "other-private", scope: "agent", ownerAgentId: "writer", title: "排水沟", content: "淤积", source: "hidden" });
  for (let i = 0; i < 16; i++) h.store.put("memories", "visible-" + i, { id: "visible-" + i, title: "排水沟", content: "淤积", source: "source-" + i, version: 2 });
  const result = await h.engine.executeAgentTool(h.task, "knowledge_search", { query: "排水沟 淤积" }, h.signal);
  assert.equal(result.records.length, 12); assert.equal(result.records.some(row => row.id === "other-private"), false);
  assert.equal(h.task.sources.length, 12); assert.equal(h.task.sources.some(row => row.source === "hidden"), false);
});
test("multiple saved files are registered, downloadable after budget stop, and old pointer is compatible", async t => {
  const dir = await mkdtemp(join(tmpdir(), "luheng-artifacts-")); let n = 0;
  const app = await startServer({ port: 0, dataDir: dir, stepDelay: 0, completion: async () => {
    n++; return tools(tc("workspace_save", { name: "第一文件", content: "first evidence" }, "first"), tc("workspace_save", { name: "第二文件", content: "second evidence" }, "second"));
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.store.put("settings", "main", { ...app.store.get("settings", "main"), mode: "api" });
  const initial = await fetch(app.url), cookie = initial.headers.get("set-cookie").split(";")[0];
  const headers = { cookie, origin: app.url, "content-type": "application/json" };
  const created = await fetch(app.url + "/api/tasks", { method: "POST", headers, body: JSON.stringify({ prompt: "保存两个通用文稿", budget: 3 }) });
  const task = await created.json(); let result;
  for (let i = 0; i < 300; i++) { result = app.store.get("tasks", task.id); if (result.status === "failed") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(result.status, "failed", result.error); assert.equal(n, 1); assert.equal(result.artifacts.length, 2); assert.equal(result.artifact.filename, result.artifacts[1].filename);
  for (const [index, artifact] of result.artifacts.entries()) {
    const response = await fetch(app.url + artifact.url, { headers }); assert.equal(response.status, 200); assert.equal(await response.text(), index ? "second evidence" : "first evidence");
    assert.equal((await fetch(app.url + artifact.url)).status, 401);
    assert.equal(artifact.sha256, createHash("sha256").update(await readFile(join(dir, "artifacts", artifact.filename))).digest("hex"));
  }
  assert.equal((await fetch(app.url + "/api/artifacts/unregistered.txt", { headers })).status, 404);
  assert.equal((await fetch(app.url + "/api/tasks/" + task.id + "/export", { method: "POST", headers, body: JSON.stringify({ format: "docx" }) })).status, 400);
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8"); assert.match(source, /artifacts\.map\(artifact/);
});
test("input error class is explicit rather than message or recoverable-flag based", () => {
  const error = new ToolInputError("input", "TEST_INPUT"); assert.equal(error.code, "TEST_INPUT");
  assert.equal(Object.assign(new Error("input"), { recoverable: true }) instanceof ToolInputError, false);
});
