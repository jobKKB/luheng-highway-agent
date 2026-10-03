import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { Store } from "../lib/store.mjs";
import { Engine } from "../lib/engine.mjs";
import { callCompletion } from "../lib/model.mjs";
import { startServer } from "../server.mjs";

// Synthetic fixtures only: no real key, account, endpoint, mailbox or business data.
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const slice = (start, end) => { const a = source.indexOf(start); const b = source.indexOf(end, a); assert.ok(a >= 0 && b > a, "slice " + start); return source.slice(a, b); };
const declarations = slice("const SETTINGS_FIELDS", "let state={").replace(/^const /m, "var ").replace(/^let /m, "var ");
const controller = slice("// SETTINGS-CONTROLLER-START", "// SETTINGS-CONTROLLER-END");
const loader = slice("async function loadState(", "async function createTask(");
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function makeForm(values) {
  const radios = ["demo", "api"].map(value => ({ name: "mode", value, checked: values.mode === value }));
  const inputs = { endpoint: { name: "endpoint", value: values.endpoint }, model: { name: "model", value: values.model },
    budget: { name: "budget", value: String(values.budget) }, apiKey: { name: "apiKey", value: values.apiKey || "", placeholder: "" } };
  const submit = { disabled: false };
  return { radios, inputs, submit, isConnected: true,
    querySelector(selector) { if (selector === '[type="submit"]') return submit; const m = selector.match(/\[name="(\w+)"\]/); return m ? inputs[m[1]] || null : null; },
    querySelectorAll(selector) { return selector === '[name="mode"]' ? radios : []; },
    values() { return { mode: radios.find(r => r.checked)?.value, endpoint: inputs.endpoint.value, model: inputs.model.value, budget: inputs.budget.value, apiKey: inputs.apiKey.value }; } };
}
const stateFor = settings => ({ settings, tasks: [], schedules: [], agents: [], memories: [], reminders: [], audit: [], approvals: [] });
function harness(saved) {
  const status = { textContent: "" };
  const h = { posts: [], gets: [], toasts: [], apiQueue: [], status };
  h.form = makeForm(saved);
  const context = vm.createContext({
    console, URL, Object, String, Number, JSON, Promise, Error, Set, Map, Array,
    state: { settings: { ...saved }, tasks: [], reminders: [] },
    FormData: class { constructor(form) { this.form = form; } get(key) { return key === "mode" ? this.form.radios.find(r => r.checked)?.value ?? null : this.form.inputs[key]?.value ?? null; } },
    $: selector => selector === "#settings-form" ? h.form : selector === "#settings-status" ? status : null,
    post: async (route, body) => { h.posts.push({ route, body }); return {}; },
    api: async route => { h.gets.push(route); const next = h.apiQueue.shift(); if (!next) throw new Error("synthetic state unavailable"); return next.promise ? next.promise : next; },
    toast: (text, isError) => h.toasts.push({ text, isError }), str: value => String(value ?? ""), connectionDiagnostic: null,
    array: value => Array.isArray(value) ? value : [], syncLocalAccess: async () => {}, syncTaskDetail: async () => {}, view: "settings", selectedTaskId: null,
    online: true, loaded: true, localAccessAvailable: false, localAccessLastSignature: "", lastSignature: "", activeTaskDetail: null,
    document: { activeElement: null, contains: () => true }, render: () => {}, renderChrome: () => {}, renderLocalSettingsSummary: () => "",
    maybeLocalOnboarding: () => {}, modal: null, notificationSignature: () => "", openModal: () => {}, notificationSeen: new Set(), pollBusy: false, refreshWaiters: [],
  });
  vm.runInContext(declarations + controller + loader, context);
  h.context = context;
  h.edit = (field, value, form = h.form) => {
    if (field === "mode") { for (const radio of form.radios) radio.checked = radio.value === value; context.trackSettingsEdit(form.radios.find(r => r.value === value)); return; }
    form.inputs[field].value = value; context.trackSettingsEdit(form.inputs[field]);
  };
  return h;
}
const savedA = { mode: "demo", endpoint: "https://a.example/v1", model: "m0", budget: 20, hasApiKey: false };

