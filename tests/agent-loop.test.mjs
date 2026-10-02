import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startServer } from "../server.mjs";
import { callCompletion } from "../lib/model.mjs";
const tc = (name, args, id) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const toolResponse = (...calls) => ({
  message: { role: "assistant", content: null, tool_calls: calls },
});
const textResponse = (content) => ({ message: { role: "assistant", content } });
async function client(completion) {
  const dir = await mkdtemp(join(tmpdir(), "luheng-loop-"));
  const app = await startServer({
    port: 0,
    dataDir: dir,
    stepDelay: 1,
    completion,
  });
  const r = await fetch(app.url);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const api = async (path, body) => {
    const r = await fetch(app.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin: app.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, data: await r.json() };
  };
  const settings = app.store.get("settings", "main");
  app.store.put("settings", "main", {
    ...settings,
    mode: "api",
    model: "fake-protocol-test",
    budget: 30,
  });
  return {
    app,
    dir,
    api,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function settled(c, id) {
  for (let i = 0; i < 300; i++) {
    const t = (await c.api("/api/tasks/" + id)).data;
    if (
      ["completed", "failed", "cancelled", "awaiting_approval"].includes(
        t.status,
      )
    )
      return t;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("task did not settle");
}
test("OpenAI-compatible protocol encodes tools and accepts tool-call response", async () => {
  let incoming;
  const fixture = http.createServer(async (req, res) => {
    let text = "";
    for await (const b of req) text += b;
    incoming = JSON.parse(text);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [tc("knowledge_search", { query: "养护" }, "call-1")],
            },
          },
        ],
      }),
    );
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  try {
    const output = await callCompletion({
      endpoint: `http://127.0.0.1:${fixture.address().port}/v1`,
      allowTestLocal: true,
      model: "fixture",
      key: "fake-not-real",
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          type: "function",
          function: {
            name: "knowledge_search",
            parameters: { type: "object" },
          },
        },
      ],
    });
    assert.equal(incoming.tool_choice, "auto");
    assert.equal(incoming.parallel_tool_calls, false);
    assert.equal(
      output.message.tool_calls[0].function.name,
      "knowledge_search",
    );
  } finally {
    await new Promise((r) => fixture.close(r));
  }
});
test("real agent loop chooses retrieval, delegates a role, writes artifact and returns final", async () => {
  let requests = 0,
    delegated = 0;
  const c = await client(async (args) => {
    if (args.messages[0].content.includes("受限只读子智能体")) {
      delegated++;
      return textResponse("知行核验：剩余一项。来源DEMO-001。");
    }
    requests++;
    if (requests === 1)
      return toolResponse(
        tc("knowledge_search", { query: "养护" }, "knowledge-1"),
      );
    if (requests === 2) {
      assert.match(args.messages.at(-1).content, /DEMO-001/);
      return toolResponse(
        tc(
          "agent_delegate",
          { agentId: "researcher", instruction: "核验待办并注明来源" },
          "delegate-1",
        ),
      );
    }
    if (requests === 3) {
      assert.match(args.messages.at(-1).content, /知行/);
      return toolResponse(
        tc(
          "workspace_save",
          {
            name: "模型报告.md",
            content: "根据知行核验，剩余一项。来源DEMO-001。",
          },
          "save-1",
        ),
      );
    }
    assert.match(args.messages.at(-1).content, /saved/);
    return textResponse("已完成研究和文件保存。");
  });
  try {
    const task = (
      await c.api("/api/tasks", {
        prompt: "研究台账并委派资料员核验，保存简报",
        budget: 30,
      })
    ).data;
    const result = await settled(c, task.id);
    assert.equal(result.status, "completed", result.error);
    assert.equal(delegated, 1);
    assert.equal(requests, 4);
    assert.equal(result.executedToolIds.length, 3);
    assert.match(
      await readFile(
        join(c.dir, "artifacts", result.artifact.filename),
        "utf8",
      ),
      /DEMO-001/,
    );
  } finally {
    await c.close();
  }
});
test("agent loop obeys permission intersection even when model requests forbidden write", async () => {
  const c = await client(async () =>
    toolResponse(
      tc("workspace_save", { name: "test.txt", content: "denied" }, "denied-1"),
    ),
  );
  try {
    const task = (
      await c.api("/api/tasks", { prompt: "write", agentId: "researcher" })
    ).data;
    const result = await settled(c, task.id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /workspace.write/);
    assert.equal(result.artifact, null);
  } finally {
    await c.close();
  }
});
test("repeated tool ID cannot create duplicate reminders", async () => {
  let n = 0;
  const c = await client(async () => {
    n++;
    return toolResponse(
      tc(
        "reminder_create",
        {
          title: "测试提醒",
          dueAt: new Date(Date.now() + 100000).toISOString(),
        },
        "same-id",
      ),
    );
  });
  try {
    const task = (
      await c.api("/api/tasks", { prompt: "创建一个测试提醒", budget: 30 })
    ).data;
    const result = await settled(c, task.id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /重复工具调用/);
    assert.equal(c.app.store.all("reminders").length, 1);
    assert.equal(n, 2);
  } finally {
    await c.close();
  }
});
test("tool loop is bounded at 8 model rounds", async () => {
  let n = 0;
  const c = await client(async () =>
    toolResponse(tc("knowledge_search", { query: "" }, "round-" + ++n)),
  );
  try {
    const task = (
      await c.api("/api/tasks", { prompt: "循环测试", budget: 100 })
    ).data;
    const result = await settled(c, task.id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /8轮/);
    assert.equal(n, 8);
  } finally {
    await c.close();
  }
});
test("model-requested mock OA approval persists and resumes with tool result after server restart", async () => {
  let n = 0;
  const completion = async (args) => {
    n++;
    if (n === 1) return toolResponse(tc("browser_read", {}, "read-browser"));
    if (n === 2)
      return toolResponse(
        tc(
          "browser_submit",
          { title: "演示：模型规划巡查安排" },
          "write-browser",
        ),
      );
    assert.equal(args.messages.at(-1).tool_call_id, "write-browser");
    assert.match(args.messages.at(-1).content, /saved/);
    return textResponse("模拟OA已保存，审批后完成。");
  };
  let c = await client(completion);
  try {
    const task = (
      await c.api("/api/tasks", { prompt: "在模拟OA新增演示安排", budget: 30 })
    ).data;
    let waiting = await settled(c, task.id);
    assert.equal(waiting.status, "awaiting_approval", waiting.error);
    const approval = c.app.store.all("approvals")[0];
    assert.equal(
      c.app.store.get("sessions", waiting.browserSessionId).records.length,
      0,
    );
    await c.app.close();
    const app = await startServer({
      port: 0,
      dataDir: c.dir,
      stepDelay: 1,
      completion,
    });
    const r = await fetch(app.url);
    const cookie = r.headers.get("set-cookie").split(";")[0];
    c.app = app;
    c.api = async (path, body) => {
      const r = await fetch(app.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          origin: app.url,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, data: await r.json() };
    };
    const decision = await c.api("/api/approvals/" + approval.id, {
      decision: "approve",
    });
    assert.equal(decision.data.status, "completed", decision.data.error);
    assert.equal(
      app.store.get("sessions", waiting.browserSessionId).records.length,
      1,
    );
    assert.equal(n, 3);
    const repeat = await c.api("/api/approvals/" + approval.id, {
      decision: "approve",
    });
    assert.equal(repeat.status, 400);
    assert.equal(
      app.store.get("sessions", waiting.browserSessionId).records.length,
      1,
    );
  } finally {
    await c.app.close();
    await rm(c.dir, { recursive: true, force: true });
  }
});
