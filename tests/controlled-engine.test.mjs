import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.mjs";
import { createControlledBrowserFixtures } from "./fixtures/controlled-sites.mjs";
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
async function harness(t) {
  const fixtures = await createControlledBrowserFixtures(),
    dir = await mkdtemp(join(tmpdir(), "controlled-engine-"));
  let rounds = 0;
  const completion = async (args) => {
    rounds++;
    if (rounds === 1)
      return call("browser_open_target", { targetId: "oa" }, "open");
    if (rounds === 2) {
      const result = JSON.parse(args.messages.at(-1).content),
        obs = result.observation;
      return call(
        "browser_propose_actions",
        {
          sessionId: result.session.id,
          observationId: obs.observationId,
          reason: "新增虚构测试巡查",
          actions: [
            {
              type: "fill",
              controlId: obs.controls.find((c) => c.label === "巡查安排")
                .controlId,
              value: "虚构：引擎审批后巡查",
            },
            {
              type: "click",
              controlId: obs.controls.find((c) => c.label === "保存安排")
                .controlId,
            },
          ],
        },
        "write",
      );
    }
    const result = JSON.parse(args.messages.at(-1).content);
    assert.ok(["completed", "manual_handoff_complete"].includes(result.status));
    return {
      message: { role: "assistant", content: "已核验本地虚构页面结果。" },
    };
  };
  let app = await startServer({
      port: 0,
      dataDir: dir,
      stepDelay: 1,
      completion,
      controlledBrowserOptions: { allowTestLocal: true },
    }),
    cookie;
  const auth = async () => {
    const r = await fetch(app.url);
    cookie = r.headers.get("set-cookie").split(";")[0];
  };
  await auth();
  const api = async (path, b) => {
    const r = await fetch(app.url + path, {
      method: b === undefined ? "GET" : "POST",
      headers: { cookie, origin: app.url, "content-type": "application/json" },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return { status: r.status, data: await r.json() };
  };
  app.store.put("settings", "main", {
    ...app.store.get("settings", "main"),
    mode: "api",
    model: "fixture",
    budget: 30,
  });
  await api("/api/browser-targets", {
    targets: [
      { id: "oa", name: "虚构OA", startUrl: fixtures.oa.origin + "/oa" },
    ],
  });
  t.after(async () => {
    await app.close();
    await fixtures.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    fixtures,
    api,
    get rounds() {
      return rounds;
    },
    async restart() {
      await app.close();
      app = await startServer({
        port: 0,
        dataDir: dir,
        stepDelay: 1,
        completion,
        controlledBrowserOptions: { allowTestLocal: true },
      });
      await auth();
    },
  };
}
async function until(fn) {
  for (let i = 0; i < 1000; i++) {
    const r = await fn();
    if (r) return r;
    await wait(20);
  }
  throw Error("timeout");
}
async function pending(h) {
  const t = (
    await h.api("/api/tasks", {
      prompt: "在已配置虚构OA填写巡查安排，先让我审批",
      budget: 30,
    })
  ).data;
  return until(async () => {
    const r = (await h.api("/api/tasks/" + t.id)).data;
    if (r.status === "failed") throw Error(r.error);
    return r.status === "awaiting_approval" ? r : false;
  });
}
test("controlled engine: model opens generic target, proposes full batch, approval saves once and model resumes", async (t) => {
  const h = await harness(t),
    task = await pending(h);
  assert.equal(h.fixtures.stats.saves, 0);
  const a = h.app.store.get("browser_approvals", task.controlledApprovalId);
  const result = await h.api("/api/browser-approvals/" + a.id, {
    decision: "approve",
    digest: a.digest,
  });
  assert.equal(
    result.data.approval.status,
    "completed",
    JSON.stringify(result.data),
  );
  const done = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(done.status, "completed", done.error);
  assert.equal(h.rounds, 3);
  assert.equal(h.fixtures.stats.saves, 1);
  assert.equal(h.app.controlledBrowser.live.size, 0);
  assert.equal(
    (
      await h.api("/api/browser-approvals/" + a.id, {
        decision: "approve",
        digest: a.digest,
      })
    ).status,
    400,
  );
  assert.equal(h.fixtures.stats.saves, 1);
});
test("controlled engine: manual lease invalidates old actions and resumes model against new observation", async (t) => {
  const h = await harness(t),
    task = await pending(h),
    sid = task.controlledSessionId;
  let lease = (await h.api("/api/controlled-browser/" + sid + "/takeover", {}))
    .data;
  assert.ok(lease.leaseToken);
  const fill = lease.observation.controls.find((c) => c.label === "巡查安排");
  let action = (
    await h.api("/api/controlled-browser/" + sid + "/manual", {
      leaseToken: lease.leaseToken,
      observationId: lease.observation.observationId,
      action: {
        type: "fill",
        controlId: fill.controlId,
        value: "虚构：人工完成",
      },
    })
  ).data;
  const button = action.observation.controls.find(
    (c) => c.label === "保存安排",
  );
  action = (
    await h.api("/api/controlled-browser/" + sid + "/manual", {
      leaseToken: lease.leaseToken,
      observationId: action.observation.observationId,
      action: { type: "click", controlId: button.controlId },
    })
  ).data;
  assert.equal(h.fixtures.stats.saves, 1);
  await h.api("/api/controlled-browser/" + sid + "/resume", {
    leaseToken: lease.leaseToken,
  });
  const done = await until(async () => {
    const r = (await h.api("/api/tasks/" + task.id)).data;
    return ["completed", "failed"].includes(r.status) ? r : false;
  });
  assert.equal(done.status, "completed", done.error);
  assert.equal(
    h.app.store.get("browser_approvals", task.controlledApprovalId).status,
    "stale",
  );
  assert.equal(h.fixtures.stats.saves, 1);
  assert.equal(h.rounds, 3);
  assert.equal(
    JSON.stringify((await h.api("/api/state")).data).includes(lease.leaseToken),
    false,
  );
});
test("controlled engine: restart invalidates old pending actions and never silently replays a session", async (t) => {
  const h = await harness(t),
    task = await pending(h);
  await h.restart();
  const result = (await h.api("/api/tasks/" + task.id)).data;
  assert.equal(result.status, "needs_attention");
  assert.match(result.error, /中断/);
  const state = (await h.api("/api/state")).data;
  assert.equal(
    state.approvals.filter(
      (a) => a.taskId === task.id && a.status === "pending",
    ).length,
    0,
  );
  assert.equal(h.fixtures.stats.saves, 0);
  assert.equal(h.rounds, 2);
});

test('controlled engine: disabling a configured target cancels waiting task and invalidates pending central approval',async t=>{const h=await harness(t),task=await pending(h);await h.api('/api/browser-targets',{targets:[{id:'oa',name:'虚构OA',startUrl:h.fixtures.oa.origin+'/oa',enabled:false}]});const final=(await h.api('/api/tasks/'+task.id)).data;assert.equal(final.status,'cancelled');assert.equal(h.app.store.all('approvals').filter(a=>a.taskId===task.id&&a.status==='pending').length,0);assert.equal(h.fixtures.stats.saves,0);assert.equal(h.rounds,2);});