test("settings: a late POST success keeps four fields reverted to old saved values; untouched fields adopt normalized values; duplicate save is gated", async () => {
  const h = harness(savedA), held = deferred();
  h.context.post = async (route, body) => { h.posts.push({ route, body }); return held.promise; };
  h.edit("mode", "api"); h.edit("endpoint", "https://b.example/v1/"); h.edit("model", "m1"); h.edit("budget", "30");
  const saving = h.context.saveSettings(h.form);
  assert.equal(h.posts.length, 1); assert.equal(h.form.submit.disabled, true);
  assert.deepEqual({ ...(await h.context.saveSettings(h.form)) }, { duplicate: true }); assert.equal(h.posts.length, 1);
  h.edit("mode", "demo"); h.edit("endpoint", "https://a.example/v1"); h.edit("model", "m0"); h.edit("budget", "20");
  const confirmed = { mode: "api", endpoint: "https://b.example/v1", model: "m1", budget: 30, hasApiKey: false, credentialStorage: "memory-only" };
  h.apiQueue.push(stateFor(confirmed)); held.resolve(confirmed); await saving;
  assert.deepEqual(h.form.values(), { mode: "demo", endpoint: "https://a.example/v1", model: "m0", budget: "20", apiKey: "" });
  assert.equal(h.context.state.settings.mode, "api"); assert.equal(h.context.state.settings.model, "m1");
  assert.equal(h.form.submit.disabled, false); assert.equal(h.status.textContent, "配置已保存");
  // Second save with no later edits: server normalization replaces the submitted text.
  const h2 = harness(savedA);
  h2.context.post = async (route, body) => { h2.posts.push({ route, body }); return { mode: "api", endpoint: "https://b.example/v1", model: "m1", budget: 100, hasApiKey: false }; };
  h2.edit("mode", "api"); h2.edit("endpoint", "https://b.example/v1/"); h2.edit("model", " m1 "); h2.edit("budget", "150");
  h2.apiQueue.push(stateFor({ mode: "api", endpoint: "https://b.example/v1", model: "m1", budget: 100, hasApiKey: false }));
  await h2.context.saveSettings(h2.form);
  assert.equal(h2.posts[0].body.model, "m1");
  assert.deepEqual(h2.form.values(), { mode: "api", endpoint: "https://b.example/v1", model: "m1", budget: "100", apiKey: "" });
});

test("settings: a key deleted and retyped with the same value during save is not cleared; an untouched submitted key is cleared", async () => {
  const h = harness(savedA), held = deferred();
  h.context.post = async (route, body) => { h.posts.push({ route, body }); return held.promise; };
  h.edit("apiKey", "synthetic-key-A");
  const saving = h.context.saveSettings(h.form);
  h.edit("apiKey", ""); h.edit("apiKey", "synthetic-key-A");
  h.apiQueue.push(stateFor({ ...savedA, hasApiKey: true })); held.resolve({ ...savedA, hasApiKey: true }); await saving;
  assert.equal(h.posts[0].body.apiKey, "synthetic-key-A");
  assert.equal(h.form.inputs.apiKey.value, "synthetic-key-A"); assert.equal(h.context.settingsDraft.apiKey, "synthetic-key-A");
  h.context.post = async (route, body) => { h.posts.push({ route, body }); return { ...savedA, hasApiKey: true }; };
  h.apiQueue.push(stateFor({ ...savedA, hasApiKey: true })); await h.context.saveSettings(h.form);
  assert.equal(h.form.inputs.apiKey.value, ""); assert.equal(h.context.settingsDraft.apiKey, "");
  assert.equal(h.form.inputs.apiKey.placeholder, "已配置，留空保留当前密钥");
});

test("settings: navigating away and back during a save keeps page-memory drafts and blocks a duplicate POST", async () => {
  const h = harness(savedA), held = deferred();
  h.context.post = async (route, body) => { h.posts.push({ route, body }); return held.promise; };
  h.edit("model", "m-draft"); h.edit("apiKey", "synthetic-key-B");
  const saving = h.context.saveSettings(h.form);
  h.edit("model", "m-newer");
  const rerendered = makeForm(savedA); h.form = rerendered; h.context.applySettingsToForm(rerendered);
  assert.equal(rerendered.inputs.model.value, "m-newer"); assert.equal(rerendered.inputs.apiKey.value, "synthetic-key-B");
  assert.equal(rerendered.submit.disabled, true);
  assert.deepEqual({ ...(await h.context.saveSettings(rerendered)) }, { duplicate: true }); assert.equal(h.posts.length, 1);
  h.apiQueue.push(stateFor({ ...savedA, model: "m-draft", hasApiKey: true })); held.resolve({ ...savedA, model: "m-draft", hasApiKey: true }); await saving;
  assert.equal(rerendered.inputs.model.value, "m-newer"); assert.equal(rerendered.inputs.apiKey.value, "");
  assert.equal(rerendered.submit.disabled, false);
});

