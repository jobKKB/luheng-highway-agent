import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname, basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { Store, id, now, permissions } from "./lib/store.mjs";
import { Engine } from "./lib/engine.mjs";
import { BrowserBroker } from "./lib/browser.mjs";
import { callModel, validateEndpoint, modelErrorDiagnostic } from "./lib/model.mjs";
import { isWithinDirectory } from "./lib/paths.mjs";
import { RoleCredentialVault } from "./lib/agent-authority.mjs";
import { redactSecrets } from "./lib/redact.mjs";
import { MailService } from "./lib/mail-adapter.mjs";
import { ControlledBrowserService } from "./lib/controlled-browser.mjs";
import { CredentialSnapshots } from "./lib/persisted-credentials.mjs";
import { ScheduleService } from "./lib/schedules.mjs";
import { saveOfficeArtifact } from "./lib/office-artifacts.mjs";
import { LocalAccessService } from "./lib/local-access.mjs";
import { SkillsService } from "./lib/skills.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const applicationVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
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
async function body(req, maxBytes = 100000) {
  if (!req.headers["content-type"]?.includes("application/json"))
    throw new Error("请求必须使用JSON格式");
  let chunks = [],
    len = 0;
  for await (const part of req) {
    len += part.length;
    if (len > maxBytes) throw new Error("请求内容超过允许的大小");
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new Error("JSON格式无效");
  }
}
async function objectBody(req, allowed, maxBytes = 100000) {
  const value = await body(req, maxBytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求内容必须为JSON对象");
  if (allowed && Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error("请求包含未获允许的字段");
  return value;
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
  localAccessOptions,
  publicWebService,
} = {}) {
  if (host !== "127.0.0.1")
    throw new Error("原型仅允许绑定127.0.0.1，不提供公网服务");
  const store = new Store(dataDir);
  const skills = new SkillsService(store);
  const roleKeys = new RoleCredentialVault();
  let apiKey = "",
    keyOrigin = "",
    engine,
    broker,
    baseUrl,
    closed = false,
    updateGate = false,
    inflightMutations = 0,
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
  const localAccess = new LocalAccessService(store, {
    ...localAccessOptions,
    protectedPaths: [root, dataDir, ...(localAccessOptions?.protectedPaths || [])],
    getSecrets: () => [apiKey, ...roleKeys.secrets(), ...mail.getSecrets()],
  });
  const localAccessState = () => ({ ...localAccess.state(),
    pickerAvailable: typeof desktopBridge?.selectFolders === "function" });
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
  const authToken = randomBytes(32).toString("hex");
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
    let mutationClaimed = false;
    try {
      if (path === "/health")
        return json(res, {
          ok: true,
          name: "路衡办公智能体",
          version: applicationVersion,
          localOnly: true,
        });
      if (path.startsWith("/fixture/")) return error(res, "内置演示页面已移除", 404);
      if (path.startsWith("/api/")) {
        if (!apiAuthenticated(req))
          return error(res, "本地会话已失效，请刷新客户端", 401);
        // The renderer can only address the main-owned updater through these
        // fixed RPC methods. No paths, URLs, flags or claimed approvals cross it.
        const updateRoute = path.match(/^\/api\/desktop\/update(?:\/(check|download|cancel|install))?$/);
        if (updateRoute) {
          if (url.search) throw new Error("更新接口不接受查询参数");
          const command = updateRoute[1];
          if (!command && req.method === "GET") {
            if (typeof desktopBridge?.updateStatus !== "function") return json(res, {
              supported: false, currentVersion: applicationVersion, channel: "stable", phase: "unsupported",
              reason: "客户端内更新仅支持已打包的 Windows x64 当前用户安装；Mac 与网页模式暂不支持。",
            });
            try { return json(res, await desktopBridge.updateStatus()); }
            catch { return error(res, "更新状态暂不可用，请稍后重试", 503); }
          }
          if (!command || req.method !== "POST") return error(res, "更新接口不存在", 404);
          const candidateCommand = ["download", "install"].includes(command);
          const input = await objectBody(req, candidateCommand ? ["candidateId"] : command === "check" ? ["channel"] : [], 256);
          if (command === "check" && Object.hasOwn(input, "channel") &&
              !["stable", "preview"].includes(input.channel))
            throw new Error("更新渠道无效，只可选择正式版或测试版");
          if (candidateCommand && (Object.keys(input).length !== 1 ||
              typeof input.candidateId !== "string" || !/^[a-f0-9]{32}$/.test(input.candidateId)))
            throw new Error("更新候选标识无效，请重新检查更新");
          const method = { check: "checkUpdate", download: "downloadUpdate", cancel: "cancelUpdate", install: "installUpdate" }[command];
          if (typeof desktopBridge?.[method] !== "function" || typeof desktopBridge?.updateStatus !== "function")
            return error(res, "此更新功能仅在受支持的 Windows 桌面客户端可用", 409);
          try {
            if ((await desktopBridge.updateStatus()).supported !== true)
              return error(res, "当前安装不支持客户端内更新；请使用官方安装包手动更新", 409);
            // Install is only a request: main still requires native confirmation
            // and obtains this backend's atomic readiness gate itself.
            return json(res, await (candidateCommand || command === "check" ? desktopBridge[method](input) : desktopBridge[method]()));
          } catch { return error(res, "更新操作暂不可用，请检查状态后重试", 503); }
        }
        // Claim synchronously, before parsing a body or awaiting anything. A
        // partially received mutation is busy too and cannot race installation.
        // These GETs reconcile/expire state or perform browser observation writes.
        const mutatesBackend = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ||
          req.method === "GET" && (["/api/state", "/api/local-access/state", "/api/tools/capabilities"].includes(path) ||
            /^\/api\/controlled-browser\/[^/]+\/read$/.test(path));
        if (closed || updateGate && mutatesBackend)
          return error(res, "正在准备安装更新，请等待或取消更新后再操作", 409);
        if (mutatesBackend) { inflightMutations++; mutationClaimed = true; }
        if (req.method === "GET" && path === "/api/tools/capabilities") return json(res, engine.capabilities(new URL(req.url, "http://127.0.0.1").searchParams.get("agentId") || "coordinator"));
        if (path.startsWith("/api/browser/")) return error(res, "旧版模拟浏览器已移除，请配置真实网页目标", 410);
        if (req.method === "GET" && path === "/api/state") {
          engine.reconcileLocalAccess();
          return json(res, {
            capabilities: engine.capabilities(),
            tasks: store.all("tasks").map((t) => t.localContext ? t : engine.task(t.id)),
            agents: store
              .all("agents")
              .reverse()
              .map((agent) => ({
                ...agent,
                hasApiKey: roleKeys.has(agent.id),
              })),
            skills: skills.list(),
            seedArchiveCount: store.all("seed_archive").length,
            memories: store.all("memories"),
            reminders: store.all("reminders"),
            schedules: schedules.list(),
            scheduleOccurrences: store.all("schedule_occurrences").slice(0, 100),
            desktop: await desktopState(),
            audit: store.all("audit").slice(0, 250),
            approvals: store.all("approvals"),
            localAccess: { ...localAccessState(), pending: localAccessState().pending.map(({ snapshot, ...metadata }) => metadata), summariesOnly: true },
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
              version: applicationVersion,
              platform: process.platform,
              node: process.versions.node,
              localOnly: true,
              browser: "隔离Chromium：仅用户明确配置的真实网页目标白名单",
              sandbox:
                "应用层本地授权与角色权限；不是操作系统级沙箱。本机命令使用当前账户权限，目录范围不能隔离进程行为",
              mail: mail.getPublicConfig().length
                ? "真实邮件适配器已配置；每次发送必须完整审批"
                : "真实IMAP/SMTP适配器尚未配置",
              lastHeartbeat: engine.lastHeartbeat
                ? new Date(engine.lastHeartbeat).toISOString()
                : null,
              capabilities: {
                arbitraryCode: ["confirm", "full"].includes(localAccess.state().mode),
                localFiles: localAccess.state().mode !== "disabled",
                localCommands: ["confirm", "full"].includes(localAccess.state().mode),
                osSandbox: false,
                realMail: true,
                mailAccountsConfigured: mail.getPublicConfig().length,
                realOa: false,
                controlledBrowser: true,
                privateRoleMemory: true,
                perAgentModels: true,
                browserFixture: false,
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
        }
        if (req.method === "GET" && path === "/api/local-access/state") {
          engine.reconcileLocalAccess();
          return json(res, localAccessState());
        }
        if (req.method === "POST" && path === "/api/local-access/select-folders") {
          await objectBody(req, []);
          if (typeof desktopBridge?.selectFolders !== "function")
            throw new Error("当前没有桌面文件夹选择器；请手动填写本机文件夹的绝对路径");
          return json(res, await desktopBridge.selectFolders());
        }
        if (req.method === "POST" && path === "/api/local-access/configure") {
          const input = await objectBody(req, ["mode", "roots", "allFiles", "onboardingComplete", "challenge", "confirmation"]);
          const state = await localAccess.configure(input);
          engine.reconcileLocalAccess();
          return json(res, { ...state, pickerAvailable: typeof desktopBridge?.selectFolders === "function" });
        }
        if (req.method === "POST" && path === "/api/local-access/full-access-request")
          return json(res, await localAccess.requestFullAccess(await objectBody(req, ["roots", "allFiles"])));
        if (req.method === "POST" && path === "/api/local-access/revoke") {
          await objectBody(req, []);
          const state = await localAccess.revoke();
          engine.reconcileLocalAccess("你已撤销本地访问，旧审批已失效；未执行待审批操作，请重新发起任务");
          return json(res, { ...state, pickerAvailable: typeof desktopBridge?.selectFolders === "function" });
        }
        if (req.method === "POST" && path === "/api/local-access/operations") {
          const input = await objectBody(req, ["kind", "path", "content", "executable", "args", "cwd", "timeoutMs"]);
          return json(res, await localAccess.propose(input, { actor: "user" }), 201);
        }
        let localMatch;
        if (req.method === "POST" && (localMatch = path.match(
          /^\/api\/local-access\/operations\/([^/]+)\/(approve|reject|cancel)$/))) {
          const input = await objectBody(req, ["digest"]);
          const operationId = localMatch[1], action = localMatch[2];
          const state = localAccess.state();
          const operation = [...state.pending, ...state.operations].find(op => op.id === operationId);
          if (!operation) return error(res, "本地操作不存在或已失效", 404);
          if (input.digest !== undefined && input.digest !== operation.digest)
            throw new Error("审批内容摘要不一致");
          const central = store.all("approvals").find(a => a.localOperationId === operationId);
          if (operation.taskId && store.get("tasks", operation.taskId)) {
            if (!central || central.taskId !== operation.taskId)
              throw new Error("任务本地操作缺少对应审批，禁止绕过任务执行");
            if (action === "cancel") {
              const task = engine.cancel(operation.taskId);
              await localAccess.cancel(operationId);
              return json(res, { task, operation: localAccess.state().operations.find(op => op.id === operationId) });
            }
            const task = await engine.decide(central.id, action);
            return json(res, { task, operation: localAccess.state().operations.find(op => op.id === operationId) });
          }
          if (operation.taskId) throw new Error("任务绑定已失效，禁止直接执行此操作");
          return json(res, await localAccess[action](operationId));
        }
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
        if (req.method === "GET" && path === "/api/skills") return json(res, {skills:skills.list()});
        if (req.method === "POST" && path === "/api/skills/import") return json(res, skills.importPackage(await objectBody(req,["files"],600000)),201);
        const skillMatch = path.match(/^\/api\/skills\/([a-f0-9]{64})$/);
        if (req.method === "GET" && skillMatch) return json(res, skills.view(skillMatch[1]));
        if (req.method === "GET" && path === "/api/seed-archive") return json(res,{records:store.all("seed_archive")});
        if (req.method === "POST" && path === "/api/seed-archive/restore") {
          const {id:archiveId} = await objectBody(req,["id"]);
          const record = typeof archiveId === "string" ? store.get("seed_archive",archiveId) : null;
          if (!record || !["memories","mail"].includes(record.kind)) throw new Error("归档记录不存在");
          if (store.get(record.kind,record.originalId)) throw new Error("原位置已有资料，不会覆盖任何现有内容");
          store.transaction(() => {store.put(record.kind,record.originalId,record.payload);store.put("seed_archive",archiveId,{...record,restoredAt:now()});});
          store.audit("seed.restored","用户恢复一条旧版归档资料");
          return json(res,{restored:true,id:archiveId});
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
          const task = engine.liveTask(m[1]);
          if (!task) return error(res, '任务不存在', 404);
          if (task.status !== 'completed') throw new Error('仅可导出已完成任务');
          const agent = store.get('agents', task.agentId);
          if (!agent?.enabled || !agent.permissions.includes('workspace.write')) throw new Error('执行角色未获 workspace.write 权限');
          const existing = (task.exports || []).find(a => a.format === b.format);
          if (existing && existsSync(join(dataDir, 'artifacts', existing.filename))) return json(res, existing);
          if (task.localContext && !engine.localTasks.has(task.id))
            throw new Error('本地任务正文已随重启清除；可下载已有文件，但不能使用占位内容新建导出');
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
          const result = { ...artifact, format: b.format, url: '/api/artifacts/' + encodeURIComponent(filename),
            sha256: createHash('sha256').update(readFileSync(join(dataDir, 'artifacts', filename))).digest('hex') };
          engine.save({ ...task, exports: [...(task.exports || []).filter(a => a.format !== b.format), result] });
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
          if (store.get("approvals", m[1])?.type?.startsWith("local.")) {
            if (!b || typeof b !== "object" || Array.isArray(b) ||
              Object.keys(b).some(key => !["decision", "digest"].includes(key)))
              throw new Error("本地审批只接受决定与精确内容摘要");
            if (b.digest !== undefined && b.digest !== store.get("approvals", m[1]).digest)
              throw new Error("审批内容摘要不一致");
          }
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
            throw new Error("仅支持API模式；旧配置标记可迁移为api");
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
            mode: "api",
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
          let out;
          try {
            out = await callModel({
              endpoint: s.endpoint,
              model: s.model,
              key: apiKey,
              messages: [{ role: "user", content: "请只回答：连接成功。" }],
            });
          } catch (failure) {
            const diagnostic = modelErrorDiagnostic(failure);
            return json(res, { ok: false, error: diagnostic.message, code: diagnostic.code }, 400);
          }
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
          const owner = store.all("tasks").find(task => [task.artifact, ...(task.artifacts || []), ...(task.exports || [])]
            .some(artifact => artifact?.filename === filename));
          if (!owner) return error(res, "文件不存在", 404);
          const actor = store.get("agents", owner.agentId);
          if (!actor?.enabled || !actor.permissions.includes("workspace.write"))
            return error(res, "文件所属角色未获 workspace.write 权限", 403);
          const artifact = [owner.artifact, ...(owner.artifacts || []), ...(owner.exports || [])]
            .find(artifact => artifact?.filename === filename);
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
    } finally {
      if (mutationClaimed) inflightMutations--;
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });
  port = server.address().port;
  baseUrl = `http://${host}:${port}`;
  broker = new BrowserBroker(store);
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
    localAccess,
    skillsService: skills,
    publicWebService,
    delay: stepDelay,
    completion,
  });
  schedules = new ScheduleService(store, engine, scheduleOptions);
  schedules.tick();
  store.audit("system.started", "本机服务启动；仅环回地址，本地文件与命令受用户授权和角色权限控制；没有OS级代码沙箱");
  engine.tick();
  return {
    server,
    port,
    store,
    engine,
    broker,
    mail,
    controlledBrowser,
    localAccess,
    schedules,
    url: baseUrl,
    version: applicationVersion,
    prepareForUpdate() {
      if (closed) return { ready: false };
      // No await is allowed between closing dispatch and checking activity.
      updateGate = true;
      engine.setUpdateGate(true);
      schedules.setUpdateGate(true);
      // Even an idle live page can initiate a background network request after
      // this check. Require it closed rather than race its next request or abort
      // an in-progress external action during update shutdown.
      const browserBusy = controlledBrowser.inflight.size > 0 || controlledBrowser.live.size > 0;
      const busy = inflightMutations > 0 || engine.running.size > 0 ||
        localAccess.running.size > 0 || localAccess.inflight.size > 0 || browserBusy ||
        mail.active.size > 0 || mail.inboxLocks.size > 0 || mail.readControllers.size > 0;
      if (busy) {
        // A refused installation must not strand tasks or settings behind a gate.
        updateGate = false;
        engine.setUpdateGate(false);
        schedules.setUpdateGate(false);
        return { ready: false };
      }
      return { ready: true };
    },
    releaseUpdateGate() {
      if (closed || !updateGate) return;
      updateGate = false;
      engine.setUpdateGate(false);
      schedules.setUpdateGate(false);
    },
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
  console.log(`路衡办公智能体 v${applicationVersion} 已启动：${app.url} （仅本机）`);
  process.on("SIGINT", async () => {
    await app.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });
}
