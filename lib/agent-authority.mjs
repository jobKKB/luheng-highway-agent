/** Local role isolation: the owning user can manage all records, model contexts cannot. */
export function canReadMemory(record, agentId) {
  return (
    !record.scope ||
    record.scope === "workspace" ||
    (record.scope === "agent" && record.ownerAgentId === agentId)
  );
}
export function visibleMemories(store, ...agentIds) {
  return store
    .all("memories")
    .filter((record) => agentIds.every((id) => canReadMemory(record, id)));
}
export function effectiveModelConfig(store, agentId) {
  const agent = store.get("agents", agentId);
  if (!agent) throw new Error("智能体不存在");
  if (agent.modelConfig?.inherit === false)
    return {
      endpoint: agent.modelConfig.endpoint,
      model: agent.modelConfig.model,
      credentialAgentId: agentId,
    };
  const main = store.get("settings", "main");
  return {
    endpoint: main.endpoint,
    model: main.model,
    credentialAgentId: null,
  };
}
export class RoleCredentialVault {
  constructor() {
    this.values = new Map();
  }
  set(agentId, endpoint, key) {
    if (!key) {
      this.values.delete(agentId);
      return;
    }
    this.values.set(agentId, { origin: new URL(endpoint).origin, key });
  }
  get(endpoint, agentId) {
    const entry = this.values.get(agentId);
    return entry && entry.origin === new URL(endpoint).origin ? entry.key : "";
  }
  has(agentId) {
    return this.values.has(agentId);
  }
  clear(agentId) {
    this.values.delete(agentId);
  }
  secrets() {
    return [...this.values.values()].map((entry) => entry.key);
  }
  clearAll() {
    this.values.clear();
  }
}
