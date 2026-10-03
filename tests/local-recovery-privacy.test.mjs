import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../lib/store.mjs";
import { Engine } from "../lib/engine.mjs";
import { LocalAccessService } from "../lib/local-access.mjs";
import { MailService } from "../lib/mail-adapter.mjs";
import { ControlledBrowserService } from "../lib/controlled-browser.mjs";
const rawHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "local-recovery-private-"));
  const dir = join(root, "data"), files = join(root, "files"); await mkdir(files);
  const store = new Store(dir), local = new LocalAccessService(store), engines = [];
  const engine = () => {
    const value = new Engine(store, { close: async () => {} }, { localAccess: local,
      completion: async () => { throw new Error("Synthetic test must not call an external model"); } });
    value.pump = () => {}; engines.push(value); return value;
  };
  t.after(async () => { for (const value of engines) await value.close(); await local.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dir, files, store, local, engine };
}

for (const sourceStatus of ["sent", "unknown", "sending"]) test(`recovery keeps actual SMTP ${sourceStatus} outcome and a safe no-resend warning across repeated restarts`, async t => {
  const h = await fixture(t), status = sourceStatus === "sending" ? "unknown" : sourceStatus;
  h.store.put("tasks", "task", { id: "task", agentId: "coordinator", localContext: true, status: "running", steps: [], mailDraftId: "draft", mailOutcome: "stale-task-flag" });
  h.store.put("mail_outbox", "draft", { id: "draft", taskId: "task", status: sourceStatus });
  h.store.put("mail_approvals", "service", { id: "service", taskId: "task", draftId: "draft", status: "approved" });
  h.store.put("approvals", "central", { id: "central", taskId: "task", type: "mail.send", serviceApprovalId: "service", status: "approved" });
  const mail = new MailService(h.store); t.after(() => mail.close());
  for (let i = 0; i < 2; i++) {
    const engine = h.engine(), stored = h.store.get("tasks", "task");
    assert.equal(stored.status, "needs_attention"); assert.equal(stored.mailOutcome, status);
    assert.match(stored.error, status === "sent" ? /SMTP.*接受.*不要重复发送/ : /邮件投递结果未知.*禁止重复发送/);
    assert.ok(stored.recoveryOutcomeCodes.includes(status === "sent" ? "MAIL_ACCEPTED_BY_SMTP" : "MAIL_DELIVERY_UNKNOWN"));
    assert.equal(h.store.get("approvals", "central").status, status === "sent" ? "completed" : "unknown");
    assert.equal(h.store.get("mail_approvals", "service").status, status === "sent" ? "completed" : "unknown");
    assert.equal(engine.task("task").liveResultAvailable, false);
    await engine.close();
  }
});

for (const sourceStatus of ["completed", "unknown", "executing"]) test(`recovery keeps actual browser ${sourceStatus} outcome without mislabeling pending central approval`, async t => {
  const h = await fixture(t), status = sourceStatus === "executing" ? "unknown" : sourceStatus;
  h.store.put("tasks", "task", { id: "task", agentId: "coordinator", localContext: true, status: "running", steps: [], controlledSessionId: "session", controlledApprovalId: "service", controlledOutcome: "stale-task-flag" });
  h.store.put("controlled_sessions", "session", { id: "session", taskId: "task", status: "agent" });
  h.store.put("browser_approvals", "service", { id: "service", taskId: "task", sessionId: "session", status: sourceStatus });
  h.store.put("approvals", "central", { id: "central", taskId: "task", type: "browser.actions", controlledApprovalId: "service", status: "pending" });
  const browser = new ControlledBrowserService(h.store); t.after(() => browser.close());
  for (let i = 0; i < 2; i++) {
    const engine = h.engine(), stored = h.store.get("tasks", "task");
    assert.equal(stored.status, "needs_attention"); assert.equal(stored.controlledOutcome, status);
    assert.match(stored.output, status === "completed" ? /网页输入已经执行.*不要重复执行/ : /网页输入结果未知.*禁止重放/);
    assert.equal(h.store.get("approvals", "central").status, status);
    assert.ok(stored.recoveryOutcomeCodes.includes(status === "completed" ? "BROWSER_INPUT_COMPLETED" : "BROWSER_INPUT_UNKNOWN"));
    await engine.close();
  }
});

