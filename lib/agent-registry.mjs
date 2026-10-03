import { AGENT_TOOLS } from "./agent-tools.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
const permissions = {
  public_web_search: "web.read", public_web_extract: "web.read", agent_finish: null,
  knowledge_search: "knowledge.read", workspace_save: "workspace.write", agent_delegate: "agent.delegate", reminder_create: "reminder.create",
  browser_read: "browser.read", browser_submit: "browser.write", browser_open_target: "browser.read", browser_observe: "browser.read", browser_propose_actions: "browser.write",
  mail_draft: "mail.draft", mail_read_inbox: "mail.read", mail_create_draft: "mail.draft", mail_request_send: "mail.send",
  local_list_files: "files.read", local_read_file: "files.read", local_write_file: "files.write", local_run_command: "commands.run",
};
const labels = { public_web_search: "公网搜索", public_web_extract: "公开网页正文", agent_finish: "核验任务完成", knowledge_search: "知识检索", workspace_save: "保存工作区文件",
  agent_delegate: "角色只读委派", reminder_create: "本机一次提醒", browser_open_target: "打开已授权网页", browser_observe: "观察本任务网页", browser_propose_actions: "网页动作审批",
  mail_read_inbox: "读取已配置邮箱", mail_create_draft: "创建真实账户草稿", mail_request_send: "邮件发送审批", local_list_files: "列出授权文件", local_read_file: "读取授权文件", local_write_file: "写入授权文件", local_run_command: "授权本机命令" };
const demos = new Set(["browser_read", "browser_submit", "mail_draft"]);
const unavailable = reason => ({ dependencies: { ready: false, reason } });
export function createAgentToolRegistry(engine) {
  const registry = new ToolRegistry();
  for (const schema of AGENT_TOOLS) {
    const name = schema.function.name;
    registry.register({ name, label: labels[name] || name, schema: demos.has(name) ? null : schema, permission: permissions[name],
      resultCap: name.startsWith("public_web_") ? 100000 : 500000,
      handler: demos.has(name) ? undefined : (args, { task, signal }) => engine.executeAgentToolImplementation(task, name, args, signal),
      check: ({ task, actor }) => {
        if (name.startsWith("public_web_")) {
          const observation = engine.publicWeb?.networkState(name === "public_web_search" ? "exa-mcp" : "public-https") || {};
          const connectivity = observation.status === "available" || ["WEB_RATE_LIMITED", "WEB_PROVIDER_FAILURE", "WEB_RESPONSE_INVALID", "WEB_RESPONSE_TOO_LARGE", "WEB_CONTENT_UNSUPPORTED", "WEB_REDIRECT_LIMIT"].includes(observation.code)
            ? "reachable" : ["WEB_DNS_UNAVAILABLE", "WEB_NETWORK", "WEB_PROXY_CONFIG"].includes(observation.code) ? "unreachable" : "unknown";
          const network = { status: connectivity, lastCheckedAt: observation.observedAt || null, code: observation.code || null,
            serviceStatus: observation.status || "unobserved" };
          const reason = connectivity === "unknown" ? "当前环境网络可达性尚未验证" : observation.status === "unavailable" ? "最近调用未取得可用结果；可检查具体诊断后重试" : null;
          return { network, reason, dependencies: { ready: !!engine.publicWeb, reason: engine.publicWeb ? null : "公网工具服务未加载" },
            restrictions: task?.nonPublicContext ? "任务已读取非公开资料，禁止自动外传到公开检索；请另开任务提供公开关键词" : null };
        }
        if (name.startsWith("local_")) {
          if (!engine.localAccess) return unavailable("本机访问服务未加载");
          const policy = engine.localAccess.state();
          return { dependencies: { ready: true, reason: null }, restrictions: policy.mode === "disabled" ? "用户未开启本机访问" :
            name === "local_run_command" && !["confirm", "full"].includes(policy.mode) || name === "local_write_file" && policy.mode === "read_only" ? "当前本机访问模式仅允许读取" : null };
        }
        if (name === "mail_read_inbox" || name === "mail_create_draft" || name === "mail_request_send") {
          if (!engine.mail) return unavailable("真实邮件适配器未加载");
          const protocol = name === "mail_read_inbox" ? "imap" : "smtp";
          const configs = engine.mail.getPublicConfig().filter(config => config[protocol] && config.hasCredentials?.[protocol]);
          if (!configs.length) return unavailable("尚无包含本次运行凭据的 " + protocol.toUpperCase() + " 账户");
          if (name === "mail_request_send" && !task?.mailDraftId) return unavailable("当前任务尚未创建邮件草稿");
        }
        if (name.startsWith("browser_")) {
          if (!engine.controlledBrowser) return unavailable("受控浏览器服务未加载");
          if (!engine.controlledBrowser.listTargets().some(target => target.enabled)) return unavailable("尚未配置启用的浏览器目标");
          if (name !== "browser_open_target" && !task?.controlledSessionId) return unavailable("当前任务尚未打开浏览器会话");
        }
        if (name === "agent_delegate" && !engine.store.all("agents").some(other => other.id !== actor.id && other.enabled && other.permissions.includes("knowledge.read")))
          return unavailable("没有具备共同知识权限的可委派角色");
        return {};
      } });
  }
  // Explicitly distinguish missing agent tools from UI/API-only capabilities.
  for (const [name, label, permission] of [["schedule_create", "周期任务工具（现有日程界面/API）", "reminder.create"],
    ["memory_write", "智能体持久记忆写入", "knowledge.read"], ["os_sandbox", "操作系统级命令沙箱", "commands.run"]])
    registry.register({ name, label, permission });
  return registry;
}