test("settings: a late connection test for saved endpoint A cannot report as the result for newly saved endpoint B", async () => {
  const saved = { mode: "api", endpoint: "https://a.example/v1", model: "m-a", budget: 20, hasApiKey: true };
  const h = harness(saved), testA = deferred(), testB = deferred(); const tests = [testA, testB];
  h.context.post = async (route, body) => { h.posts.push({ route, body }); if (route === "/api/settings/test") return tests.shift().promise;
    return { ...saved, endpoint: "https://b.example/v1" }; };
  const first = h.context.testSettingsConnection();
  h.edit("endpoint", "https://b.example/v1"); h.apiQueue.push(stateFor({ ...saved, endpoint: "https://b.example/v1" }));
  await h.context.saveSettings(h.form);
  testA.resolve({ ok: true, message: "A 连接成功" });
  assert.deepEqual({ ...(await first) }, { stale: true });
  assert.equal(h.status.textContent, "配置已保存");
  const testC = deferred(); tests.push(testC);
  const second = h.context.testSettingsConnection(); const third = h.context.testSettingsConnection();
  testB.resolve({ ok: true, message: "B 旧一次测试" });
  assert.deepEqual({ ...(await second) }, { stale: true }); // superseded by the newer test
  testC.resolve({ ok: true, message: "B 连接成功" });
  const latest = await third;
  assert.equal(latest.stale, false);
  assert.ok(h.status.textContent.includes("B 连接成功"));
  assert.ok(h.status.textContent.includes("测试对象：b.example · m-a"));
  assert.ok(!h.status.textContent.includes("A 连接成功") && !h.status.textContent.includes("B 旧一次测试"));
  assert.equal(tests.length, 0);
});

test("settings: a state GET issued before a save cannot roll back the confirmed mode, model, budget and key flag", async () => {
  const h = harness({ mode: "demo", endpoint: "https://a.example/v1", model: "", budget: 20, hasApiKey: false });
  const oldGet = deferred();
  h.apiQueue.push(oldGet);
  const poll = h.context.loadState();
  const confirmed = { mode: "api", endpoint: "https://a.example/v1", model: "flash-synthetic", budget: 40, hasApiKey: true };
  h.context.post = async (route, body) => { h.posts.push({ route, body }); return confirmed; };
  h.edit("mode", "api"); h.edit("model", "flash-synthetic"); h.edit("budget", "40"); h.edit("apiKey", "synthetic-key-C");
  h.apiQueue.push(stateFor(confirmed));
  const saving = h.context.saveSettings(h.form);
  await settle();
  oldGet.resolve(stateFor({ mode: "demo", endpoint: "https://a.example/v1", model: "", budget: 20, hasApiKey: false }));
  await poll;
  for (const [key, value] of Object.entries({ mode: "api", model: "flash-synthetic", budget: 40, hasApiKey: true })) assert.equal(h.context.state.settings[key], value);
  const result = await saving;
  assert.equal(result.refreshed, true); assert.equal(h.gets.length, 2);
  assert.equal(h.context.state.settings.mode, "api"); assert.equal(h.status.textContent, "配置已保存");
});

test("settings: POST success followed by a failed state refresh says saved-but-refresh-failed; API mode with empty model fails before POST", async () => {
  const h = harness(savedA);
  h.context.post = async (route, body) => { h.posts.push({ route, body }); return { ...savedA, model: "m9" }; };
  h.edit("model", "m9");
  const result = await h.context.saveSettings(h.form);
  assert.equal(result.refreshed, false); assert.equal(h.context.state.settings.model, "m9");
  assert.match(h.status.textContent, /已保存.*刷新工作台状态失败/); assert.equal(h.toasts.at(-1).isError, true);
  const empty = harness(savedA); empty.edit("mode", "api"); empty.edit("model", "  ");
  await assert.rejects(empty.context.saveSettings(empty.form), /请填写模型端点与模型名称/);
  assert.equal(empty.posts.length, 0); assert.equal(empty.context.settingsSaving, null);
});