test("local keyed bindings and memory-only submission identity leave no offline raw SHA verifier in SQL or WAL", async t => {
  const h = await fixture(t); h.local.configure({ mode: "confirm", roots: [h.files] });
  h.store.put("settings", "main", { ...h.store.get("settings", "main"), mode: "api" });
  const engine = h.engine(), prompt = "SYNTHETIC LOW ENTROPY YES", args = { path: join(h.files, "short-name.txt"), content: "SYNTHETIC YES" };
  await writeFile(args.path, "synthetic existing text");
  const input = { prompt, agentId: "coordinator", budget: 8, submissionId: "synthetic_submission_535" };
  const task = engine.create(input), read = await h.local.propose({ kind: "read", path: args.path }, { taskId: task.id });
  const pending = await h.local.propose({ kind: "write", ...args }, { taskId: task.id });
  const call = { id: "call", function: { name: "local_write_file", arguments: JSON.stringify(args) } };
  const approval = engine.bindLocalApproval(task, call, pending.operation);
  const guesses = [rawHash({ prompt, agentId: input.agentId, budget: input.budget }),
    rawHash({ name: call.function.name, args }), rawHash(read.operation.snapshot), rawHash(pending.operation.snapshot), rawHash(args.content)];
  assert.notEqual(read.operation.digest, guesses[2]); assert.notEqual(pending.operation.digest, guesses[3]); assert.notEqual(approval.toolArgsDigest, guesses[1]);
  assert.equal(h.store.get("tasks", task.id).submissionFingerprint, undefined);
  assert.equal(engine.create(input).id, task.id);
  assert.throws(() => engine.create({ ...input, prompt: "different" }), /不同/);
  const sql = h.store.db.prepare("SELECT payload FROM records").all().map(row => row.payload).join("\n");
  for (const guess of guesses) {
    assert.equal(sql.includes(guess), false);
    for (const name of ["agent.sqlite", "agent.sqlite-wal"])
      assert.equal((await readFile(join(h.dir, name))).includes(Buffer.from(guess)), false, name);
  }
  const another = new LocalAccessService(h.store); t.after(() => another.close());
  assert.notEqual(another.digest(read.operation.snapshot), read.operation.digest, "new process/service binding key changes");
  await engine.close();
  const restarted = h.engine();
  assert.throws(() => restarted.create(input), /重启清除.*无法核对/);
  assert.equal(h.store.all("tasks").length, 1);
  assert.equal(restarted.create({ ...input, submissionId: "synthetic_new_submission_536" }).submissionId, "synthetic_new_submission_536");
});

test("signal-terminated command is failed while zero exit and file operations complete", async t => {
  const h = await fixture(t); h.local.configure({ mode: "confirm", roots: [h.files] });
  // Controlled result injection tests the platform-neutral service classification.
  for (const exitCode of [null, 7, 0]) {
    h.local.commandOperation = async () => ({ exitCode, signal: exitCode === null ? "SIGTERM" : null, stdout: "", stderr: "" });
    const pending = await h.local.propose({ kind: "command", executable: process.execPath, args: [], cwd: h.files });
    const result = await h.local.approve(pending.operation.id);
    assert.equal(result.operation.status, exitCode === 0 ? "completed" : "failed");
  }
  const pending = await h.local.propose({ kind: "write", path: join(h.files, "empty.txt"), content: "" });
  assert.equal((await h.local.approve(pending.operation.id)).operation.status, "completed");
});

for (const withService of [false, true]) test(`recovery retains trusted side-effect flags and unknown takes precedence, service records=${withService}`, async t => {
  const h = await fixture(t);
  h.store.put("tasks", "task", { id: "task", agentId: "coordinator", localContext: true, status: "running", steps: [], mailOutcome: "sent", controlledOutcome: "unknown", mailDraftId: "draft", controlledApprovalId: "browser" });
  if (withService) {
    h.store.put("mail_outbox", "draft", { id: "draft", taskId: "task", status: "unknown" });
    h.store.put("browser_approvals", "browser", { id: "browser", taskId: "task", status: "completed" });
  }
  h.store.put("approvals", "pending-browser", { id: "pending-browser", taskId: "task", type: "browser.actions", status: "pending", controlledApprovalId: "browser" });
  h.engine(); const stored = h.store.get("tasks", "task");
  assert.equal(h.store.get("approvals", "pending-browser").status, "unknown");
  assert.equal(stored.status, "needs_attention");
  assert.equal(stored.mailOutcome, withService ? "unknown" : "sent");
  assert.equal(stored.controlledOutcome, "unknown");
  assert.match(stored.output, /禁止重放/);
  assert.match(stored.output, withService ? /邮件投递结果未知/ : /SMTP.*接受/);
});
