import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  let app = await startServer({
    port: 0,
    dataDir: dir,
    stepDelay: 1,
    completion,
  });
  const r = await fetch(app.url);
  let cookie = r.headers.get("set-cookie").split(";")[0];
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
    get app() { return app; },
    dir,
    api,
    async restart() {
      await app.close();
      app = await startServer({ port: 0, dataDir: dir, stepDelay: 1, completion });
      const response = await fetch(app.url);
      cookie = response.headers.get("set-cookie").split(";")[0];
    },
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
      ["completed", "failed", "cancelled", "awaiting_approval", "needs_attention"].includes(
        t.status,
      ) && !c.app.engine.running.has(id)
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
              tool_calls: [tc("knowledge_search", { query: "synthetic note" }, "call-1")],
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
      assert.equal(args.tools, undefined, "read-only delegates receive no tools");
      assert.match(args.messages.at(-1).content, /SYNTHETIC-SOURCE-001/);
      return textResponse("知行核验：剩余一项。来源SYNTHETIC-SOURCE-001。");
    }
    requests++;
    if (requests === 1)
      return toolResponse(
        tc("knowledge_search", { query: "synthetic note" }, "knowledge-1"),
      );
    if (requests === 2) {
      const records = JSON.parse(args.messages.at(-1).content).records;
      assert.equal(records.length, 1);
      assert.equal(records[0].title, "Synthetic retrieval note");
      assert.equal(records[0].source, "SYNTHETIC-SOURCE-001");
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
            content: "根据知行核验，剩余一项。来源SYNTHETIC-SOURCE-001。",
          },
          "save-1",
        ),
      );
    }
    assert.match(args.messages.at(-1).content, /saved/);
    return textResponse("已完成研究和文件保存。");
  });
  try {
    assert.deepEqual(c.app.store.all("memories"), []);
    const memory = await c.api("/api/memories", {
      title: "Synthetic retrieval note",
      content: "synthetic note: one pending test item",
      source: "SYNTHETIC-SOURCE-001",
    });
    assert.equal(memory.status, 201);
    const task = (
      await c.api("/api/tasks", {
        prompt: "研究合成测试资料并委派资料员核验，保存简报",
        budget: 30,
      })
    ).data;
    const result = await settled(c, task.id);
    assert.equal(result.status, "completed", result.error);
    assert.equal(delegated, 1);
    assert.equal(requests, 4);
    assert.deepEqual(result.executedToolIds, ["knowledge-1", "delegate-1", "save-1"]);
    assert.deepEqual(result.sources.map(source => source.id), [memory.data.id]);
    assert.equal(result.budgetUsed, 9, "four main requests, read, two delegation checks, delegate model, save");
    assert.match(
      await readFile(
        join(c.dir, "artifacts", result.artifact.filename),
        "utf8",
      ),
      /SYNTHETIC-SOURCE-001/,
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
test("delegated writer stays read-only even when its role has workspace write permission", async () => {
  let childCalls = 0;
  const c = await client(async args => {
    if (args.messages[0].content.includes("受限只读子智能体")) {
      childCalls++;
      assert.equal(args.tools, undefined);
      return toolResponse(tc("workspace_save", { name: "Forbidden child.txt", content: "Synthetic forbidden child artifact" }, "child-write"));
    }
    return toolResponse(tc("agent_delegate", { agentId: "writer", instruction: "Review the synthetic note read-only" }, "delegate-writer"));
  });
  try {
    assert.ok(c.app.store.get("agents", "writer").permissions.includes("workspace.write"));
    const task = (await c.api("/api/tasks", { prompt: "Delegate synthetic read-only review", budget: 30 })).data;
    const result = await settled(c, task.id);
    assert.equal(result.status, "failed");
    assert.match(result.error, /只读子智能体请求工具/);
    assert.equal(childCalls, 1);
    assert.equal(result.artifact, null);
    assert.deepEqual(result.executedToolIds, []);
    assert.equal(c.app.store.all("approvals").length, 0);
    assert.deepEqual(await readdir(join(c.dir, "artifacts")), []);
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
test("non-local unsupported OA call fails without approval and cannot resume after server restart", async () => {
  let requests = 0;
  const c = await client(async (args) => {
    requests++;
    for (const name of ["browser_read", "browser_submit", "mail_draft"])
      assert.equal(args.tools.some(tool => tool.function.name === name), false);
    return toolResponse(tc("browser_submit", { title: "Synthetic obsolete OA request" }, "removed-write"));
  });
  try {
    // A deliberately non-local role tests persistent task history. Default
    // coordinator privacy is tested independently in core.test.mjs.
    const actor = c.app.store.get("agents", "coordinator");
    c.app.store.put("agents", actor.id, { ...actor,
      permissions: actor.permissions.filter(permission => !["files.read", "files.write", "commands.run"].includes(permission)) });
    const task = (await c.api("/api/tasks", { prompt: "Synthetic obsolete OA request", budget: 30 })).data;
    const failed = await settled(c, task.id);
    assert.equal(failed.localContext, false);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /尚无可调用实现/);
    assert.deepEqual(failed.executedToolIds, []);
    assert.equal(failed.budgetUsed, 1);
    assert.equal(failed.browserSessionId, undefined);
    assert.equal(failed.artifact, null);
    for (const kind of ["approvals", "sessions", "mail", "mail_outbox"])
      assert.deepEqual(c.app.store.all(kind), []);
    await c.restart();
    const restored = (await c.api("/api/tasks/" + task.id)).data;
    assert.equal(restored.status, "failed");
    assert.equal(restored.prompt, task.prompt);
    assert.equal(restored.error, failed.error);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requests, 1, "unsupported tool calls cannot replay on restart");
    assert.equal((await c.api("/api/approvals/nonexistent", { decision: "approve" })).status, 400);
    for (const kind of ["approvals", "sessions", "mail", "mail_outbox"])
      assert.deepEqual(c.app.store.all(kind), []);
  } finally {
    await c.close();
  }
});
