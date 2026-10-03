import { ToolInputError } from "./runtime-errors.mjs";

export class ToolAvailabilityError extends Error {
  constructor(message, code = "TOOL_UNAVAILABLE") { super(message); this.name = "ToolAvailabilityError"; this.code = code; }
}

// One registration owns the schema, handler, role permission, availability check
// and result budget. Listing capabilities never contacts an external service.
export class ToolRegistry {
  #tools = new Map();
  register({ name, label = name, schema, permission = null, handler, check = () => ({}), resultCap = 100000 }) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name) || this.#tools.has(name))
      throw new Error("工具注册名称无效或重复");
    if (schema && schema.function?.name !== name) throw new Error("工具schema名称与注册不一致");
    if (!Number.isSafeInteger(resultCap) || resultCap < 100 || resultCap > 500000) throw new Error("工具结果预算无效");
    this.#tools.set(name, { name, label, schema, permission, handler, check, resultCap });
    return this;
  }
  get(name) { return this.#tools.get(name); }
  capability(name, context = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolAvailabilityError("模型请求了未开放的工具", "TOOL_UNKNOWN");
    const implemented = typeof tool.handler === "function" && !!tool.schema;
    const actor = context.actor;
    const granted = !!actor?.enabled && (!tool.permission || actor.permissions?.includes(tool.permission));
    const checked = implemented ? tool.check(context) || {} : {};
    const dependencies = { ready: true, reason: null, ...(checked.dependencies || {}) };
    const restrictions = checked.restrictions || null;
    const network = { status: "unknown", lastCheckedAt: null, code: null, ...(checked.network || {}) };
    const status = !implemented ? "unimplemented" : !granted || restrictions ? "restricted" : !dependencies.ready ? "unconfigured" : "available";
    const reason = !implemented ? checked.reason || "尚无可调用实现" : !granted
      ? !actor?.enabled ? "执行角色已停用或不存在" : "执行角色未获 " + tool.permission
      : restrictions || (!dependencies.ready ? dependencies.reason : checked.reason) || null;
    return { name, label: tool.label, status, implementation: { implemented },
      permission: { name: tool.permission, granted, reason: granted ? null : reason }, dependencies, network, reason };
  }
  capabilities(context) { return { version: 1, tools: [...this.#tools.keys()].map(name => this.capability(name, context)) }; }
  definitions(context) { return [...this.#tools.values()].filter(tool => this.capability(tool.name, context).status === "available").map(tool => tool.schema); }
  assertAvailable(name, context) {
    const capability = this.capability(name, context);
    if (capability.status !== "available") throw new ToolAvailabilityError(capability.reason || "工具当前不可用", "TOOL_" + capability.status.toUpperCase());
    return this.#tools.get(name);
  }
  async execute(name, args, context) {
    // Call-time checks are deliberately independent of the planner's earlier
    // schema snapshot. A permission/configuration revocation is a hard stop.
    const tool = this.assertAvailable(name, context);
    validateToolArguments(args, tool.schema.function.parameters);
    const result = await tool.handler(args, context);
    const serialized = JSON.stringify(result);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > tool.resultCap)
      throw new ToolAvailabilityError("工具结果超出注册的输出预算", "TOOL_RESULT_LIMIT");
    return result;
  }
}

export function validateToolArguments(value, schema, path = "工具参数") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolInputError(path + "类型无效");
    for (const key of schema.required || []) if (!Object.hasOwn(value, key) || value[key] === undefined ||
      typeof value[key] === "string" && !value[key].trim() && schema.properties[key]?.minLength !== 0)
      throw new ToolInputError(path + "缺少必填参数：" + key);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) throw new ToolInputError("工具参数未获允许");
      validateToolArguments(value[key], schema.properties[key], path + "." + key);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 100))
      throw new ToolInputError(path + "数组类型或长度无效");
    value.forEach((item, index) => validateToolArguments(item, schema.items, path + "[" + index + "]"));
  } else {
    if (typeof value !== schema.type || schema.enum && !schema.enum.includes(value)) throw new ToolInputError(path + "类型无效");
    if (schema.type === "number" && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum ||
      schema.maximum !== undefined && value > schema.maximum || schema.multipleOf && value % schema.multipleOf !== 0)) throw new ToolInputError(path + "数值无效");
    if (schema.type === "string" && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 100000)))
      throw new ToolInputError(path + "文字长度超出限制");
  }
}
