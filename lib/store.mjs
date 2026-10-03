import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const permissions = [
  "knowledge.read",
  "workspace.write",
  "browser.read",
  "browser.write",
  "mail.draft",
  "agent.delegate",
  "reminder.create",
  "mail.read",
  "mail.send",
  "files.read",
  "files.write",
  "commands.run",
];
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dir = dir;
    this.db = new DatabaseSync(join(dir, "agent.sqlite"));
    chmodSync(join(dir, "agent.sqlite"), 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT); CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));`,
    );
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=1").get()
    ) {
      this.db.prepare("INSERT INTO migrations VALUES(1,?)").run(now());
      this.put("settings", "main", {
        mode: "demo",
        endpoint: "https://api.openai.com/v1",
        model: "",
        budget: 12,
        heartbeat: true,
        heartbeatInterval: 60,
      });
      this.put("agents", "coordinator", {
        id: "coordinator",
        name: "路衡",
        role: "任务统筹",
        personality: "沉稳、清晰，先核实再行动",
        permissions: [...permissions],
        enabled: true,
      });
      this.put("agents", "researcher", {
        id: "researcher",
        name: "知行",
        role: "资料研究员",
        personality: "以证据为依据，注明来源与不确定性",
        permissions: ["knowledge.read", "browser.read", "files.read"],
        enabled: true,
      });
      this.put("agents", "writer", {
        id: "writer",
        name: "砚青",
        role: "文稿助手",
        personality: "简洁、正式、条理分明",
        permissions: ["knowledge.read", "workspace.write", "mail.draft", "files.read", "files.write"],
        enabled: true,
      });
      this.put("memories", "demo-maintenance", {
        id: "demo-maintenance",
        title: "演示养护周报台账",
        content:
          "【虚构演示数据】青岚高速本周完成路面巡查12次，发现一般问题3项，已处理2项；剩余1项为K18+200排水沟淤积，计划周五清理。所有地名、桩号和数量均为软件测试样例，不可用于真实决策。",
        source: "系统内置虚构样例 · DEMO-001",
        createdAt: now(),
        version: 1,
      });
      this.put("memories", "demo-rule", {
        id: "demo-rule",
        title: "演示材料处理原则",
        content:
          "本演示要求：工作材料标注来源，未经批准不提交OA、不发送邮件。检查台账后按完成情况、待办、风险、下一步四项整理。此规则是测试流程，不是单位真实规章。",
        source: "系统内置虚构流程 · DEMO-002",
        createdAt: now(),
        version: 1,
      });
      this.put("mail", "demo-mail", {
        id: "demo-mail",
        from: "养护协调组（虚构） <demo@example.invalid>",
        subject: "演示：请汇总本周养护进展",
        body: "请基于演示台账整理周报并列出待协调事项。仅演示收件箱，无真实邮箱连接。",
        demo: true,
        createdAt: now(),
      });
    }
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=2").get()
    ) {
      const coordinator = this.get("agents", "coordinator");
      if (
        coordinator &&
        [
          "knowledge.read",
          "workspace.write",
          "browser.read",
          "browser.write",
          "mail.draft",
        ].every((p) => coordinator.permissions.includes(p))
      ) {
        coordinator.permissions = [
          ...new Set([
            ...coordinator.permissions,
            "agent.delegate",
            "reminder.create",
          ]),
        ];
        this.put("agents", coordinator.id, coordinator);
      }
      this.db.prepare("INSERT INTO migrations VALUES(2,?)").run(now());
    }
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=3").get()
    ) {
      for (const agent of this.all("agents"))
        this.put("agents", agent.id, {
          ...agent,
          modelConfig: agent.modelConfig || { inherit: true },
        });
      for (const memory of this.all("memories"))
        this.put("memories", memory.id, {
          ...memory,
          scope: memory.scope || "workspace",
          ownerAgentId: memory.ownerAgentId || null,
        });
      this.db.prepare("INSERT INTO migrations VALUES(3,?)").run(now());
    }
    if (!this.db.prepare("SELECT version FROM migrations WHERE version=4").get()) {
      // Only unchanged built-in defaults migrate. Never expand custom roles,
      // disabled roles, or a built-in whose owner deliberately removed access.
      const defaults = {
        coordinator: permissions.filter(p => !["files.read", "files.write", "commands.run"].includes(p)),
        researcher: ["knowledge.read", "browser.read"],
        writer: ["knowledge.read", "workspace.write", "mail.draft"],
      };
      for (const [agentId, previous] of Object.entries(defaults)) {
        const agent = this.get("agents", agentId);
        if (!agent?.enabled || !Array.isArray(agent.permissions) ||
            agent.permissions.length !== previous.length ||
            !previous.every(p => agent.permissions.includes(p))) continue;
        const added = agentId === "coordinator" ? ["files.read", "files.write", "commands.run"]
          : agentId === "writer" ? ["files.read", "files.write"] : ["files.read"];
        this.put("agents", agentId, { ...agent, permissions: [...agent.permissions, ...added] });
      }
      this.db.prepare("INSERT INTO migrations VALUES(4,?)").run(now());
    }
  }
  get(kind, id) {
    const r = this.db
      .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(r.payload) : null;
  }
  all(kind) {
    return this.db
      .prepare("SELECT payload FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((r) => JSON.parse(r.payload));
  }
  put(kind, key, value) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
      )
      .run(kind, key, JSON.stringify(value));
    return value;
  }
  delete(kind, key) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, key);
  }
  audit(action, detail, taskId = null) {
    let r = { id: id(), at: now(), action, detail, taskId };
    return this.put("audit", r.id, r);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
