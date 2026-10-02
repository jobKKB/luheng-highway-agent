import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname, basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Store, id, now, permissions } from "./lib/store.mjs";
import { Engine } from "./lib/engine.mjs";
import { BrowserBroker, fixtureHtml } from "./lib/browser.mjs";
import { callModel, validateEndpoint } from "./lib/model.mjs";
import { isWithinDirectory } from "./lib/paths.mjs";
import { RoleCredentialVault } from "./lib/agent-authority.mjs";
import { redactSecrets } from "./lib/redact.mjs";
import { MailService } from "./lib/mail-adapter.mjs";
import { ControlledBrowserService } from "./lib/controlled-browser.mjs";
import { CredentialSnapshots } from "./lib/persisted-credentials.mjs";
import { ScheduleService } from "./lib/schedules.mjs";
import { saveOfficeArtifact } from "./lib/office-artifacts.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
const error = (res, message, status = 400) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
};
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
async function body(req) {
  if (!req.headers["content-type"]?.includes("application/json"))
    throw new Error("请求必须使用JSON格式");
  let chunks = [],
    len = 0;
  for await (const part of req) {
    len += part.length;
    if (len > 100000) throw new Error("请求内容超过100KB");
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new Error("JSON格式无效");
  }
}
export async function startServer({
  port = 4318,
  dataDir = join(root, "data"),
  host = "127.0.0.1",
  desktopToken,
  stepDelay = 220,
  completion,
  mailOptions,
  controlledBrowserOptions,
  desktopBridge,
  persistedCredentials,
  scheduleOptions,
} = {}) {
  if (host !== "127.0.0.1")
    throw new Error("原型仅允许绑定127.0.0.1，不提供公网服务");
  const store = new Store(dataDir);
  const roleKeys = new RoleCredentialVault();
  let apiKey = "",
    keyOrigin = "",
    engine,
    broker,
    baseUrl,
    closed = false,
    schedules;
  const mail = new MailService(store, {
    ...mailOptions,
    getExternalSecrets: () => [apiKey, ...roleKeys.secrets()],
  });
  const controlledBrowser = new ControlledBrowserService(store, {
    dataDir,
    ...controlledBrowserOptions,
    getExternalSecrets: () => [
      apiKey,
      ...roleKeys.secrets(),
      ...mail.getSecrets(),
    ],
  });
  const credentials = new CredentialSnapshots({ store, roleKeys, mail,
    getGlobal: endpoint => !endpoint || new URL(endpoint).origin === keyOrigin ? apiKey : '',
    setGlobal: (secret, endpoint) => { apiKey = secret; keyOrigin = new URL(endpoint).origin; },
  });
  if (persistedCredentials) {
    try {
      const result = credentials.restore(persistedCredentials);
      store.audit('credentials.restored', `从系统加密快照恢复 ${result.restored} 项；配置变化跳过 ${result.skipped} 项`);
    } catch { store.audit('credentials.restore_failed', '保存的凭据无法恢复，请重新录入；未回退到明文保存'); }
  }
  const desktopState = async () => desktopBridge ? {
    available: true, ...(await desktopBridge.preferences()), credentialVault: await desktopBridge.status(),
  } : { available: false, backgroundEnabled: false, trayAvailable: false,
    credentialVault: { available: false, stored: false, backend: 'unavailable', reason: '仅桌面客户端提供系统加密存储。' } };
  const authToken = randomBytes(32).toString("hex"),
    fixtureToken = randomBytes(32).toString("hex");
  const authenticated = (req) =>
    req.headers.cookie
      ?.split(";")
      .some((x) => x.trim() === "luheng_session=" + authToken);
  const apiAuthenticated = (req) =>
    authenticated(req) &&
    (!desktopToken ||
      safeEqual(req.headers["x-highway-desktop-token"], desktopToken));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    const expectedHost = new URL(baseUrl).host;
    if (req.headers.host !== expectedHost)
      return error(res, "无效主机地址", 403);
    let url;
    try {
      url = new URL(req.url, baseUrl);
    } catch {
      return error(res, "无效请求地址", 400);
    }
    const path = url.pathname;
    if (req.headers.origin && req.headers.origin !== baseUrl)
      return error(res, "拒绝跨站请求", 403);
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.headers.origin !== baseUrl
    )
      return error(res, "修改操作必须来自本机客户端同源页面", 403);
    const fixtureAuth =
      authenticated(req) ||
      safeEqual(req.headers["x-fixture-token"], fixtureToken);
    try {
      if (path === "/health")
        return json(res, {
          ok: true,
          name: "路衡办公智能体",
          version: "0.3.0",
          localOnly: true,
        });
      if (path.startsWith("/fixture/")) {
        if (!fixtureAuth) return error(res, "请从客户端打开模拟OA", 401);
        if (req.method === "GET" && path === "/fixture/script.js") {
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          return res.end(readFileSync(join(root, "lib", "fixture-client.js")));
        }
        const session = store.get("sessions", url.searchParams.get("session"));
        if (!session) return error(res, "模拟会话不存在", 404);
        if (req.method === "GET" && path === "/fixture/oa") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          return res.end(fixtureHtml(session));
        }
        if (req.method === "POST" && path === "/fixture/oa/submit") {
          const b = await body(req);
          const automatic = safeEqual(
            req.headers["x-fixture-token"],
            fixtureToken,
          );
          const task = store.get("tasks", session.taskId);
          if (automatic) {
            if (
              !session.writeLease ||
              session.status !== "agent" ||
              task.status !== "running"
            )
              return error(res, "尚未批准，禁止自动写入", 403);
            if (b.title !== session.plannedTitle)
              return error(res, "内容与审批不一致", 403);
          } else if (session.status !== "manual")
            return error(res, "请先在客户端点击接管", 403);
          if (!b.title?.trim() || b.title.length > 300)
            return error(res, "标题须为1至300字符");
          const record = {
            id: id(),
            title: b.title,
            createdAt: now(),
            author: automatic ? "agent-approved" : "manual",
          };
          store.transaction(() => {
            const s = store.get("sessions", session.id);
            if (automatic && !s.writeLease)
              throw new Error("本次写入凭据已使用");
            store.put("sessions", s.id, {
              ...s,
              writeLease: false,
              records: [...s.records, record],
            });
            store.audit(
              "fixture.saved",
              `${automatic ? "审批执行" : "人工保存"}：${b.title}`,
              task.id,
            );
          });
          return json(res, record);
        }
        return error(res, "未找到模拟页面", 404);
      }
      if (path.startsWith("/api/")) {
        if (!apiAuthenticated(req))
          return error(res, "本地会话已失效，请刷新客户端", 401);
        if (req.method === "GET" && path === "/api/state")
          return json(res, {
            tasks: store.all("tasks").map((t) => engine.task(t.id)),
            agents: store
              .all("agents")
              .reverse()
              .map((agent) => ({
                ...agent,
                hasApiKey: roleKeys.has(agent.id),
              })),
            memories: store.all("memories"),
            reminders: store.all("reminders"),
            schedules: schedules.list(),
            scheduleOccurrences: store.all("schedule_occurrences").slice(0, 100),
            desktop: await desktopState(),
            audit: store.all("audit").slice(0, 250),
            approvals: store.all("approvals"),
            settings: {
              ...store.get("settings", "main"),
              hasApiKey: !!apiKey,
              credentialStorage: desktopBridge ? "memory-with-optional-os-encrypted-snapshot" : "memory-only",
            },
            mail: store.all("mail"),
            mailAccounts: mail.getPublicConfig(),
            mailOutbox: store.all("mail_outbox"),
            mailApprovals: store.all("mail_approvals"),
            realInbox: store.all("mail_inbox"),
            browserTargets: controlledBrowser.listTargets(),
            controlledSessions: controlledBrowser.listSessions(),
            browserApprovals: controlledBrowser.listApprovals(),
            notifications: store.all("notifications"),
            system: {
              name: "路衡办公智能体",
              version: "0.3.0",
              platform: process.platform,
              node: process.versions.node,
              localOnly: true,
              browser: "隔离Chromium：内置模拟OA与用户明确配置的目标白名单",
              sandbox:
                "受限工具与工作区；不是操作系统级沙箱；任意代码执行已禁用",
              mail: mail.getPublicConfig().length
                ? "真实邮件适配器已配置；每次发送必须完整审批"
                : "真实IMAP/SMTP适配器尚未配置；演示任务仅本地草稿",
              lastHeartbeat: engine.lastHeartbeat
                ? new Date(engine.lastHeartbeat).toISOString()
                : null,
              capabilities: {
                arbitraryCode: false,
                realMail: true,
                mailAccountsConfigured: mail.getPublicConfig().length,
                realOa: false,
                controlledBrowser: true,
                privateRoleMemory: true,
                perAgentModels: true,
                browserFixture: true,
                apiText: true,
                apiToolLoop: true,
                windowsTested: false,
                recurringSchedules: true,
                officeArtifacts: true,
                desktopCredentialVault: !!desktopBridge,
              },
              dataDirectory: "本机私有数据目录",
              security: "仅环回监听；同源校验；会话Cookie；凭据默认内存，桌面端可明确选择系统加密快照",
            },
          });
        if (req.method === "GET" && path === "/api/schedules") return json(res, schedules.list());
        if (req.method === "POST" && path === "/api/schedules") return json(res, schedules.create(await body(req)), 201);
        let scheduleMatch;
        if (req.method === "PATCH" && (scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)$/)))
          return json(res, schedules.update(scheduleMatch[1], await body(req)));
        if (req.method === "POST" && (scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)\/(pause|resume|cancel)$/))) {
          await body(req);
          return json(res, schedules[scheduleMatch[2]](scheduleMatch[1]));
        }
        if (req.method === "POST" && path === "/api/desktop/preferences") {
          if (!desktopBridge) return error(res, "此功能仅在桌面客户端可用", 409);
          const b = await body(req);
          if (!b || Object.keys(b).length !== 1 || typeof b.backgroundEnabled !== 'boolean') throw new Error('后台运行设置格式无效');
          await desktopBridge.setPreferences(b);
          store.audit('desktop.preferences', b.backgroundEnabled ? '用户选择关闭窗口后在托盘继续运行；未启用开机自启' : '用户选择关闭窗口即退出');
          return json(res, await desktopState());
        }
        if (req.method === "POST" && /^\/api\/desktop\/credentials\/(save|forget)$/.test(path)) {
          if (!desktopBridge) return error(res, "此功能仅在桌面客户端可用", 409);
          const b = await body(req);
          if (!b || b.confirmed !== true || Object.keys(b).length !== 1) throw new Error('请明确确认保存或忘记系统加密凭据快照');
          if (path.endsWith('/save')) {
            const snapshot = credentials.capture();
            if (!snapshot.entries.length) throw new Error('当前运行中没有可保存的凭据');
            await desktopBridge.saveCredentials(snapshot);
            store.audit('credentials.saved', '用户明确保存当前凭据的系统加密快照；后续变更不会自动保存');
          } else {
            await desktopBridge.forgetCredentials();
            store.audit('credentials.forgotten', '用户忘记已保存凭据；本次运行的内存凭据保留至退出或手动清空');
          }
          return json(res, await desktopState());
        }
        if (req.method === "POST" && path === "/api/browser-targets") {
          const b = await body(req);
          const targets=await controlledBrowser.configureTargets(b.targets);
          engine.reconcileControlledSessions();
          return json(res,targets);
        }
        if (req.method === "POST" && path === "/api/controlled-browser/open") {
          const b = await body(req);
          return json(
            res,
            await controlledBrowser.open("manual-" + id(), b.targetId),
          );
        }
        let browserMatch;
        if (
          req.method === "GET" &&
          (browserMatch = path.match(
            /^\/api\/controlled-browser\/([^/]+)\/read$/,
          ))
        ) {
          const observation=await controlledBrowser.read(browserMatch[1]);
          if(observation.cancelled)return json(res,observation);
          const capture=await controlledBrowser.screenshot(browserMatch[1]);
          if(capture?.cancelled)return json(res,capture);
          return json(res,observation);
        }
        if (
          req.method === "GET" &&
          (browserMatch = path.match(
            /^\/api\/controlled-browser\/([^/]+)\/screenshot$/,
          ))
        ) {
          const session = controlledBrowser.getSession(browserMatch[1]);
          const file = join(
            dataDir,
            "controlled-screenshots",
            session.id + ".png",
          );
          if (!existsSync(file)) return error(res, "暂无浏览器截图", 404);
          res.setHeader("Content-Type", "image/png");
          return res.end(readFileSync(file));
        }
        if (
          req.method === "POST" &&
          (browserMatch = path.match(
            /^\/api\/controlled-browser\/([^/]+)\/(propose|takeover|manual|resume|cancel)$/,
          ))
        ) {
          const b = await body(req),
            sessionId = browserMatch[1],
            action = browserMatch[2];
          if (action === "propose")
            return json(
              res,
              await controlledBrowser.proposeActions(sessionId, b),
            );
          if (action === "takeover")
            return json(res, await controlledBrowser.takeover(sessionId));
          if (action === "manual")
            return json(
              res,
              await controlledBrowser.manualAction(sessionId, b),
            );
          if (action === "resume") {
            const result = await controlledBrowser.resume(sessionId, b);
            if(!result.cancelled&&result.observation)engine.controlledResumed?.(sessionId, result.observation);
            return json(res, result);
          }
          const session = controlledBrowser.getSession(sessionId);
          if (store.get("tasks", session.taskId)) engine.cancel(session.taskId);
          return json(res, await controlledBrowser.cancel(sessionId));
        }
        if (
          req.method === "POST" &&
          (browserMatch = path.match(/^\/api\/browser-approvals\/([^/]+)$/))
        ) {
          const b = await body(req);
          const central = store
            .all("approvals")
            .find((a) => a.controlledApprovalId === browserMatch[1]);
          if (central) {
            if (b.digest !== central.digest)
              throw new Error("审批内容摘要不一致");
            await engine.decide(central.id, b.decision);
            return json(res, {
              approval: controlledBrowser
                .listApprovals()
                .find((a) => a.id === browserMatch[1]),
            });
          }
          return json(res, await controlledBrowser.decide(browserMatch[1], b));
        }
        if (req.method === "POST" && path === "/api/mail/config")
          return json(res, await mail.configure(await body(req)));
        if (req.method === "POST" && path === "/api/mail/inbox")
          return json(res, await mail.readInbox(await body(req)));
        if (req.method === "POST" && path === "/api/mail/drafts") {
          const b = await body(req);
          const content = JSON.stringify(b);
          if (
            [apiKey, ...roleKeys.secrets(), ...mail.getSecrets()]
              .filter(Boolean)
              .some((secret) => content.includes(secret))
          )
            throw new Error("邮件内容疑似包含凭据，已阻止保存");
          return json(res, mail.createDraft(b), 201);
        }
        let mailMatch;
        if (
          req.method === "PUT" &&
          (mailMatch = path.match(/^\/api\/mail\/drafts\/([^/]+)$/))
        ) {
          const b = await body(req);
          if (
            [apiKey, ...roleKeys.secrets(), ...mail.getSecrets()]
              .filter(Boolean)
              .some((secret) => JSON.stringify(b).includes(secret))
          )
            throw new Error("邮件内容疑似包含凭据，已阻止修改");
          const updated = mail.updateDraft(mailMatch[1], b);
          engine.mailDraftEdited(updated);
          return json(res, updated);
        }
        if (
          req.method === "POST" &&
          (mailMatch = path.match(
            /^\/api\/mail\/drafts\/([^/]+)\/request-send$/,
          ))
        ) {
          await body(req);
          const approval = mail.requestSend(mailMatch[1]);
          engine.linkMailApproval(approval);
          return json(res, approval);
        }
        if (
          req.method === "POST" &&
          (mailMatch = path.match(/^\/api\/mail\/drafts\/([^/]+)\/cancel$/))
        ) {
          await body(req);
          const out = mail.getOutbox(mailMatch[1]);
          if (out?.taskId) engine.cancel(out.taskId);
          return json(res, await mail.cancelSend(mailMatch[1]));
        }
        if (
          req.method === "POST" &&
          (mailMatch = path.match(/^\/api\/mail\/approvals\/([^/]+)$/))
        ) {
          const b = await body(req);
          const central = store
            .all("approvals")
            .find((a) => a.serviceApprovalId === mailMatch[1]);
          if (central) {
            await engine.decide(central.id, b.decision);
            const approval = mail.getApproval(mailMatch[1]);
            return json(res, mail.getOutbox(approval.draftId));
          }
          return json(res, await mail.decideSend(mailMatch[1], b.decision));
        }
        if (req.method === "POST" && path === "/api/tasks")
          return json(res, engine.create(await body(req)), 201);
        let m;
        if (
          req.method === "GET" &&
          (m = path.match(/^\/api\/tasks\/([^/]+)$/))
        ) {
          const task = engine.task(m[1]);
          return task ? json(res, task) : error(res, "任务不存在", 404);
        }
        if (req.method === "POST" && (m = path.match(/^\/api\/tasks\/([^/]+)\/export$/))) {
          const b = await body(req);
          if (!b || Object.keys(b).length !== 1 || !['docx','xlsx'].includes(b.format)) throw new Error('请选择 DOCX 或 XLSX 文件格式');
          const task = store.get('tasks', m[1]);
          if (!task) return error(res, '任务不存在', 404);
          if (task.status !== 'completed') throw new Error('仅可导出已完成任务');
          const agent = store.get('agents', task.agentId);
          if (!agent?.enabled || !agent.permissions.includes('workspace.write')) throw new Error('执行角色未获 workspace.write 权限');
          const existing = (task.exports || []).find(a => a.format === b.format);
          if (existing && existsSync(join(dataDir, 'artifacts', existing.filename))) return json(res, existing);
          const filename = `${task.id}-office.${b.format}`;
          const artifact = await saveOfficeArtifact({ directory: join(dataDir, 'artifacts'), filename, format: b.format, data: {
            title: task.title, period: task.createdAt.slice(0,10), author: agent.name,
            summary: task.output || '任务未产生正文，请核对执行记录。', demo: task.mode === 'demo',
            rows: task.steps.map((step, index) => ({ id: String(index + 1), task: step.name, status: step.status,
              owner: agent.name, notes: step.detail || '', source: `任务 ${task.id}` })),
            sources: (task.sources || []).map(source => typeof source === 'string' ? source : [source.title, source.source, source.id].filter(Boolean).join(' · ')),
            risks: ['本文件整理已完成任务的结果与执行记录；生成文件不代表材料已被人工审核。'],
            nextSteps: ['核对内容与来源后，按单位流程使用或分发。'],
          }});
          const result = { ...artifact, format: b.format, url: '/api/artifacts/' + encodeURIComponent(filename) };
          store.put('tasks', task.id, { ...task, exports: [...(task.exports || []).filter(a => a.format !== b.format), result] });
          store.audit('artifact.exported', `生成 ${b.format.toUpperCase()} 文件`, task.id);
          return json(res, result, 201);
        }
        if (
          req.method === "POST" &&
          (m = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/))
        ) {
          await body(req);
          return json(res, engine.cancel(m[1]));
        }
        if (
          req.method === "POST" &&
          (m = path.match(/^\/api\/approvals\/([^/]+)$/))
        ) {
          const b = await body(req);
          return json(res, await engine.decide(m[1], b.decision));
        }
        if (
          (req.method === "POST" && path === "/api/agents") ||
          (req.method === "PUT" && (m = path.match(/^\/api\/agents\/([^/]+)$/)))
        ) {
          const b = await body(req);
          if (
            !b.name?.trim() ||
            b.name.length > 40 ||
            !b.role?.trim() ||
            b.role.length > 100 ||
            typeof b.personality !== "string" ||
            b.personality.length > 1000
          )
            throw new Error("请填写名称、角色与性格，且勿超过长度限制");
          if (
            !Array.isArray(b.permissions) ||
            b.permissions.some((p) => !permissions.includes(p))
          )
            throw new Error("包含不支持的权限");
          const agentId = m?.[1] || id();
          const existing = store.get("agents", agentId);
          if (req.method === "PUT" && !existing)
            return error(res, "智能体不存在", 404);
          let modelConfig =
            b.modelConfig === undefined
              ? existing?.modelConfig || { inherit: true }
              : b.modelConfig;
          if (
            !modelConfig ||
            typeof modelConfig !== "object" ||
            typeof modelConfig.inherit !== "boolean"
          )
            throw new Error("模型配置须明确继承全局或独立配置");
          if (modelConfig.inherit === false) {
            if (
              typeof modelConfig.endpoint !== "string" ||
              typeof modelConfig.model !== "string" ||
              !modelConfig.model.trim() ||
              modelConfig.model.length > 200
            )
              throw new Error("独立模型需填写有效接口与模型名称");
            const endpoint = await validateEndpoint(modelConfig.endpoint);
            modelConfig = {
              inherit: false,
              endpoint,
              model: modelConfig.model.trim(),
            };
          } else modelConfig = { inherit: true };
          if (
            b.apiKey !== undefined &&
            (typeof b.apiKey !== "string" || b.apiKey.length > 1000)
          )
            throw new Error("智能体Key格式无效");
          if (
            modelConfig.inherit ||
            (existing?.modelConfig?.endpoint &&
              new URL(existing.modelConfig.endpoint).origin !==
                new URL(modelConfig.endpoint).origin)
          )
            roleKeys.clear(agentId);
          if (b.clearApiKey === true) roleKeys.clear(agentId);
          if (!modelConfig.inherit && b.apiKey?.trim())
            roleKeys.set(agentId, modelConfig.endpoint, b.apiKey.trim());
          const agent = {
            id: agentId,
            modelConfig,
            name: b.name.trim(),
            role: b.role.trim(),
            personality: b.personality,
            permissions: [...new Set(b.permissions)],
            enabled: b.enabled !== false,
          };
          if (req.method === "PUT" && !store.get("agents", agent.id))
            return error(res, "智能体不存在", 404);
          store.put("agents", agent.id, agent);
          store.audit(
            "agent.updated",
            `配置智能体 ${agent.name}；权限：${agent.permissions.join(", ")}`,
          );
          return json(res, { ...agent, hasApiKey: roleKeys.has(agent.id) });
        }
        if (req.method === "POST" && path === "/api/memories") {
          const b = await body(req);
          if (
            !b.title?.trim() ||
            b.title.length > 150 ||
            !b.content?.trim() ||
            b.content.length > 20000 ||
            !b.source?.trim() ||
            b.source.length > 500
          )
            throw new Error("请填写有效标题、内容和来源");
          const scope = b.scope || "workspace";
          if (!["workspace", "agent"].includes(scope))
            throw new Error("知识范围无效");
          const ownerAgentId = scope === "agent" ? b.ownerAgentId : null;
          if (scope === "agent" && !store.get("agents", ownerAgentId))
            throw new Error("请选择此私有知识的所属智能体");
          const memory = {
            id: id(),
            scope,
            ownerAgentId,
            title: b.title.trim(),
            content: b.content.trim(),
            source: b.source.trim(),
            createdAt: now(),
            version: 1,
          };
          store.put("memories", memory.id, memory);
          store.audit(
            "memory.created",
            `保存知识：${memory.title}；来源：${memory.source}`,
          );
          return json(res, memory, 201);
        }
        if (req.method === "POST" && path === "/api/reminders")
          return json(res, engine.addReminder(await body(req)), 201);
        if (req.method === "POST" && path === "/api/settings") {
          const b = await body(req),
            old = store.get("settings", "main");
          if (!["demo", "api"].includes(b.mode))
            throw new Error("模式须为demo或api");
          if (typeof b.endpoint !== "string" || b.endpoint.length > 500)
            throw new Error("API地址无效");
          if (b.mode === "api") await validateEndpoint(b.endpoint);
          else if (b.endpoint && !/^https:\/\//.test(b.endpoint))
            throw new Error("API地址须为HTTPS");
          if (typeof b.model !== "string" || b.model.length > 200)
            throw new Error("模型名称无效");
          if (
            b.apiKey !== undefined &&
            (typeof b.apiKey !== "string" || b.apiKey.length > 1000)
          )
            throw new Error("密钥格式无效");
          const endpointOrigin = new URL(b.endpoint).origin;
          if (keyOrigin && keyOrigin !== endpointOrigin) {
            apiKey = "";
            keyOrigin = "";
          }
          if (typeof b.apiKey === "string" && b.apiKey.trim()) {
            apiKey = b.apiKey.trim();
            keyOrigin = endpointOrigin;
          }
          if (b.clearApiKey === true) {
            apiKey = "";
            keyOrigin = "";
          }
          const settings = {
            ...old,
            mode: b.mode,
            endpoint: b.endpoint.replace(/\/$/, ""),
            model: b.model.trim(),
            budget: Math.max(
              1,
              Math.min(100, Math.floor(Number(b.budget) || 12)),
            ),
          };
          store.put("settings", "main", settings);
          store.audit(
            "settings.updated",
            `运行模式 ${settings.mode}；密钥仅内存 ${apiKey ? "已设置" : "未设置"}`,
          );
          return json(res, {
            ...settings,
            hasApiKey: !!apiKey,
            credentialStorage: "memory-only",
          });
        }
        if (req.method === "POST" && path === "/api/settings/test") {
          await body(req);
          const s = store.get("settings", "main");
          if (s.mode === "demo")
            return json(res, {
              ok: true,
              message:
                "演示模式无需API；确定性规则引擎可用。没有连接真实大模型。",
            });
          const out = await callModel({
            endpoint: s.endpoint,
            model: s.model,
            key: apiKey,
            messages: [{ role: "user", content: "请只回答：连接成功。" }],
          });
          store.audit("model.connection.test", "真实模型连接测试成功");
          return json(res, {
            ok: true,
            message: redactSecrets(out.content, [
              apiKey,
              ...roleKeys.secrets(),
              ...mail.getSecrets(),
            ]),
          });
        }
        if (req.method === "POST" && path === "/api/heartbeat") {
          const b = await body(req);
          const s = store.get("settings", "main");
          store.put("settings", "main", {
            ...s,
            heartbeat: b.enabled === true,
          });
          store.audit(
            "heartbeat.updated",
            b.enabled ? "已启用本机提醒检查" : "已暂停本机提醒检查",
          );
          return json(res, { enabled: b.enabled === true });
        }
        if (
          req.method === "POST" &&
          (m = path.match(/^\/api\/browser\/([^/]+)\/(takeover|resume)$/))
        ) {
          await body(req);
          const session = store.get("sessions", m[1]);
          if (!session) return error(res, "会话不存在", 404);
          const task = store.get("tasks", session.taskId);
          if (task.status !== "awaiting_approval")
            throw new Error("只能接管等待审批的会话");
          return json(res, await broker[m[2]](m[1]));
        }
        if (
          req.method === "GET" &&
          (m = path.match(/^\/api\/browser\/([^/]+)\/screenshot$/))
        ) {
          const s = store.get("sessions", m[1]);
          if (!s) return error(res, "会话不存在", 404);
          const file = join(dataDir, "screenshots", s.id + ".png");
          if (!existsSync(file)) return error(res, "暂无浏览器截图", 404);
          res.setHeader("Content-Type", "image/png");
          return res.end(readFileSync(file));
        }
        if (
          req.method === "GET" &&
          (m = path.match(/^\/api\/artifacts\/(.+)$/))
        ) {
          const filename = decodeURIComponent(m[1]);
          if (basename(filename) !== filename || filename.includes(".."))
            return error(res, "文件名无效", 403);
          const artifact = store.all("tasks").flatMap(t => [t.artifact, ...(t.exports || [])]).find(a => a?.filename === filename);
          if (!artifact) return error(res, "文件不存在", 404);
          const file = join(dataDir, "artifacts", filename);
          res.setHeader("Content-Type", artifact.mimeType || "text/plain; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" +
              encodeURIComponent(artifact.name),
          );
          return res.end(readFileSync(file));
        }
        return error(res, "接口不存在", 404);
      }
      if (req.method !== "GET") return error(res, "不支持的方法", 405);
      if (path === "/" || path === "/index.html")
        res.setHeader(
          "Set-Cookie",
          `luheng_session=${authToken}; HttpOnly; SameSite=Strict; Path=/`,
        );
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'",
      );
      const decoded = decodeURIComponent(path);
      const file = resolve(
        root,
        "public",
        decoded === "/" ? "index.html" : "." + decoded,
      );
      if (!isWithinDirectory(join(root, "public"), file))
        return error(res, "禁止访问", 403);
      if (!existsSync(file) || !statSync(file).isFile())
        return error(res, "页面不存在", 404);
      res.setHeader(
        "Content-Type",
        MIME[extname(file)] || "application/octet-stream",
      );
      return res.end(readFileSync(file));
    } catch (e) {
      if (!res.headersSent) error(res, e.message || "处理请求失败");
      else res.end();
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });
  port = server.address().port;
  baseUrl = `http://${host}:${port}`;
  broker = new BrowserBroker(store, { baseUrl, fixtureToken });
  engine = new Engine(store, broker, {
    getKey: (endpoint, credentialAgentId) =>
      credentialAgentId
        ? roleKeys.get(endpoint, credentialAgentId)
        : !endpoint || new URL(endpoint).origin === keyOrigin
          ? apiKey
          : "",
    getSecrets: () => [apiKey, ...roleKeys.secrets(), ...mail.getSecrets()],
    mailService: mail,
    controlledBrowser,
    delay: stepDelay,
    completion,
  });
  schedules = new ScheduleService(store, engine, scheduleOptions);
  schedules.tick();
  store.audit("system.started", "本机服务启动；仅环回地址，未开放任意代码执行");
  engine.tick();
  return {
    server,
    port,
    store,
    engine,
    broker,
    mail,
    controlledBrowser,
    schedules,
    url: baseUrl,
    async close() {
      if (closed) return;
      closed = true;
      apiKey = "";
      roleKeys.clearAll();
      schedules.close();
      await engine.close();
      await mail.close();
      await controlledBrowser.close();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const index = process.argv.indexOf("--port");
  const port =
    index >= 0
      ? Number(process.argv[index + 1])
      : Number(process.env.PORT || 4318);
  const app = await startServer({
    port,
    dataDir: process.env.HIGHWAY_DATA_DIR || join(root, "data"),
  });
  console.log(`路衡办公智能体 v0.3.0 已启动：${app.url} （仅本机）`);
  process.on("SIGINT", async () => {
    await app.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });
}
