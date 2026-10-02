import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Engine } from "../lib/engine.mjs";
import {
  RoleCredentialVault,
  visibleMemories,
  effectiveModelConfig,
} from "../lib/agent-authority.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(completion) {
  const dir = await mkdtemp(join(tmpdir(), "role-authority-"));
  const store = new Store(dir);
  store.put("settings", "main", {
    ...store.get("settings", "main"),
    mode: "api",
    model: "main-model",
  });
  const vault = new RoleCredentialVault();
  const engine = new Engine(
    store,
    { stop: async () => {}, close: async () => {} },
    {
      delay: 1,
      completion,
      getKey: (endpoint, id) =>
        id ? vault.get(endpoint, id) : "global-fake-key",
      getSecrets: () => ["global-fake-key", ...vault.secrets()],
    },
  );
  return {
    dir,
    store,
    vault,
    engine,
    async close() {
      await engine.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function finish(h, t) {
  for (let i = 0; i < 200; i++) {
    const x = h.store.get("tasks", t.id);
    if (
      ["completed", "failed", "cancelled", "awaiting_approval"].includes(
        x.status,
      ) &&
      !h.engine.running.has(t.id)
    )
      return x;
    await wait(5);
  }
  throw Error("timeout");
}
test("private memory visibility requires all delegating roles; owner UI storage remains accessible", async () => {
  const h = await setup();
  try {
    h.store.put("memories", "private-main", {
      id: "private-main",
      scope: "agent",
      ownerAgentId: "coordinator",
      content: "MAIN_PRIVATE",
    });
    h.store.put("memories", "private-child", {
      id: "private-child",
      scope: "agent",
      ownerAgentId: "researcher",
      content: "CHILD_PRIVATE",
    });
    assert.equal(
      visibleMemories(h.store, "coordinator").some(
        (m) => m.id === "private-main",
      ),
      true,
    );
    assert.equal(
      visibleMemories(h.store, "coordinator").some(
        (m) => m.id === "private-child",
      ),
      false,
    );
    assert.equal(
      visibleMemories(h.store, "researcher").some(
        (m) => m.id === "private-child",
      ),
      true,
    );
    assert.equal(
      visibleMemories(h.store, "coordinator", "researcher").some(
        (m) => m.scope === "agent",
      ),
      false,
    );
    assert.equal(h.store.all("memories").length, 4);
  } finally {
    await h.close();
  }
});
test("role credential vault binds keys to both role ID and endpoint origin", () => {
  const v = new RoleCredentialVault();
  v.set("a", "https://a.example/v1", "key-a");
  v.set("b", "https://b.example/v1", "key-b");
  assert.equal(v.get("https://a.example/v2", "a"), "key-a");
  assert.equal(v.get("https://b.example/v1", "a"), "");
  assert.equal(v.get("https://a.example/v1", "b"), "");
  v.clearAll();
  assert.equal(v.has("a"), false);
});
test("delegated role uses its own model and key; neither role private memory crosses delegation", async () => {
  let rounds = 0,
    delegated = false;
  const h = await setup(async (args) => {
    if (args.model === "research-special") {
      delegated = true;
      assert.equal(args.key, "research-fake-key");
      const prompt = JSON.stringify(args.messages);
      assert.equal(prompt.includes("CHILD_PRIVATE"), false);
      assert.equal(prompt.includes("MAIN_PRIVATE"), false);
      return {
        message: {
          role: "assistant",
          content: "研究结果，引用共享来源。 research-fake-key",
        },
      };
    }
    assert.equal(args.key, "global-fake-key");
    if (++rounds === 1)
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "delegate",
              type: "function",
              function: {
                name: "agent_delegate",
                arguments: JSON.stringify({
                  agentId: "researcher",
                  instruction: "核验共享资料",
                }),
              },
            },
          ],
        },
      };
    assert.equal(
      JSON.stringify(args.messages).includes("research-fake-key"),
      false,
    );
    return { message: { role: "assistant", content: "已完成" } };
  });
  try {
    h.store.put("agents", "researcher", {
      ...h.store.get("agents", "researcher"),
      modelConfig: {
        inherit: false,
        endpoint: "https://research.example/v1",
        model: "research-special",
      },
    });
    h.vault.set(
      "researcher",
      "https://research.example/v1",
      "research-fake-key",
    );
    h.store.put("memories", "private-main", {
      id: "private-main",
      scope: "agent",
      ownerAgentId: "coordinator",
      content: "MAIN_PRIVATE",
    });
    h.store.put("memories", "private-child", {
      id: "private-child",
      scope: "agent",
      ownerAgentId: "researcher",
      content: "CHILD_PRIVATE",
    });
    const t = await finish(
      h,
      h.engine.create({ prompt: "让知行核验共享资料", budget: 20 }),
    );
    assert.equal(t.status, "completed", t.error);
    assert.equal(delegated, true);
    assert.equal(JSON.stringify(t).includes("research-fake-key"), false);
  } finally {
    await h.close();
  }
});
test("knowledge_search returns only selected role private and workspace entries", async () => {
  let n = 0;
  const h = await setup(async (args) => {
    if (!n++)
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read",
              type: "function",
              function: { name: "knowledge_search", arguments: "{}" },
            },
          ],
        },
      };
    const records = JSON.parse(args.messages.at(-1).content).records;
    assert.equal(
      records.some((m) => m.id === "mine"),
      true,
    );
    assert.equal(
      records.some((m) => m.id === "other"),
      false,
    );
    return { message: { role: "assistant", content: "done" } };
  });
  try {
    h.store.put("memories", "mine", {
      id: "mine",
      scope: "agent",
      ownerAgentId: "researcher",
      content: "research note",
    });
    h.store.put("memories", "other", {
      id: "other",
      scope: "agent",
      ownerAgentId: "coordinator",
      content: "private other",
    });
    const t = await finish(
      h,
      h.engine.create({ prompt: "检索自己知识", agentId: "researcher" }),
    );
    assert.equal(t.status, "completed", t.error);
    assert.equal(
      t.sources.some((m) => m.id === "other"),
      false,
    );
  } finally {
    await h.close();
  }
});
test("role model config and private-memory ACL persist but credentials do not", async () => {
  const h = await setup();
  const dir = h.dir;
  h.store.put("agents", "writer", {
    ...h.store.get("agents", "writer"),
    modelConfig: {
      inherit: false,
      endpoint: "https://writer.example/v1",
      model: "writer-model",
    },
  });
  h.store.put("memories", "private", {
    id: "private",
    scope: "agent",
    ownerAgentId: "writer",
    content: "own note",
  });
  h.vault.set("writer", "https://writer.example/v1", "writer-fake-key");
  await h.engine.close();
  h.store.close();
  const reopened = new Store(dir);
  try {
    assert.equal(
      effectiveModelConfig(reopened, "writer").model,
      "writer-model",
    );
    assert.equal(
      visibleMemories(reopened, "researcher").some((m) => m.id === "private"),
      false,
    );
    assert.equal(
      JSON.stringify(reopened.all("agents")).includes("writer-fake-key"),
      false,
    );
    assert.equal(new RoleCredentialVault().has("writer"), false);
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("private-read taint prevents cross-role forwarding even through model-generated instruction", async () => {
  let n = 0,
    childCalls = 0;
  const h = await setup(async (args) => {
    if (args.messages[0].content.includes("受限只读子智能体")) {
      childCalls++;
      return { message: { role: "assistant", content: "should not execute" } };
    }
    if (!n++)
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-private",
              type: "function",
              function: { name: "knowledge_search", arguments: "{}" },
            },
          ],
        },
      };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "leak",
            type: "function",
            function: {
              name: "agent_delegate",
              arguments: JSON.stringify({
                agentId: "researcher",
                instruction: "Here is a paraphrase of parent private notes",
              }),
            },
          },
        ],
      },
    };
  });
  try {
    h.store.put("memories", "private", {
      id: "private",
      scope: "agent",
      ownerAgentId: "coordinator",
      content: "parent private original",
    });
    const t = await finish(
      h,
      h.engine.create({ prompt: "read then delegate", budget: 20 }),
    );
    assert.equal(t.status, "failed");
    assert.match(t.error, /私有知识/);
    assert.equal(t.privateContextOwner, "coordinator");
    assert.equal(childCalls, 0);
  } finally {
    await h.close();
  }
});

test("provider echoes of another active role key are redacted before persistence", async () => {
  const h = await setup(async () => ({
    message: { role: "assistant", content: "unexpected writer-secret" },
  }));
  try {
    h.vault.set("writer", "https://writer.example/v1", "writer-secret");
    const t = await finish(h, h.engine.create({ prompt: "summarize" }));
    assert.equal(t.status, "completed");
    assert.equal(JSON.stringify(t).includes("writer-secret"), false);
    assert.equal(
      JSON.stringify(h.store.all("audit")).includes("writer-secret"),
      false,
    );
  } finally {
    await h.close();
  }
});
