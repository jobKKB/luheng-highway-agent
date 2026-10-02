import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../lib/redact.mjs";
import { parseTool } from "../lib/agent-tools.mjs";
import { Store } from "../lib/store.mjs";
import { Engine } from "../lib/engine.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (args) => ({
  function: { name: "knowledge_search", arguments: args },
});
test("redaction reaches content, tool argument strings, usage, nested arrays and object keys", () => {
  const key = "fake-secret-only-for-test";
  const response = {
    message: {
      content: key,
      tool_calls: [
        { id: "1", function: { arguments: JSON.stringify({ body: key }) } },
      ],
    },
    usage: { [key]: [key, 5] },
  };
  const safe = redactSecrets(response, [key]);
  assert.equal(JSON.stringify(safe).includes(key), false);
  assert.match(JSON.stringify(safe), /REDACTED/);
  assert.equal(response.message.content, key);
});
test("tool schema rejects incorrect optional types and inherited-property names", () => {
  assert.throws(() => parseTool(call('{"query":{"x":1}}')), /类型/);
  assert.throws(() => parseTool(call('{"query":123}')), /类型/);
  assert.throws(() => parseTool(call('{"constructor":"x"}')), /未获允许/);
  assert.throws(() => parseTool(call('{"__proto__":"x"}')), /未获允许/);
  assert.equal(parseTool(call('{"query":"养护"}')).query, "养护");
});
async function synthetic({ completion, getKey = () => "", broker } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "luheng-hardening-"));
  const store = new Store(dir);
  store.put("settings", "main", {
    ...store.get("settings", "main"),
    mode: "api",
    model: "fake",
  });
  const b = broker || { async stop() {}, async close() {} };
  const engine = new Engine(store, b, { getKey, delay: 1, completion });
  return {
    dir,
    store,
    engine,
    async close() {
      await engine.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function done(h, task) {
  for (let i = 0; i < 200; i++) {
    let t = h.store.get("tasks", task.id);
    if (
      ["completed", "failed", "cancelled", "awaiting_approval"].includes(
        t.status,
      ) &&
      !h.engine.running.has(task.id)
    )
      return t;
    await wait(5);
  }
  throw Error("timeout");
}
test("provider-echoed key never reaches SQLite task, state or audit; provider errors redacted too", async () => {
  const key = "fake-key-never-persist-77";
  let error = false;
  const h = await synthetic({
    getKey: () => key,
    completion: async () => {
      if (error) throw Error("provider says " + key);
      return {
        message: { role: "assistant", content: "echo " + key },
        usage: { echo: key },
      };
    },
  });
  try {
    const t = h.engine.create({ prompt: "test" });
    const result = await done(h, t);
    assert.equal(result.status, "completed");
    assert.equal(JSON.stringify(h.store.all("tasks")).includes(key), false);
    assert.equal(JSON.stringify(h.store.all("audit")).includes(key), false);
    error = true;
    const fail = await done(h, h.engine.create({ prompt: "test error" }));
    assert.equal(fail.status, "failed");
    assert.equal(fail.error.includes(key), false);
    assert.equal(JSON.stringify(h.store.all("audit")).includes(key), false);
    const files = await Promise.all(
      ["agent.sqlite", "agent.sqlite-wal"].map((p) =>
        readFile(join(h.dir, p)).catch(() => Buffer.alloc(0)),
      ),
    );
    assert.equal(
      files.some((b) => b.includes(Buffer.from(key))),
      false,
    );
  } finally {
    await h.close();
  }
});
test("cancellation while browser creation is in flight closes the eventual context", async () => {
  let release,
    started,
    closed = 0;
  const active = new Set();
  const startedPromise = new Promise((r) => (started = r));
  const gate = new Promise((r) => (release = r));
  const broker = {
    async create(taskId) {
      started();
      await gate;
      active.add("s1");
      return { id: "s1" };
    },
    async read() {
      return "fixture";
    },
    async stop(id) {
      active.delete(id);
      closed++;
    },
    async close() {
      active.clear();
    },
  };
  let n = 0;
  const h = await synthetic({
    broker,
    completion: async () =>
      n++
        ? { message: { role: "assistant", content: "done" } }
        : {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "browser",
                  type: "function",
                  function: { name: "browser_read", arguments: "{}" },
                },
              ],
            },
          },
  });
  try {
    const task = h.engine.create({ prompt: "read" });
    await startedPromise;
    h.engine.cancel(task.id);
    release();
    const result = await done(h, task);
    assert.equal(result.status, "cancelled");
    assert.equal(active.size, 0);
    assert.equal(closed, 1);
  } finally {
    release?.();
    await h.close();
  }
});
test("successful read-only browser task releases its context at completion", async () => {
  let n = 0;
  const active = new Set();
  const broker = {
    async create() {
      active.add("s1");
      return { id: "s1" };
    },
    async read() {
      return "fixture";
    },
    async stop(id) {
      active.delete(id);
    },
    async close() {
      active.clear();
    },
  };
  const h = await synthetic({
    broker,
    completion: async () =>
      n++
        ? { message: { role: "assistant", content: "read complete" } }
        : {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "browser",
                  type: "function",
                  function: { name: "browser_read", arguments: "{}" },
                },
              ],
            },
          },
  });
  try {
    const result = await done(h, h.engine.create({ prompt: "read" }));
    assert.equal(result.status, "completed");
    assert.equal(active.size, 0);
  } finally {
    await h.close();
  }
});

test("JSON-escaped credentials in serialized tool arguments are redacted before execution", () => {
  const key = "fake-secret-escaped";
  const escaped = [...key]
    .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  const result = redactSecrets(
    {
      message: {
        tool_calls: [
          {
            function: {
              name: "workspace_save",
              arguments: '{"name":"test.txt","content":"' + escaped + '"}',
            },
          },
        ],
      },
    },
    [key],
  );
  const decoded = JSON.parse(result.message.tool_calls[0].function.arguments);
  assert.equal(decoded.content, "[REDACTED]");
  assert.equal(JSON.stringify(result).includes(key), false);
});
