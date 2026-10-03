import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { startServer } from "../server.mjs";
import { Store, permissions } from "../lib/store.mjs";
import { parseTool } from "../lib/agent-tools.mjs";
import { FULL_ACCESS_CONFIRMATION } from "../lib/local-access.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (name, args, id = "local-call") => ({ id, type: "function",
  function: { name, arguments: JSON.stringify(args) } });
const toolResponse = (...calls) => ({ message: { role: "assistant", content: null, tool_calls: calls } });
const textResponse = content => ({ message: { role: "assistant", content } });
async function client(completion, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "luheng-local-integration-"));
  const files = join(root, "files"), dataDir = join(root, "data");
  await mkdir(files);
  const c = { root, files, dataDir, completion, options };
  c.restart = async () => {
    if (c.app) await c.app.close();
    c.app = await startServer({ port: 0, dataDir, completion, stepDelay: 1, ...options });
    const page = await fetch(c.app.url);
    c.cookie = page.headers.get("set-cookie").split(";")[0];
    c.app.store.put("settings", "main", { ...c.app.store.get("settings", "main"),
      mode: "api", model: "local-protocol-fixture", budget: 60 });
  };
  c.api = async (path, body, headers = {}) => {
    const response = await fetch(c.app.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: c.cookie, origin: c.app.url, "content-type": "application/json",
        ...(options.desktopToken ? { "x-highway-desktop-token": options.desktopToken } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  c.configure = mode => c.api("/api/local-access/configure", { mode, roots: [files],
    allFiles: false, onboardingComplete: true });
  c.close = async () => { await c.app.close(); await rm(root, { recursive: true, force: true }); };
  await c.restart();
  return c;
}
async function settled(c, taskId) {
  for (let index = 0; index < 500; index++) {
    const task = (await c.api("/api/tasks/" + taskId)).data;
    if (["completed", "failed", "cancelled", "rejected", "awaiting_approval", "needs_attention"].includes(task.status)
      && !c.app.engine.running.has(taskId)) return task;
    await wait(10);
  }
  throw new Error("Local fixture task did not settle");
}
const sqlitePayloads = c => c.app.store.db.prepare("SELECT payload FROM records").all().map(row => row.payload).join("\n");
const zipPart = (bytes, name) => {
  let cursor = 0;
  while (bytes.readUInt32LE(cursor) === 0x04034b50) {
    const length = bytes.readUInt32LE(cursor + 18), nameLength = bytes.readUInt16LE(cursor + 26);
    const start = cursor + 30 + nameLength + bytes.readUInt16LE(cursor + 28);
    if (bytes.subarray(cursor + 30, cursor + 30 + nameLength).toString() === name)
      return inflateRawSync(bytes.subarray(start, start + length)).toString("utf8");
    cursor = start + length;
  }
  throw new Error("Requested ZIP part missing");
};
const proposedWrite = async c => {
  const task = (await c.api("/api/tasks", { prompt: "将请求的文字保存到授权目录", budget: 60 })).data;
  assert.equal((await settled(c, task.id)).status, "awaiting_approval");
  const operation = (await c.api("/api/local-access/state")).data.pending.find(op => op.taskId === task.id);
  assert.ok(operation);
  return { task, operation };
};

test("local tools reject injected approval, scope and mode parameters", () => {
  for (const input of [
    { path: "/tmp/test", content: "text", userApproval: true },
    { path: "/tmp/test", content: "text", mode: "full" },
    { path: "/tmp/test", content: "text", taskId: "another-task" },
  ]) assert.throws(() => parseTool(call("local_write_file", input)), /未获允许/);
  assert.throws(() => parseTool(call("local_run_command", {
    executable: process.execPath, args: "-e", cwd: "/tmp",
  })), /数组/);
  assert.throws(() => parseTool(call("local_run_command", {
    executable: process.execPath, args: [], cwd: "/tmp", timeoutMs: "1000",
  })), /类型/);
  assert.equal(parseTool(call("local_write_file", { path: "/tmp/test", content: "" })).content, "");
});

test("local permission migration preserves custom, edited and disabled roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luheng-local-migration-"));
  let store = new Store(dir);
  try {
    assert.ok(store.get("agents", "coordinator").permissions.includes("commands.run"));
    for (const id of ["researcher", "writer"])
      assert.equal(store.get("agents", id).permissions.includes("commands.run"), false);
    const old = permissions.filter(p => !["files.read", "files.write", "commands.run"].includes(p));
    store.put("agents", "coordinator", { ...store.get("agents", "coordinator"), permissions: old });
    store.put("agents", "researcher", { ...store.get("agents", "researcher"), permissions: ["knowledge.read"] });
    store.put("agents", "writer", { ...store.get("agents", "writer"), enabled: false,
      permissions: ["knowledge.read", "workspace.write", "mail.draft"] });
    store.put("agents", "custom", { ...store.get("agents", "coordinator"), id: "custom", permissions: old });
    store.db.exec("DELETE FROM migrations WHERE version=4");
    store.close(); store = new Store(dir);
    assert.ok(store.get("agents", "coordinator").permissions.includes("commands.run"));
    assert.deepEqual(store.get("agents", "researcher").permissions, ["knowledge.read"]);
    assert.equal(store.get("agents", "writer").permissions.includes("files.write"), false);
    assert.deepEqual(store.get("agents", "custom").permissions, old);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("local API retains same-origin, session and desktop-token checks and strict bodies", async () => {
  const c = await client(async () => textResponse("fixture"), { desktopToken: "test-local-desktop-token" });
  try {
    assert.equal((await c.api("/api/local-access/state", undefined, { cookie: "" })).status, 401);
    assert.equal((await c.api("/api/local-access/state", undefined, { "x-highway-desktop-token": "wrong" })).status, 401);
    assert.equal((await c.api("/api/local-access/revoke", {}, { origin: "https://other.example" })).status, 403);
    for (const invalid of [null, [], "text", { kind: "read", path: c.files, taskId: "injected" }])
      assert.equal((await c.api("/api/local-access/operations", invalid)).status, 400);
    assert.equal((await c.api("/api/local-access/operations", { kind: "list", path: c.files })).status, 400);
    assert.equal((await c.configure("read_only")).status, 200);
    assert.equal((await c.api("/api/state")).data.localAccess.mode, "read_only");
    await writeFile(join(c.files, "readable.txt"), "fixture data");
    const listing = await c.api("/api/local-access/operations", { kind: "list", path: c.files });
    assert.equal(listing.status, 201);
    assert.equal(listing.data.result.entries[0].name, "readable.txt");
    const read = await c.api("/api/local-access/operations", { kind: "read", path: join(c.files, "readable.txt") });
    assert.equal(read.data.result.content, "fixture data");
    assert.equal((await c.api("/api/local-access/operations", { kind: "write", path: join(c.files, "no.txt"), content: "denied" })).status, 400);
    assert.equal((await c.api("/api/local-access/operations", { kind: "command", executable: process.execPath,
      args: ["-e", "process.stdout.write('denied')"], cwd: c.files })).status, 400);
  } finally { await c.close(); }
});

test("model local tools require both global authorization and current role permission", async () => {
  let target;
  const c = await client(async () => toolResponse(call("local_read_file", { path: target })));
  try {
    target = join(c.files, "source.txt"); await writeFile(target, "source");
    const first = (await c.api("/api/tasks", { prompt: "read fixture" })).data;
    assert.match((await settled(c, first.id)).error, /本机访问权限/);
    assert.equal(c.app.localAccess.state().operations.length, 0);
    await c.configure("read_only");
    const agent = c.app.store.get("agents", "coordinator");
    c.app.store.put("agents", agent.id, { ...agent, permissions: agent.permissions.filter(p => p !== "files.read") });
    const second = (await c.api("/api/tasks", { prompt: "role-denied read" })).data;
    assert.match((await settled(c, second.id)).error, /files.read/);
    assert.equal(c.app.localAccess.state().operations.length, 0);
  } finally { await c.close(); }
});

test("task-bound exact write is approved once, resumes the model and keeps payloads out of SQLite", async () => {
  const marker = "LOCAL_WRITE_EXACT_EPHEMERAL_731";
  let path, calls = 0;
  const c = await client(async ({ messages }) => {
    calls++;
    if (calls === 1) return toolResponse(call("local_write_file", { path, content: marker }, "write-exact"));
    const result = JSON.parse(messages.at(-1).content);
    assert.equal(messages.at(-1).tool_call_id, "write-exact");
    assert.equal(result.result.written, true);
    return textResponse("已保存：" + marker);
  });
  try {
    path = join(c.files, "exact.txt"); await c.configure("confirm");
    const { task, operation } = await proposedWrite(c);
    assert.equal(operation.snapshot.content, marker);
    assert.equal(operation.snapshot.path, path);
    await assert.rejects(access(path));
    assert.equal(sqlitePayloads(c).includes(marker), false);
    const endpoint = `/api/local-access/operations/${operation.id}/approve`;
    assert.equal((await c.api(endpoint, { content: "tampered" })).status, 400);
    assert.equal((await c.api(endpoint, { digest: "wrong" })).status, 400);
    const central = c.app.store.all("approvals").find(a => a.localOperationId === operation.id);
    assert.equal((await c.api(`/api/approvals/${central.id}`, { decision: "approve", path: "/tmp/tamper" })).status, 400);
    const responses = await Promise.all([c.api(endpoint, { digest: operation.digest }), c.api(endpoint, { digest: operation.digest })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
    assert.equal(await readFile(path, "utf8"), marker);
    assert.equal(calls, 2);
    const result = await settled(c, task.id);
    assert.equal(result.status, "completed", result.error);
    assert.match(result.output, new RegExp(marker));
    assert.equal(sqlitePayloads(c).includes(marker), false);
    assert.equal(c.app.store.get("tasks", task.id).modelMessages.length, 0);
    assert.equal(c.app.store.get("approvals", central.id).status, "completed");
    const exported = await c.api(`/api/tasks/${task.id}/export`, { format: "docx" });
    assert.equal(exported.status, 201);
    const document = await readFile(join(c.dataDir, "artifacts", exported.data.filename));
    assert.equal(zipPart(document, "word/document.xml").includes(marker), true, "explicit export uses the live result");
    assert.equal(sqlitePayloads(c).includes(marker), false, "export metadata does not repersist local output");
  } finally { await c.close(); }
});

test("task rejection, cancellation and revocation never execute pending writes", async () => {
  for (const decision of ["reject", "cancel", "revoke"]) {
    let path;
    const c = await client(async () => toolResponse(call("local_write_file", { path, content: "must not execute" })));
    try {
      path = join(c.files, "blocked.txt"); await c.configure("confirm");
      const { task, operation } = await proposedWrite(c);
      const response = decision === "revoke" ? await c.api("/api/local-access/revoke", {})
        : await c.api(`/api/local-access/operations/${operation.id}/${decision}`, {});
      assert.equal(response.status, 200);
      await assert.rejects(access(path));
      assert.equal((await settled(c, task.id)).status,
        decision === "reject" ? "rejected" : decision === "cancel" ? "cancelled" : "needs_attention");
      assert.equal((await c.api(`/api/local-access/operations/${operation.id}/approve`, {})).status, 400);
      assert.equal(c.app.localAccess.state().pending.length, 0);
    } finally { await c.close(); }
  }
});

test("approval rechecks role access and exact task-call binding before side effects", async () => {
  for (const change of ["role", "task", "call"]) {
    let path;
    const c = await client(async () => toolResponse(call("local_write_file", { path, content: "no mutation" }, "bound-call")));
    try {
      path = join(c.files, "role.txt"); await c.configure("confirm");
      const { task, operation } = await proposedWrite(c);
      if (change === "role") {
        const role = c.app.store.get("agents", "coordinator");
        c.app.store.put("agents", role.id, { ...role, permissions: role.permissions.filter(p => p !== "files.write") });
      } else if (change === "task") {
        const central = c.app.store.all("approvals").find(a => a.localOperationId === operation.id);
        c.app.store.put("approvals", central.id, { ...central, taskId: "another-task" });
      } else c.app.engine.localTasks.get(task.id).toolQueue[0].function.arguments = JSON.stringify({ path, content: "changed" });
      const response = await c.api(`/api/local-access/operations/${operation.id}/approve`, {});
      if (change === "role") assert.notEqual(response.data.task?.status, "completed");
      else assert.equal(response.status, 400);
      await assert.rejects(access(path));
      assert.equal((await c.api("/api/local-access/state")).data.operations[0].status === "completed", false);
    } finally { await c.close(); }
  }
});

test("approved command is direct host execution, resumes correctly and does not persist output", async () => {
  const marker = "LOCAL_COMMAND_OUTPUT_EPHEMERAL_849 & literal";
  let cwd, rounds = 0;
  const c = await client(async ({ messages }) => {
    if (++rounds === 1) return toolResponse(call("local_run_command", { executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", marker], cwd, timeoutMs: 3000 }, "run-command"));
    const response = JSON.parse(messages.at(-1).content);
    assert.equal(messages.at(-1).tool_call_id, "run-command");
    assert.equal(response.result.stdout, marker);
    assert.equal(response.result.exitCode, 0);
    assert.equal(response.result.executionBoundary, "host_process_no_os_sandbox");
    return textResponse(response.result.stdout);
  });
  try {
    cwd = c.files; await c.configure("confirm");
    const task = (await c.api("/api/tasks", { prompt: "运行获准的测试进程" })).data;
    assert.equal((await settled(c, task.id)).status, "awaiting_approval");
    const op = c.app.localAccess.state().pending[0];
    assert.equal(op.snapshot.args[2], marker);
    assert.match(op.summary, /不受文件夹范围隔离/);
    const decision = await c.api(`/api/local-access/operations/${op.id}/approve`, { digest: op.digest });
    assert.equal(decision.data.task.status, "completed", decision.data.task.error);
    assert.equal(rounds, 2);
    assert.equal(sqlitePayloads(c).includes(marker), false);
  } finally { await c.close(); }
});

test("cancelling an executing command stops subsequent model calls and reports possible effects", async () => {
  let cwd, rounds = 0;
  const c = await client(async () => {
    rounds++;
    return toolResponse(call("local_run_command", { executable: process.execPath,
      args: ["-e", "setTimeout(() => process.stdout.write('too late'), 15000)"], cwd, timeoutMs: 20000 }));
  });
  try {
    cwd = c.files; await c.configure("confirm");
    const task = (await c.api("/api/tasks", { prompt: "执行并取消测试进程" })).data;
    await settled(c, task.id);
    const op = c.app.localAccess.state().pending[0];
    const approval = c.api(`/api/local-access/operations/${op.id}/approve`, {});
    for (let index = 0; index < 100 && !c.app.localAccess.running.has(op.id); index++) await wait(5);
    assert.equal(c.app.localAccess.running.has(op.id), true);
    assert.equal((await c.api(`/api/tasks/${task.id}/cancel`, {})).status, 200);
    await approval;
    const result = await settled(c, task.id);
    assert.equal(result.status, "needs_attention");
    assert.match(result.error, /撤回|副作用|核实/);
    assert.equal(rounds, 1);
    assert.equal(c.app.localAccess.running.size, 0);
  } finally { await c.close(); }
});

test("restart invalidates pending local task approvals without replay and full mode downgrades", async () => {
  let path, rounds = 0;
  const c = await client(async () => { rounds++; return toolResponse(call("local_write_file", { path, content: "restart exact payload" })); });
  try {
    path = join(c.files, "restart.txt"); await c.configure("confirm");
    const { task, operation } = await proposedWrite(c);
    const central = c.app.store.all("approvals").find(a => a.localOperationId === operation.id);
    await c.restart();
    const recovered = await settled(c, task.id);
    assert.equal(recovered.status, "needs_attention");
    assert.match(recovered.error, /重放|失效|中断/);
    assert.equal((await c.api(`/api/approvals/${central.id}`, { decision: "approve" })).status, 400);
    assert.equal((await c.api(`/api/local-access/operations/${operation.id}/approve`, {})).status, 400);
    await assert.rejects(access(path));
    assert.equal(rounds, 1);
    const request = await c.api("/api/local-access/full-access-request", { roots: [c.files], allFiles: false });
    assert.equal((await c.api("/api/local-access/configure", { mode: "full", roots: [c.files], allFiles: false,
      onboardingComplete: true, challenge: request.data.challenge, confirmation: FULL_ACCESS_CONFIRMATION })).status, 200);
    assert.equal((await c.api("/api/local-access/state")).data.mode, "full");
    await c.restart();
    assert.equal((await c.api("/api/local-access/state")).data.mode, "confirm");
  } finally { await c.close(); }
});

test("full authorization runs a model file action immediately without creating an approval", async () => {
  let path, rounds = 0;
  const c = await client(async () => ++rounds === 1
    ? toolResponse(call("local_write_file", { path, content: "full-authorized text" }))
    : textResponse("已完成获准写入"));
  try {
    path = join(c.files, "full.txt");
    const request = await c.api("/api/local-access/full-access-request", { roots: [c.files], allFiles: false });
    const configured = await c.api("/api/local-access/configure", { mode: "full", roots: [c.files], allFiles: false,
      challenge: request.data.challenge, confirmation: FULL_ACCESS_CONFIRMATION, onboardingComplete: true });
    assert.equal(configured.status, 200);
    const task = (await c.api("/api/tasks", { prompt: "按完全访问授权执行测试文件写入" })).data;
    assert.equal((await settled(c, task.id)).status, "completed");
    assert.equal(await readFile(path, "utf8"), "full-authorized text");
    assert.equal(c.app.store.all("approvals").length, 0);
    assert.equal(rounds, 2);
  } finally { await c.close(); }
});

test("desktop folder selection returns native paths without granting access", async () => {
  let selected;
  const c = await client(async () => textResponse("fixture"), { desktopBridge: {
    async selectFolders() { return { cancelled: false, paths: [selected] }; },
  } });
  try {
    selected = c.files;
    assert.equal((await c.api("/api/local-access/state")).data.pickerAvailable, true);
    const response = await c.api("/api/local-access/select-folders", {});
    assert.deepEqual(response.data.paths, [c.files]);
    assert.equal((await c.api("/api/local-access/state")).data.mode, "disabled");
    assert.equal((await c.api("/api/local-access/select-folders", { mode: "full" })).status, 400);
  } finally { await c.close(); }
  const web = await client(async () => textResponse("fixture"));
  try {
    assert.equal((await web.api("/api/local-access/state")).data.pickerAvailable, false);
    assert.match((await web.api("/api/local-access/select-folders", {})).data.error, /手动填写/);
  } finally { await web.close(); }
});

test("nonzero approved command exit is returned as failed evidence to the model", async () => {
  let cwd, rounds = 0;
  const c = await client(async ({ messages }) => {
    if (++rounds === 1) return toolResponse(call("local_run_command", { executable: process.execPath,
      args: ["-e", "process.stderr.write('fixture failure'); process.exit(7)"], cwd, timeoutMs: 3000 }));
    const result = JSON.parse(messages.at(-1).content);
    assert.equal(result.operation.status, "failed");
    assert.equal(result.result.exitCode, 7);
    assert.equal(result.result.stderr, "fixture failure");
    return textResponse("测试命令退出码7，执行未成功");
  });
  try {
    cwd = c.files; await c.configure("confirm");
    const task = (await c.api("/api/tasks", { prompt: "检验进程失败的退出码" })).data;
    await settled(c, task.id);
    const op = c.app.localAccess.state().pending[0];
    const response = await c.api(`/api/local-access/operations/${op.id}/approve`, {});
    assert.equal(response.data.task.status, "completed");
    assert.match(response.data.task.output, /未成功/);
    assert.equal(c.app.store.all("approvals")[0].status, "failed");
    assert.equal(rounds, 2);
  } finally { await c.close(); }
});

test("local file content cannot flow into another role through delegation or persisted provider errors", async () => {
  for (const following of ["delegate", "error"]) {
    let path, rounds = 0;
    const marker = "LOCAL_READ_CONTEXT_PRIVATE_921";
    const c = await client(async ({ messages }) => {
      if (++rounds === 1) return toolResponse(call("local_read_file", { path }, "private-local-read"));
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.result.content, marker);
      if (following === "error") throw new Error("provider echoed " + result.result.content);
      return toolResponse(call("agent_delegate", { agentId: "researcher", instruction: result.result.content }, "no-local-delegate"));
    });
    try {
      path = join(c.files, "private-context.txt"); await writeFile(path, marker); await c.configure("read_only");
      const task = (await c.api("/api/tasks", { prompt: "读取任务所需的授权文件" })).data;
      const result = await settled(c, task.id);
      assert.equal(result.status, "failed");
      assert.match(result.error, following === "delegate" ? /禁止.*转交/ : /provider echoed/);
      assert.equal(sqlitePayloads(c).includes(marker), false);
      assert.equal(rounds, 2);
    } finally { await c.close(); }
  }
});

test("task input redacts current global and role credentials before saving or sending to a model", async () => {
  const globalSecret = "FAKE_GLOBAL_TASK_INPUT_SECRET_71", roleSecret = "FAKE_ROLE_TASK_INPUT_SECRET_72";
  const c = await client(async ({ messages }) => {
    const sent = JSON.stringify(messages);
    assert.equal(sent.includes(globalSecret), false);
    assert.equal(sent.includes(roleSecret), false);
    assert.match(messages.at(-1).content, /REDACTED/);
    return textResponse("已完成输入脱敏验证");
  });
  try {
    const configured = await c.api("/api/settings", { mode: "demo", endpoint: "https://api.openai.com/v1",
      model: "local-protocol-fixture", apiKey: globalSecret, budget: 60 });
    assert.equal(configured.status, 200);
    const existingSecrets = c.app.engine.getSecrets;
    c.app.engine.getSecrets = () => [...existingSecrets(), roleSecret];
    c.app.store.put("settings", "main", { ...c.app.store.get("settings", "main"), mode: "api" });
    const task = (await c.api("/api/tasks", { prompt: `${globalSecret} ${roleSecret} 检验脱敏` })).data;
    assert.equal((await settled(c, task.id)).status, "completed");
    const saved = c.app.store.get("tasks", task.id);
    assert.equal(saved.prompt.includes(globalSecret), false);
    assert.equal(saved.title.includes(roleSecret), false);
    assert.equal(sqlitePayloads(c).includes(globalSecret), false);
    assert.equal(sqlitePayloads(c).includes(roleSecret), false);
  } finally { await c.close(); }
});

test("integrated: memory-first prompt and budget summary never enter SQLite, WAL, audit or aggregate state", async () => {
  const promptMarker = "LOCAL_PROMPT_MEMORY_FIRST_0F6", fileMarker = "LOCAL_READ_BUDGET_SENTINEL_3C9";
  const usageMarker = "PROVIDER_USAGE_EXTENSION_SECRET_6D4";
  let path, calls = 0;
  const c = await client(async () => {
    calls++;
    return { ...toolResponse(call("local_read_file", { path }, "read-budget")),
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10,
        arbitrary_provider_field: fileMarker, details: usageMarker } };
  });
  try {
    path = join(c.files, "budget-source.txt"); await writeFile(path, fileMarker);
    await c.configure("read_only");
    const task = (await c.api("/api/tasks", { prompt: promptMarker, budget: 2 })).data;
    assert.equal(c.app.store.get("tasks", task.id).prompt.includes(promptMarker), false, "first save is already sanitized");
    const detail = await settled(c, task.id);
    assert.equal(detail.status, "failed"); assert.equal(calls, 1);
    assert.equal(detail.completionSummary.version, 2);
    assert.deepEqual(detail.completionSummary.completed, ["read-budget"]);
    assert.match(detail.output, new RegExp(fileMarker));
    assert.match(detail.prompt, new RegExp(promptMarker));
    const aggregate = (await c.api("/api/state")).data;
    for (const marker of [promptMarker, fileMarker, usageMarker]) {
      assert.equal(JSON.stringify(aggregate).includes(marker), false, "aggregate state omits private values");
      assert.equal(sqlitePayloads(c).includes(marker), false);
      assert.equal(JSON.stringify(c.app.store.all("audit")).includes(marker), false);
      for (const name of ["agent.sqlite", "agent.sqlite-wal"])
        assert.equal((await readFile(join(c.dataDir, name))).includes(Buffer.from(marker)), false, name);
    }
    const saved = c.app.store.get("tasks", task.id);
    assert.equal(saved.completionSummary, undefined);
    assert.deepEqual(saved.modelUsageCalls[0].usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    const live = c.app.engine.liveTask(task.id);
    live.futureSensitiveField = fileMarker; c.app.engine.save(live);
    assert.equal(c.app.store.get("tasks", task.id).futureSensitiveField, undefined, "new fields are denied by default");
    await c.restart();
    const restarted = (await c.api("/api/tasks/" + task.id)).data;
    assert.equal(JSON.stringify(restarted).includes(fileMarker), false);
    assert.match(restarted.prompt, /内存|重新发起/);
  } finally { await c.close(); }
});

test("integrated: pending local proposal pauses before finishTool and resumes only after exact approval", async () => {
  const marker = "LOCAL_PENDING_EXACT_BODY_884";
  let path, calls = 0;
  const c = await client(async ({ messages }) => {
    calls++;
    if (calls === 1) return toolResponse(call("local_write_file", { path, content: marker }, "pending-write"));
    assert.equal(messages.at(-1).tool_call_id, "pending-write");
    assert.equal(JSON.parse(messages.at(-1).content).result.written, true);
    return textResponse("Approved write complete");
  });
  try {
    path = join(c.files, "pending-write.txt"); await c.configure("confirm");
    const { task, operation } = await proposedWrite(c);
    const live = c.app.engine.liveTask(task.id);
    assert.equal(calls, 1); assert.deepEqual(live.executedToolIds, []);
    assert.equal(live.toolQueue[0].id, "pending-write");
    assert.equal(live.modelMessages.some(message => message.role === "tool"), false);
    assert.equal(JSON.stringify((await c.api("/api/state")).data).includes(marker), false);
    assert.equal((await c.api("/api/local-access/state")).data.pending[0].snapshot.content, marker);
    assert.equal((await c.api(`/api/local-access/operations/${operation.id}/approve`, { digest: operation.digest })).status, 200);
    assert.equal((await settled(c, task.id)).status, "completed");
    assert.equal(calls, 2); assert.equal(await readFile(path, "utf8"), marker);
    assert.deepEqual(c.app.engine.liveTask(task.id).executedToolIds, ["pending-write"]);
  } finally { await c.close(); }
});

test("integrated: nonzero local command exit is incomplete in budget summary and retains side-effect warning", async () => {
  const marker = "LOCAL_FAILED_COMMAND_OUTPUT_998";
  let cwd, calls = 0;
  const c = await client(async () => { calls++; return toolResponse(call("local_run_command", {
    executable: process.execPath, args: ["-e", `process.stdout.write('${marker}');process.exitCode=7`], cwd,
  }, "failed-command")); });
  try {
    cwd = c.files; await c.configure("confirm");
    const task = (await c.api("/api/tasks", { prompt: "Run the controlled synthetic process", budget: 3 })).data;
    assert.equal((await settled(c, task.id)).status, "awaiting_approval");
    const op = c.app.localAccess.state().pending[0];
    await c.api(`/api/local-access/operations/${op.id}/approve`, { digest: op.digest });
    const detail = await settled(c, task.id);
    assert.equal(calls, 1); assert.equal(detail.status, "needs_attention");
    assert.deepEqual(detail.completionSummary.completed, []);
    assert.deepEqual(detail.completionSummary.incomplete, ["failed-command"]);
    assert.equal(detail.completionSummary.recorded[0].success, false);
    assert.equal(detail.completionSummary.recorded[0].status, "failed");
    assert.match(detail.error, /人工核实|自动重试/);
    assert.equal(JSON.stringify((await c.api("/api/state")).data).includes(marker), false);
    assert.equal(sqlitePayloads(c).includes(marker), false);
  } finally { await c.close(); }
});

test("integrated: multiple artifacts remain registered, authenticated and bound to an enabled owner", async () => {
  const c = await client(async () => toolResponse(
    call("workspace_save", { name: "first", content: "first artifact" }, "file-a"),
    call("workspace_save", { name: "second", content: "second artifact" }, "file-b")));
  try {
    const task = (await c.api("/api/tasks", { prompt: "Save two synthetic outputs", budget: 3 })).data;
    const detail = await settled(c, task.id);
    assert.equal(detail.status, "failed"); assert.equal(detail.artifacts.length, 2);
    for (const [index, artifact] of detail.artifacts.entries()) {
      const response = await fetch(c.app.url + artifact.url, { headers: { cookie: c.cookie } });
      assert.equal(response.status, 200); assert.equal(await response.text(), index ? "second artifact" : "first artifact");
      assert.equal((await fetch(c.app.url + artifact.url)).status, 401);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal((await c.api(`/api/tasks/${task.id}/export`, { format: "docx" })).status, 400);
    const owner = c.app.store.get("agents", detail.agentId);
    c.app.store.put("agents", owner.id, { ...owner, enabled: false });
    for (const artifact of detail.artifacts)
      assert.equal((await fetch(c.app.url + artifact.url, { headers: { cookie: c.cookie } })).status, 403);
    c.app.store.put("agents", owner.id, { ...owner, permissions: owner.permissions.filter(permission => permission !== "workspace.write") });
    assert.equal((await fetch(c.app.url + detail.artifact.url, { headers: { cookie: c.cookie } })).status, 403);
  } finally { await c.close(); }
});

test("integrated: restart preserves existing Office export size and hash but cannot export an erased local result", async () => {
  const marker = "EXPLICIT_LOCAL_EXPORT_MEMORY_CONTENT_946";
  const c = await client(async () => textResponse(marker));
  try {
    const task = (await c.api("/api/tasks", { prompt: "Make a synthetic result for explicit export" })).data;
    assert.equal((await settled(c, task.id)).status, "completed");
    const exported = await c.api(`/api/tasks/${task.id}/export`, { format: "docx" });
    assert.equal(exported.status, 201); assert.ok(exported.data.size > 0);
    assert.match(exported.data.sha256, /^[0-9a-f]{64}$/);
    assert.equal(c.app.store.get("tasks", task.id).exports[0].size, exported.data.size);
    await c.restart();
    const repeated = await c.api(`/api/tasks/${task.id}/export`, { format: "docx" });
    assert.equal(repeated.status, 200); assert.equal(repeated.data.size, exported.data.size);
    assert.equal(repeated.data.sha256, exported.data.sha256); assert.equal(repeated.data.filename, exported.data.filename);
    assert.equal((await c.api(`/api/tasks/${task.id}/export`, { format: "xlsx" })).status, 400);
    assert.equal(sqlitePayloads(c).includes(marker), false);
  } finally { await c.close(); }
});

test("integrated: restart invalidates all linked approvals when local-capable task context was memory-only", async () => {
  const c = await client(async () => textResponse("unused"));
  try {
    const task = c.app.engine.create({ prompt: "Synthetic pending cross-tool approval" });
    task.status = "awaiting_approval"; c.app.engine.save(task);
    for (const type of ["local.write", "browser.actions", "mail.send"])
      c.app.store.put("approvals", type, { id: type, taskId: task.id, type, status: "pending" });
    await c.restart();
    assert.equal((await c.api("/api/tasks/" + task.id)).data.status, "needs_attention");
    assert.equal(c.app.store.all("approvals").filter(approval => approval.taskId === task.id && approval.status === "pending").length, 0);
  } finally { await c.close(); }
});