test("settings: drafts and keys stay out of browser storage and the rendered key input has no value attribute", () => {
  assert.doesNotMatch(controller + declarations, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  const keyInput = source.match(/<input id="api-key"[^>]*>/)[0];
  assert.doesNotMatch(keyInput, /value=/);
});

// ---- Flash reasoning / length ----
const KEY = "sk-synthetic-flash-0000000000";
const okResponse = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const reply = (message, finish = "stop") => ({ choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
const call = (options, fetchImpl) => callCompletion({ endpoint: "http://127.0.0.1:9/v1", model: "flash-synthetic", key: KEY, allowTestLocal: true, fetchImpl, messages: [{ role: "user", content: "x" }], ...options });

test("flash: optional string reasoning_content is redacted and kept whole; null or missing is omitted; non-string is rejected; request limits are unchanged", async () => {
  const bodies = [];
  const long = "推理".repeat(5000) + KEY;
  const one = await call({ tools: [{ type: "function", function: { name: "knowledge_search", parameters: { type: "object" } } }] },
    async (_url, init) => { bodies.push(JSON.parse(init.body)); return okResponse(reply({ content: "ok", reasoning_content: long })); });
  assert.equal(one.message.reasoning_content.length, long.length - KEY.length + "[REDACTED]".length);
  assert.ok(!one.message.reasoning_content.includes(KEY));
  assert.equal(bodies[0].temperature, 0.3); assert.equal(bodies[0].max_tokens, 2400); assert.equal(bodies[0].parallel_tool_calls, false);
  for (const value of [null, undefined]) {
    const r = await call({}, async () => okResponse(reply({ content: "ok", ...(value === null ? { reasoning_content: null } : {}) })));
    assert.equal(Object.hasOwn(r.message, "reasoning_content"), false);
  }
  for (const bad of [42, { text: "x" }, ["x"], true]) {
    await assert.rejects(call({}, async () => okResponse(reply({ content: "ok", reasoning_content: bad }))), error => error.code === "MODEL_RESPONSE");
  }
});

test("flash: finish_reason=length stops before content or tool calls are accepted and is never retried", async () => {
  let requests = 0;
  await assert.rejects(call({}, async () => { requests++; return okResponse(reply({ content: "half", tool_calls: [{ id: "t1", type: "function", function: { name: "workspace_save", arguments: '{"name":"a.txt","content":"x"}' } }] }, "length")); }),
    error => error.code === "MODEL_OUTPUT_LENGTH");
  assert.equal(requests, 1);
});

const rawDatabase = dir => Buffer.concat(["agent.sqlite", "agent.sqlite-wal"].map(name => { try { return fs.readFileSync(path.join(dir, name)); } catch { return Buffer.alloc(0); } }));
const waitFor = async (predicate, label) => { for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("timeout: " + label); };
function knowledgeOnlyFixture(t, responder) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "luheng-flash-")); const dir = path.join(base, "data");
  const store = new Store(dir);
  store.put("settings", "main", { ...store.get("settings", "main"), mode: "api", endpoint: "https://synthetic.invalid/v1", model: "flash-synthetic", budget: 12 });
  store.put("agents", "kb-only", { id: "kb-only", name: "资料员", role: "只读资料", personality: "严谨", permissions: ["knowledge.read", "agent.delegate"], enabled: true });
  const requests = [];
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return okResponse(responder(body, requests.length)); };
  const engines = [];
  const boot = () => { const engine = new Engine(store, { async close() {}, async stop() {} }, { delay: 1, getKey: () => "", getSecrets: () => [KEY],
    completion: options => callCompletion({ ...options, key: KEY, endpoint: "http://127.0.0.1:9/v1", allowTestLocal: true, fetchImpl }) }); engines.push(engine); return engine; };
  t.after(async () => { for (const engine of engines) await engine.close().catch(() => {}); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { dir, store, requests, boot };
}
const SENTINEL_1 = "FLASH-REASONING-SENTINEL-ONE", SENTINEL_2 = "FLASH-REASONING-SENTINEL-TWO";

test("flash: knowledge-only role without local access returns reasoning across consecutive tool calls and keeps it out of SQLite/WAL, state, detail history and audit", async t => {
  const h = knowledgeOnlyFixture(t, (body, n) => n === 1
    ? reply({ content: null, reasoning_content: SENTINEL_1 + " key=" + KEY, tool_calls: [{ id: "k1", type: "function", function: { name: "knowledge_search", arguments: '{"query":""}' } }] }, "tool_calls")
    : reply({ content: "FINAL-SYNTHETIC-ANSWER", reasoning_content: SENTINEL_2 }));
  const engine = h.boot();
  const task = engine.create({ prompt: "合成知识任务", agentId: "kb-only" });
  assert.equal(task.localContext, false);
  await waitFor(() => ["completed", "failed"].includes(h.store.get("tasks", task.id)?.status) && !engine.running.has(task.id), "task end");
  const stored = h.store.get("tasks", task.id);
  assert.equal(stored.status, "completed", engine.task(task.id).error);
  assert.equal(stored.localContext, true); assert.equal(stored.privateReasoning, true);
  const echoed = h.requests[1].messages.find(m => m.role === "assistant" && m.tool_calls);
  assert.equal(echoed.reasoning_content, SENTINEL_1 + " key=[REDACTED]");
  assert.equal(h.requests[1].messages.filter(m => Object.hasOwn(m, "reasoning_content")).length, 1);
  assert.ok(h.requests.every(body => body.max_tokens === 2400 && body.temperature === 0.3 && body.parallel_tool_calls === false));
  const detail = engine.task(task.id);
  assert.match(detail.output, /FINAL-SYNTHETIC-ANSWER/); assert.deepEqual(detail.modelMessages, []);
  for (const sentinel of [SENTINEL_1, SENTINEL_2, KEY]) {
    assert.equal(JSON.stringify(h.store.all("tasks")).includes(sentinel), false, "aggregated task rows " + sentinel);
    assert.equal(JSON.stringify(h.store.all("audit")).includes(sentinel), false, "audit " + sentinel);
    assert.equal(JSON.stringify(detail).includes(sentinel), false, "detail " + sentinel);
    assert.equal(rawDatabase(h.dir).includes(Buffer.from(sentinel)), false, "raw SQLite/WAL " + sentinel);
  }
});

test("flash: finish_reason=length runs zero tools, makes no retry and does not raise budget", async t => {
  const h = knowledgeOnlyFixture(t, () => reply({ content: "half", reasoning_content: SENTINEL_1, tool_calls: [{ id: "w1", type: "function", function: { name: "workspace_save", arguments: '{"name":"a.txt","content":"x"}' } }] }, "length"));
  const engine = h.boot();
  const task = engine.create({ prompt: "合成长输出", agentId: "kb-only" });
  await waitFor(() => ["completed", "failed"].includes(h.store.get("tasks", task.id)?.status) && !engine.running.has(task.id), "task end");
  const live = engine.liveTask(task.id);
  assert.equal(live.status, "failed"); assert.match(live.error, /长度上限/);
  assert.equal(h.requests.length, 1); assert.equal(live.budget, 12); assert.equal(live.budgetUsed, 1);
  assert.deepEqual(live.executedToolIds, []); assert.equal((live.artifacts || []).length, 0);
  assert.equal((live.modelMessages || []).some(m => m.role === "assistant"), false);
  assert.equal(rawDatabase(h.dir).includes(Buffer.from(SENTINEL_1)), false);
});

test("flash: delegated reasoning never enters the main task", async t => {
  const h = knowledgeOnlyFixture(t, (body, n) => {
    if (String(body.messages[0].content).includes("受限只读子智能体")) return reply({ content: "DELEGATE-ANSWER", reasoning_content: "DELEGATE-REASONING-SENTINEL" });
    return n === 1 ? reply({ content: null, tool_calls: [{ id: "d1", type: "function", function: { name: "agent_delegate", arguments: '{"agentId":"researcher","instruction":"合成研究"}' } }] }, "tool_calls")
      : reply({ content: "MAIN-DONE" });
  });
  const engine = h.boot();
  const task = engine.create({ prompt: "合成委派", agentId: "kb-only" });
  await waitFor(() => ["completed", "failed"].includes(h.store.get("tasks", task.id)?.status) && !engine.running.has(task.id), "task end");
  const live = engine.liveTask(task.id);
  assert.equal(live.status, "completed", live.error);
  assert.equal(JSON.stringify(live.modelMessages).includes("DELEGATE-REASONING-SENTINEL"), false);
  assert.match(JSON.stringify(live.modelMessages), /DELEGATE-ANSWER/);
  assert.equal(h.requests.at(-1).messages.some(m => JSON.stringify(m).includes("DELEGATE-REASONING-SENTINEL")), false);
  assert.equal(rawDatabase(h.dir).includes(Buffer.from("DELEGATE-REASONING-SENTINEL")), false);
});

for (const outcome of ["sent", "unknown"]) {
  test(`flash: a reasoning task interrupted after mail ${outcome} restarts safely, keeps the fact and never replays across repeated restarts`, async t => {
    const h = knowledgeOnlyFixture(t, (body, n) => n === 1
      ? reply({ content: null, reasoning_content: SENTINEL_1, tool_calls: [{ id: "k1", type: "function", function: { name: "knowledge_search", arguments: '{"query":""}' } }] }, "tool_calls")
      : reply({ content: "DONE", reasoning_content: SENTINEL_2 }));
    const engine = h.boot();
    const task = engine.create({ prompt: "合成邮件任务", agentId: "kb-only" });
    await waitFor(() => h.store.get("tasks", task.id)?.status === "completed" && !engine.running.has(task.id), "task end");
    await engine.close();
    // Simulate a crash after the mail service recorded a send outcome.
    h.store.put("tasks", task.id, { ...h.store.get("tasks", task.id), status: "running", mailDraftId: "draft-1" });
    h.store.put("mail_outbox", "draft-1", { id: "draft-1", taskId: task.id, status: outcome });
    h.store.put("mail_approvals", "ma-1", { id: "ma-1", taskId: task.id, draftId: "draft-1", status: "approved" });
    h.store.put("approvals", "ap-1", { id: "ap-1", taskId: task.id, type: "mail.send", serviceApprovalId: "ma-1", status: "approved" });
    const snapshot = () => { const x = h.store.get("tasks", task.id); return { status: x.status, mailOutcome: x.mailOutcome, codes: x.recoveryOutcomeCodes, privateReasoning: x.privateReasoning, central: h.store.get("approvals", "ap-1").status, service: h.store.get("mail_approvals", "ma-1").status }; };
    const first = (h.boot(), snapshot());
    const second = (h.boot(), snapshot());
    assert.deepEqual(first, second);
    assert.equal(first.status, "needs_attention"); assert.equal(first.mailOutcome, outcome); assert.equal(first.privateReasoning, true);
    assert.deepEqual(first.codes, ["LOCAL_CONTEXT_INTERRUPTED", outcome === "sent" ? "MAIL_ACCEPTED_BY_SMTP" : "MAIL_DELIVERY_UNKNOWN"]);
    assert.equal(first.central, outcome === "sent" ? "completed" : "unknown"); assert.notEqual(first.service, "approved");
    for (const sentinel of [SENTINEL_1, SENTINEL_2]) assert.equal(rawDatabase(h.dir).includes(Buffer.from(sentinel)), false);
  });
}

test("flash: authenticated /api/state and task detail never return reasoning for a knowledge-only task", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "luheng-flash-api-")); const dir = path.join(base, "data");
  let n = 0;
  const fetchImpl = async () => okResponse(++n === 1
    ? reply({ content: null, reasoning_content: SENTINEL_1, tool_calls: [{ id: "k1", type: "function", function: { name: "knowledge_search", arguments: '{"query":""}' } }] }, "tool_calls")
    : reply({ content: "API-FINAL", reasoning_content: SENTINEL_2 }));
  const app = await startServer({ port: 0, dataDir: dir, stepDelay: 1, scheduleOptions: { startTimer: false },
    completion: options => callCompletion({ ...options, key: KEY, endpoint: "http://127.0.0.1:9/v1", allowTestLocal: true, fetchImpl }) });
  t.after(async () => { await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  app.store.put("settings", "main", { ...app.store.get("settings", "main"), mode: "api", endpoint: "https://synthetic.invalid/v1", model: "flash-synthetic" });
  app.store.put("agents", "kb-only", { id: "kb-only", name: "资料员", role: "只读资料", personality: "严谨", permissions: ["knowledge.read"], enabled: true });
  const cookie = (await fetch(app.url + "/")).headers.get("set-cookie").split(";")[0];
  const headers = { cookie, origin: app.url, "content-type": "application/json" };
  const created = await (await fetch(app.url + "/api/tasks", { method: "POST", headers, body: JSON.stringify({ prompt: "合成接口任务", agentId: "kb-only" }) })).json();
  await waitFor(() => app.store.get("tasks", created.id)?.status === "completed", "api task");
  const state = await (await fetch(app.url + "/api/state", { headers })).text();
  const detail = await (await fetch(app.url + "/api/tasks/" + created.id, { headers })).text();
  assert.match(detail, /API-FINAL/);
  for (const sentinel of [SENTINEL_1, SENTINEL_2]) {
    assert.equal(state.includes(sentinel), false); assert.equal(detail.includes(sentinel), false);
    assert.equal(rawDatabase(dir).includes(Buffer.from(sentinel)), false);
  }
});
