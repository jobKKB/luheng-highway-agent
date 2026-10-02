import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.mjs";
import { mailFixtures } from "./mail-fixtures.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (name, args, id) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
async function setup(t, { smtpMode = "normal", afterSend } = {}) {
  const fixture = await mailFixtures();
  fixture.smtp.mode = smtpMode;
  const dir = await mkdtemp(join(tmpdir(), "mail-engine-"));
  let rounds = 0;
  const completion = async (args) => {
    rounds++;
    if (rounds === 1)
      return call("mail_read_inbox", { accountId: "fixture" }, "read");
    if (rounds === 2)
      return call(
        "mail_create_draft",
        {
          accountId: "fixture",
          to: "recipient@example.invalid",
          subject: "虚构协议验收",
          text: "这是完整审批正文，仅本地测试",
        },
        "draft",
      );
    if (rounds === 3)
      return call(
        "mail_request_send",
        { draftId: JSON.parse(args.messages.at(-1).content).id },
        "send",
      );
    if (afterSend) return afterSend(args);
    return {
      message: {
        role: "assistant",
        content: "邮件已经交给SMTP服务器，未声称收件人已读。",
      },
    };
  };
  const app = await startServer({
    port: 0,
    dataDir: dir,
    stepDelay: 1,
    completion,
    mailOptions: {
      allowTestLocal: true,
      testTls: { ca: fixture.cert },
      timeoutMs: 3000,
    },
  });
  const root = await fetch(app.url);
  const cookie = root.headers.get("set-cookie").split(";")[0];
  const api = async (path, body, method = "POST") => {
    const res = await fetch(app.url + path, {
      method: body === undefined ? "GET" : method,
      headers: { cookie, origin: app.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };
  app.store.put("settings", "main", {
    ...app.store.get("settings", "main"),
    mode: "api",
    model: "fixture",
    budget: 30,
  });
  assert.equal((await api("/api/mail/config", fixture.config)).status, 200);
  const h = {
    app,
    api,
    fixture,
    dir,
    get rounds() {
      return rounds;
    },
  };
  t.after(async () => {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  });
  return h;
}
async function until(fn) {
  for (let i = 0; i < 500; i++) {
    const x = await fn();
    if (x) return x;
    await wait(10);
  }
  throw Error("timeout");
}
async function pending(h) {
  const task = (
    await h.api("/api/tasks", {
      prompt: "读取夹具邮件并准备回复，发送前请让我审批",
      budget: 30,
    })
  ).data;
  return until(async () => {
    const t = (await h.api("/api/tasks/" + task.id)).data;
    if (t.status === "failed") throw Error(t.error);
    return t.status === "awaiting_approval" ? t : false;
  });
}
test("real mail tool loop pauses for exact-content approval then sends once and resumes model", async (t) => {
  const h = await setup(t);
  const task = await pending(h);
  assert.equal(h.fixture.smtp.messages.length, 0);
  const state = (await h.api("/api/state")).data;
  const approval = state.mailApprovals.find((a) => a.taskId === task.id);
  assert.equal(approval.snapshot.text, "这是完整审批正文，仅本地测试");
  assert.equal(approval.snapshot.transport.host, "127.0.0.1");
  assert.equal(task.privateContextOwner, "coordinator");
  const [first, repeat] = await Promise.all([
    h.api("/api/mail/approvals/" + approval.id, { decision: "approve" }),
    h.api("/api/mail/approvals/" + approval.id, { decision: "approve" }),
  ]);
  assert.ok([first.status, repeat.status].includes(200));
  const result = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.mailOutcome, "sent");
  assert.equal(h.fixture.smtp.messages.length, 1);
  assert.equal(h.rounds, 4);
  assert.equal(result.executedToolIds.includes("send"), true);
});
test("uncertain SMTP delivery halts model and requires attention without resend", async (t) => {
  const h = await setup(t, { smtpMode: "drop-after-data" });
  const task = await pending(h);
  const result = await h.api("/api/mail/approvals/" + task.mailApprovalId, {
    decision: "approve",
  });
  assert.equal(result.data.status, "unknown");
  const final = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(final.status, "needs_attention");
  assert.match(final.error, /不确定/);
  assert.equal(h.rounds, 3);
  assert.equal(h.fixture.smtp.messages.length, 1);
  assert.equal(
    (
      await h.api("/api/mail/approvals/" + task.mailApprovalId, {
        decision: "approve",
      })
    ).status,
    400,
  );
  assert.equal(h.fixture.smtp.messages.length, 1);
});
test("revoked role send permission after planning prevents any SMTP connection", async (t) => {
  const h = await setup(t);
  const task = await pending(h);
  const actor = h.app.store.get("agents", "coordinator");
  h.app.store.put("agents", actor.id, {
    ...actor,
    permissions: actor.permissions.filter((p) => p !== "mail.send"),
  });
  await h.api("/api/mail/approvals/" + task.mailApprovalId, {
    decision: "approve",
  });
  const final = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(final.status, "failed");
  assert.match(final.error, /mail.send/);
  assert.equal(h.fixture.smtp.messages.length, 0);
  assert.equal(h.fixture.smtp.connections, 0);
});
test("task cancellation after DATA retains unknown outcome instead of pretending mail was cancelled", async (t) => {
  const h = await setup(t, { smtpMode: "hold-after-data" });
  const task = await pending(h);
  const decision = h.api("/api/mail/approvals/" + task.mailApprovalId, {
    decision: "approve",
  });
  await until(() => h.fixture.smtp.messages.length === 1);
  await h.api("/api/tasks/" + task.id + "/cancel", {});
  await decision;
  const final = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(final.status, "needs_attention");
  assert.equal(final.mailOutcome, "unknown");
  assert.match(final.output, /不确定/);
  assert.equal(h.rounds, 3);
});

test("missing memory-only credentials preserves pending approval until explicit re-entry", async (t) => {
  const h = await setup(t);
  const task = await pending(h);
  h.app.mail.credentials.clear();
  const first = await h.api("/api/mail/approvals/" + task.mailApprovalId, {
    decision: "approve",
  });
  assert.equal(first.data.status, "pending_approval");
  let state = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(state.status, "awaiting_approval");
  assert.match(state.error, /凭据/);
  assert.equal(h.fixture.smtp.connections, 0);
  await h.api("/api/mail/config", h.fixture.config);
  await h.api("/api/mail/approvals/" + task.mailApprovalId, {
    decision: "approve",
  });
  state = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.error, null);
  assert.equal(h.fixture.smtp.messages.length, 1);
});

test("editing a task draft invalidates old approvals, then new exact approval resumes original task", async (t) => {
  const h = await setup(t),
    task = await pending(h);
  const old = task.mailApprovalId;
  const edit = await h.api(
    "/api/mail/drafts/" + task.mailDraftId,
    { text: "用户编辑后的完整正文" },
    "PUT",
  );
  assert.equal(edit.status, 200);
  assert.equal(h.app.store.get("mail_approvals", old).status, "invalidated");
  assert.equal(
    h.app.store.all("approvals").find((a) => a.serviceApprovalId === old)
      .status,
    "invalidated",
  );
  const fresh = (
    await h.api("/api/mail/drafts/" + task.mailDraftId + "/request-send", {})
  ).data;
  assert.notEqual(fresh.id, old);
  assert.equal(fresh.snapshot.text, "用户编辑后的完整正文");
  await h.api("/api/mail/approvals/" + fresh.id, { decision: "approve" });
  const result = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(result.status, "completed", result.error);
  assert.equal(h.fixture.smtp.messages.length, 1);
  assert.equal(h.rounds, 4);
});
