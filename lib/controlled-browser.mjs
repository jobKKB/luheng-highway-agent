import dns from 'node:dns/promises';
import net, { BlockList } from 'node:net';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { id, now } from './store.mjs';
import { redactSecrets } from './redact.mjs';

const require = createRequire(import.meta.url);
const CONTROL_SELECTOR = 'input:not([type="hidden"]),textarea,select,button,a[href],[role="button"],[role="textbox"],[contenteditable="true"]';
const SENSITIVE = /password|passwd|pwd|secret|api[ _-]?key|token|credential|one[ _-]?time|otp|credit[ _-]?card|验证码|密码|口令|密钥|令牌|安全码|银行卡/i;
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-)/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TERMINAL_APPROVALS = new Set(['completed', 'rejected', 'stale', 'expired', 'cancelled', 'unknown']);
const ACTIVE_SESSIONS = new Set(['opening', 'agent', 'taking_over', 'manual']);

export class BrowserPolicyError extends Error {
  constructor(message, code = 'BROWSER_POLICY') { super(message); this.name = 'BrowserPolicyError'; this.code = code; }
}
const fail = (message, code) => { throw new BrowserPolicyError(message, code); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const sameSecret = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const cleanText = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
const safeURLForLog = value => { try { const u = new URL(value); return u.origin + u.pathname.slice(0, 200); } catch { return '[invalid URL]'; } };

const blockedIPv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIPv4.addSubnet(address, prefix, 'ipv4');
const publicIPv6 = new BlockList(); publicIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blockedIPv6.addSubnet(address,prefix,'ipv6');

export function isPublicBrowserAddress(address) {
  if (net.isIPv4(address)) return !blockedIPv4.check(address, 'ipv4');
  if (net.isIPv6(address)) return publicIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  return false;
}

function parseTargetURL(value, allowTestLocal, originOnly = false) {
  let url; try { url = new URL(value); } catch { fail('请输入完整有效的网址', 'TARGET_URL'); }
  if (url.username || url.password) fail('目标网址不能携带账号或密码', 'TARGET_CREDENTIALS');
  for (const key of url.searchParams.keys()) if (SENSITIVE.test(key)) fail('目标网址不能包含认证参数', 'TARGET_CREDENTIALS');
  if (originOnly && (url.pathname !== '/' || url.search || url.hash)) fail('白名单必须是完整 origin，不能包含路径或参数', 'TARGET_ORIGIN');
  if (allowTestLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port) return url;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) fail('真实目标只允许公网 HTTPS 443；内网目标需要未来的管理员策略', 'TARGET_HTTPS');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || !host.includes('.') && !net.isIP(host) || /\.(localhost|local|internal|test|invalid|example)$/.test(host)) fail('禁止本机、内网和保留域名', 'TARGET_PRIVATE');
  if (net.isIP(host) && !isPublicBrowserAddress(host)) fail('禁止私有、回环或保留地址', 'TARGET_PRIVATE');
  return url;
}

async function resolvePinnedOrigins(origins, { allowTestLocal, resolveHost }) {
  const pinned = new Map();
  for (const origin of origins) {
    const url = parseTargetURL(origin, allowTestLocal, true);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (allowTestLocal && url.protocol === 'http:' && host === '127.0.0.1') {
      pinned.set(origin, { address: '127.0.0.1', family: 4, port: Number(url.port), hostname: host });
      continue;
    }
    let addresses;
    try { addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolveHost(host, { all: true, verbatim: true }); }
    catch { fail('无法解析目标域名', 'TARGET_DNS'); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(x => !isPublicBrowserAddress(x.address))) fail('目标 DNS 含私有、回环或保留地址', 'TARGET_DNS_PRIVATE');
    const chosen = addresses.find(x => x.family === 4) || addresses[0];
    pinned.set(origin, { address: chosen.address, family: chosen.family, port: 443, hostname: host });
  }
  return pinned;
}

/** A private per-session forward proxy. CONNECT destinations use validated literal IPs,
 * so Chromium never resolves a target again. No global proxy/system setting changes. */
class PinnedProxy {
  constructor(pins, { allowRequest, blocked }) {
    this.pins = pins; this.allowRequest = allowRequest; this.blocked = blocked;
    this.sockets = new Set(); this.closed = false;
    this.username = randomBytes(12).toString('hex'); this.password = randomBytes(24).toString('hex');
    this.auth = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    this.server = http.createServer((req, res) => this.httpRequest(req, res));
    this.server.on('connect', (req, socket, head) => this.connect(req, socket, head));
    this.server.on('upgrade', (req, socket) => { this.blocked(req.url, 'websocket', 'PROXY_UPGRADE'); socket.destroy(); });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }
  authenticated(req) { return sameSecret(req.headers['proxy-authorization'], this.auth); }
  challenge(socketOrResponse, raw = false) {
    if (raw) socketOrResponse.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Local controlled browser"\r\nContent-Length: 0\r\n\r\n');
    else { socketOrResponse.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Local controlled browser"' }); socketOrResponse.end(); }
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return { server: `http://127.0.0.1:${this.server.address().port}`, username: this.username, password: this.password, bypass: '<-loopback>' };
  }
  httpRequest(req, res) {
    if (!this.authenticated(req)) return this.challenge(res);
    let url; try { url = new URL(req.url); } catch { res.writeHead(403); return res.end(); }
    const pin = this.pins.get(url.origin);
    if (this.closed || url.protocol !== 'http:' || !pin || url.username || url.password || !this.allowRequest(req.method)) {
      this.blocked(url.href, req.method, 'PROXY_DENY'); res.writeHead(403); return res.end();
    }
    const headers = { ...req.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = http.request({ host: pin.address, family: pin.family, port: pin.port, path: url.pathname + url.search, method: req.method, headers, agent: false, timeout: 15000 }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('socket', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on('timeout', () => upstream.destroy()); req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  }
  connect(req, socket, head) {
    if (!this.authenticated(req)) return this.challenge(socket, true);
    let url; try { url = new URL(`https://${req.url}`); } catch { return socket.destroy(); }
    const pin = this.pins.get(url.origin);
    if (this.closed || !pin || url.username || url.password || url.pathname !== '/' || Number(url.port || 443) !== pin.port) {
      this.blocked(url.href, 'CONNECT', 'PROXY_DENY'); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const upstream = net.connect({ host: pin.address, family: pin.family, port: pin.port });
    this.sockets.add(upstream); upstream.on('close', () => this.sockets.delete(upstream));
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    upstream.setTimeout(60000, () => upstream.destroy());
  }
  async close() { if (this.closed) return; this.closed = true; for (const socket of this.sockets) socket.destroy(); await new Promise(resolve => this.server.close(resolve)); }
}

function approvalPayload(a) {
  return { version: 1, id: a.id, sessionId: a.sessionId, taskId: a.taskId, targetId: a.targetId, targetVersion: a.targetVersion,
    observationId: a.observationId, pageVersion: a.pageVersion, url: a.url, reason: a.reason, actions: a.actions, expiresAt: a.expiresAt };
}
function publicSession(session) { if (!session) return null; const copy = clone(session); delete copy.leaseToken; delete copy.leaseHash; return copy; }
function controlFingerprint(c) { return digest({ selector: c.selector, tag: c.tag, type: c.type, name: c.name, id: c.id, label: c.label, sensitive: c.sensitive, href: c.href, formAction: c.formAction, formMethod: c.formMethod }); }

export class ControlledBrowserService {
  constructor(store, { dataDir = store.dir, allowTestLocal = false, headless = true, maxSessions = 4, resolveHost = dns.lookup, executablePath, getExternalSecrets = () => [] } = {}) {
    this.store = store; this.getExternalSecrets = getExternalSecrets; this.secretHistory = new Set(); this.allowTestLocal = allowTestLocal === true; this.headless = headless; this.maxSessions = maxSessions;
    this.resolveHost = resolveHost; this.executablePath = process.env.HIGHWAY_BUNDLED_BROWSER === '1' ? (process.env.HIGHWAY_BUNDLED_BROWSER_EXECUTABLE || undefined) : (executablePath || process.env.HIGHWAY_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined));
    this.screenshotDir = join(dataDir, 'controlled-screenshots'); mkdirSync(this.screenshotDir, { recursive: true, mode: 0o700 });
    this.live = new Map(); this.inflight = new Map(); this.closed = false;
    // A process restart never replays old input or silently imports cookies/profiles.
    for (const a of store.all('browser_approvals')) if (a.status === 'executing') store.put('browser_approvals', a.id, { ...a, status: 'unknown', endedAt: now(), error: '服务中断；操作结果未知，禁止自动重试' });
    for (const s of store.all('controlled_sessions')) if (ACTIVE_SESSIONS.has(s.status)) store.put('controlled_sessions', s.id, { ...s, status: 'interrupted', endedAt: now(), error: '浏览器会话未跨重启恢复' });
  }
  secrets() { for (const secret of this.getExternalSecrets() || []) if (typeof secret === 'string' && secret) this.secretHistory.add(secret); return [...this.secretHistory]; }
  sanitize(value) { return redactSecrets(value, this.secrets()); }
  hasKnownSecret(value) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (!raw) return false;
    const variants = [raw, raw.replace(/\\u([0-9a-f]{4})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))];
    try { variants.push(decodeURIComponent(raw)); } catch {}
    return this.secrets().some(secret => variants.some(text => text.includes(secret)));
  }
  audit(action, detail, taskId = null) { this.store.audit(`controlled_browser.${action}`, this.sanitize(detail), taskId); }
  listTargets() { return this.sanitize(this.store.all('browser_targets'));  }
  listSessions() { return this.sanitize(this.store.all('controlled_sessions').map(publicSession)); }
  listApprovals() { return this.sanitize(this.store.all('browser_approvals')); }
  getPublicState() { return { targets: this.listTargets(), sessions: this.listSessions(), approvals: this.listApprovals() }; }
  getSession(sessionId) { const session = this.store.get('controlled_sessions', sessionId); if (!session) fail('浏览器会话不存在', 'SESSION_NOT_FOUND'); return this.sanitize(publicSession(session)); }
  saveSession(live, patch) { const current = this.store.get('controlled_sessions', live.id); const next = this.sanitize({ ...current, ...patch, updatedAt: now() }); this.store.put('controlled_sessions', live.id, next); return publicSession(next); }
  mustLive(sessionId) { if (this.closed) fail('浏览器服务已关闭', 'SERVICE_CLOSED'); const live = this.live.get(sessionId); if (!live || live.closed) fail('会话不在运行；需要显式新建会话', 'SESSION_NOT_LIVE'); return live; }

  async configureTargets(targets) {
    if (!Array.isArray(targets) || targets.length > 12) fail('最多配置12个明确目标', 'TARGET_LIMIT');
    const unique = new Set(), normalized = [];
    for (const input of targets) {
      if (this.hasKnownSecret(input)) fail('目标配置不能包含已知密钥或密码', 'KNOWN_SECRET');
      if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || unique.has(input.id)) fail('目标 ID 无效或重复', 'TARGET_ID');
      unique.add(input.id); const start = parseTargetURL(input.startUrl, this.allowTestLocal);
      if (input.allowedOrigins !== undefined && !Array.isArray(input.allowedOrigins)) fail('目标白名单必须是 origin 数组', 'TARGET_ORIGIN');
      const origins = [...new Set(input.allowedOrigins ?? [start.origin])];
      if (!origins.length || origins.length > 8) fail('每个目标需1至8个明确 origin', 'TARGET_ORIGIN');
      const allowedOrigins = origins.map(value => parseTargetURL(value, this.allowTestLocal, true).origin).sort();
      if (!allowedOrigins.includes(start.origin)) fail('起始网址必须属于目标 origin 白名单', 'TARGET_ORIGIN');
      await resolvePinnedOrigins(allowedOrigins, this);
      const core = { id: input.id, name: cleanText(input.name || input.id, 80), startUrl: start.href, allowedOrigins, enabled: input.enabled !== false };
      normalized.push({ ...core, version: digest(core), updatedAt: now(), testOnly: start.protocol === 'http:' });
    }
    for (const live of [...this.live.values()]) {
      const next = normalized.find(t => t.id === live.target.id);
      if (!next || !next.enabled || next.version !== live.target.version) await this.cancel(live.id, '目标配置已更新或撤销');
    }
    this.store.transaction(() => { for (const old of this.store.all('browser_targets')) this.store.delete('browser_targets', old.id); for (const target of normalized) this.store.put('browser_targets', target.id, target); });
    this.audit('targets_configured', `更新${normalized.length}个目标；未打开任何网站`);
    return this.listTargets();
  }

  blocked(live, url, method, reason) {
    if (live.closed) return;
    const entry = { url: safeURLForLog(url), method: cleanText(method, 16), reason, at: now() };
    const current = this.store.get('controlled_sessions', live.id);
    if (!current) return;
    this.saveSession(live, { blockedRequests: [...(current.blockedRequests || []), entry].slice(-30) });
  }
  allowedURL(live, value) {
    try { if (this.hasKnownSecret(value)) return false; const url = new URL(value); return !url.username && !url.password && live.target.allowedOrigins.includes(url.origin) && (url.protocol === 'https:' || this.allowTestLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1'); }
    catch { return false; }
  }
  async open(taskId, targetId) {
    if (this.closed) fail('浏览器服务已关闭', 'SERVICE_CLOSED');
    if (typeof taskId !== 'string' || !taskId || taskId.length > 100) fail('任务 ID 无效', 'TASK_ID');
    if (this.live.size >= this.maxSessions) fail('并行浏览器会话已达到上限', 'SESSION_LIMIT');
    const target = this.store.get('browser_targets', targetId);
    if (!target?.enabled) fail('目标未配置或已停用', 'TARGET_NOT_ALLOWED');
    if (target.testOnly && !this.allowTestLocal) fail('生产服务禁止测试本机目标', 'TARGET_PRIVATE');
    const sessionId = id();
    const session = { id: sessionId, taskId, targetId, targetName: target.name, targetVersion: target.version, startUrl: target.startUrl, status: 'opening', createdAt: now(), updatedAt: now(), blockedRequests: [], screenshotReady: false };
    this.store.put('controlled_sessions', sessionId, this.sanitize(session));
    const live = { id: sessionId, taskId, target: clone(target), closed: false, writeWindow: false, manualRequested: false, leaseHash: null, observation: null, browser: null, context: null, page: null, proxy: null, execution: null, pendingRequests: new Set(), lastNetworkActivity: Date.now() };
    this.live.set(sessionId, live);
    try {
      const pins = await resolvePinnedOrigins(target.allowedOrigins, this);
      if (live.closed) fail('打开过程已取消', 'CANCELLED');
      live.proxy = new PinnedProxy(pins, { allowRequest: method => READ_METHODS.has(method) || live.writeWindow, blocked: (...args) => this.blocked(live, ...args) });
      const proxy = await live.proxy.start();
      if (live.closed) fail('打开过程已取消', 'CANCELLED');
      const { chromium } = require('playwright');
      live.browser = await chromium.launch({ headless: this.headless, executablePath: this.executablePath, chromiumSandbox: true, proxy,
        args: ['--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      if (live.closed) fail('打开过程已取消', 'CANCELLED');
      live.context = await live.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false, permissions: [], strictSelectors: true });
      if (live.closed) fail('打开过程已取消', 'CANCELLED');
      live.context.on('request', request => { live.pendingRequests.add(request); live.lastNetworkActivity = Date.now(); });
      for (const event of ['requestfinished', 'requestfailed']) live.context.on(event, request => { live.pendingRequests.delete(request); live.lastNetworkActivity = Date.now(); });
      live.context.setDefaultTimeout(5000); live.context.setDefaultNavigationTimeout(15000);
      await live.context.route('**/*', async route => {
        const request = route.request();
        let rootPage = true; try { rootPage = !live.page || request.frame().page() === live.page; } catch { rootPage = false; }
        if (live.closed || !rootPage || !this.allowedURL(live, request.url()) || !READ_METHODS.has(request.method()) && !live.writeWindow || this.hasKnownSecret(request.postData() || '')) {
          this.blocked(live, request.url(), request.method(), !rootPage ? 'POPUP_BLOCKED' : !this.allowedURL(live, request.url()) ? 'ORIGIN_BLOCKED' : 'INPUT_APPROVAL_REQUIRED');
          await route.abort('blockedbyclient').catch(() => {}); return;
        }
        await route.continue().catch(() => {});
      });
      await live.context.routeWebSocket('**/*', socket => { this.blocked(live, socket.url(), 'websocket', 'WEBSOCKET_BLOCKED'); socket.close(); });
      live.context.on('page', page => { if (live.page && page !== live.page) page.close().catch(() => {}); });
      live.page = await live.context.newPage();
      live.page.on('download', download => { this.blocked(live, download.url(), 'download', 'DOWNLOAD_BLOCKED'); download.cancel().catch(() => {}); });
      live.page.on('pageerror', error => { if (!live.closed) this.saveSession(live, { lastPageError: this.sanitize(cleanText(error.message, 300)) }); });
      live.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      live.page.on('filechooser', chooser => chooser.setFiles([]).catch(() => {}));
      await live.page.goto(target.startUrl, { waitUntil: 'domcontentloaded' });
      if (!this.allowedURL(live, live.page.url())) fail('页面跳转到了未授权目标', 'NAVIGATION_BLOCKED');
      this.saveSession(live, { status: 'agent', networkPolicy: 'Exact origins; vetted DNS pinned by per-session proxy; no direct DNS; sandbox on' });
      this.audit('opened', `为任务新建隔离浏览器：${target.name}`, taskId);
      await this.settle(live);
      const observation = await this.read(sessionId); if (observation?.cancelled) return observation;
      const screenshot = await this.screenshot(sessionId); if (screenshot?.cancelled) return screenshot;
      return { session: this.getSession(sessionId), observation };
    } catch (error) {
      await this.dispose(live);
      const finalSession = this.store.get('controlled_sessions', sessionId);
      if (finalSession.status === 'cancelled') return { session: this.sanitize(publicSession(finalSession)), cancelled: true };
      if (finalSession.status !== 'cancelled') this.store.put('controlled_sessions', sessionId, { ...finalSession, status: 'error', error: this.sanitize(cleanText(error.message, 400)), endedAt: now() });
      throw new BrowserPolicyError(this.sanitize(cleanText(error.message, 400)), error.code || 'BROWSER_OPEN_FAILED');
    }
  }

  async describeControl(element, selector, index) {
    if (!await element.isVisible().catch(() => false)) return null;
    const attr = async name => cleanText(await element.getAttribute(name).catch(() => ''), 300);
    const dom = await element.evaluate(el => ({ tag: el.tagName.toLowerCase(), formAction: el.form ? (el.getAttribute('formaction') || el.form.getAttribute('action') || '') : '', formMethod: el.form ? (el.getAttribute('formmethod') || el.form.getAttribute('method') || 'get') : '' })); // Fixed read-only inspection, never caller-supplied code.
    const tag = dom.tag.slice(0, 30);
    const type = (await attr('type')).toLowerCase(), name = await attr('name'), elementId = await attr('id');
    const ariaLabel = await attr('aria-label'), placeholder = await attr('placeholder'), autocomplete = await attr('autocomplete');
    let label = ariaLabel;
    if (!label && elementId && /^[\w-]+$/.test(elementId)) { const labels = element.page().locator(`label[for="${elementId}"]`); if (await labels.count()) label = cleanText(await labels.first().innerText().catch(() => ''), 160); }
    if (!label && ['button','a'].includes(tag)) label = cleanText(await element.innerText().catch(() => ''), 160);
    label = label || placeholder || name || elementId || tag;
    const sensitive = this.hasKnownSecret([name, elementId, label, placeholder]) || type === 'password' || SECRET_AUTOCOMPLETE.test(autocomplete) || SENSITIVE.test([name, elementId, label, placeholder].join(' '));
    const fillable = ['input','textarea'].includes(tag) && !['hidden','password','file','submit','button','checkbox','radio','reset','image','range','color'].includes(type);
    const forbidden = sensitive || type === 'file' || type === 'hidden';
    let value = !sensitive && ['input','textarea','select'].includes(tag) ? cleanText(await element.inputValue().catch(() => ''), 2000) : undefined;
    const knownSecretValue = value !== undefined && this.hasKnownSecret(value);
    if (knownSecretValue) value = undefined;
    const result = { controlId: `c${index}`, selector, tag, type, name, id: elementId, formAction: cleanText(dom.formAction, 300), formMethod: cleanText(dom.formMethod, 20), label: cleanText(label,160), placeholder, knownSecretPresent: knownSecretValue || this.hasKnownSecret([name, elementId, label, placeholder]), sensitive: sensitive || knownSecretValue, forbidden: forbidden || knownSecretValue, fillable, enabled: await element.isEnabled().catch(() => false), ...(value !== undefined ? {value} : {}) };
    if (tag === 'a') result.href = await attr('href');
    result.fingerprint = controlFingerprint(result); return result;
  }
  async observe(live) {
    if (!this.allowedURL(live, live.page.url())) fail('当前页面不在目标白名单中', 'NAVIGATION_BLOCKED');
    const frames = [], controls = []; let combinedText = '';
    const currentFrames = live.page.frames().slice(0, 12);
    for (let frameIndex = 0; frameIndex < currentFrames.length; frameIndex++) {
      const frame = currentFrames[frameIndex]; if (!this.allowedURL(live, frame.url())) continue;
      const text = cleanText(await frame.locator('body').innerText({ timeout: 3000 }).catch(() => ''), 22000);
      frames.push({ frameIndex, url: frame.url(), text }); combinedText += `${frameIndex ? '\n[iframe]\n' : ''}${text}\n`;
      const nodes = frame.locator(CONTROL_SELECTOR); const count = Math.min(await nodes.count(), 120);
      for (let controlIndex = 0; controlIndex < count && controls.length < 120; controlIndex++) {
        const selector = { frameIndex, frameUrl: frame.url(), css: CONTROL_SELECTOR, controlIndex };
        const control = await this.describeControl(nodes.nth(controlIndex), selector, controls.length);
        if (control) controls.push(control);
      }
    }
    const stable = { url: live.page.url(), title: cleanText(await live.page.title(), 300), text: combinedText.slice(0, 40000), frames, controls };
    live.observationHasSecret = this.hasKnownSecret(stable) || controls.some(c => c.knownSecretPresent);
    const pageVersion = digest(stable);
    return this.sanitize({ sessionId: live.id, taskId: live.taskId, targetId: live.target.id, observationId: id(), pageVersion, observedAt: now(), ...stable });
  }
  cancelledResult(sessionId, live = null) {
    const session = this.store.get('controlled_sessions', sessionId);
    if (session && (live?.closed || ['cancelled', 'closed', 'interrupted'].includes(session.status))) {
      return { session: this.sanitize(publicSession(session)), cancelled: true };
    }
    return null;
  }
  async read(sessionId) {
    let live;
    try {
      live = this.mustLive(sessionId); const observation = await this.observe(live);
      const cancelled = this.cancelledResult(sessionId, live); if (cancelled) return cancelled;
      live.observation = observation;
      this.saveSession(live, { url: observation.url, title: observation.title, lastObservation: observation });
      return clone(observation);
    } catch (error) { const cancelled = this.cancelledResult(sessionId, live); if (cancelled) return cancelled; throw error; }
  }
  async screenshot(sessionId) {
    let live;
    try {
      live = this.mustLive(sessionId); const filename = join(this.screenshotDir, `${sessionId}.png`);
      const observed = await this.observe(live);
      const cancelled = this.cancelledResult(sessionId, live); if (cancelled) return cancelled;
      const mask = [];
      if (live.observationHasSecret) mask.push(live.page.locator('body'));
      else for (const control of observed.controls.filter(c => c.sensitive)) {
        const frame = live.page.frames()[control.selector.frameIndex];
        if (frame && frame.url() === control.selector.frameUrl) mask.push(frame.locator(CONTROL_SELECTOR).nth(control.selector.controlIndex));
      }
      await live.page.screenshot({ path: filename, fullPage: false, animations: 'disabled', mask });
      const ended = this.cancelledResult(sessionId, live); if (ended) return ended;
      chmodSync(filename, 0o600);
      this.saveSession(live, { screenshotReady: true, screenshotAt: now(), screenshotRedacted: !!live.observationHasSecret }); return filename;
    } catch (error) { const cancelled = this.cancelledResult(sessionId, live); if (cancelled) return cancelled; throw error; }
  }

  normalizeActions(observation, actions) {
    if (!Array.isArray(actions) || !actions.length || actions.length > 8) fail('每次提案需1至8个明确动作', 'ACTION_LIMIT');
    return actions.map(action => {
      if (this.hasKnownSecret(action)) fail('不能向网页输入已知密钥或密码', 'KNOWN_SECRET');
      if (!action || !['fill','click'].includes(action.type) || typeof action.controlId !== 'string' || 'selector' in action || 'script' in action || 'javascript' in action) fail('只支持读取结果中的控件编号和 fill/click 动作，不接受脚本或选择器', 'ACTION_UNSUPPORTED');
      const control = observation.controls.find(c => c.controlId === action.controlId);
      if (!control) fail('控件不属于本次页面观察', 'CONTROL_NOT_FOUND');
      if (control.forbidden || control.sensitive) fail('禁止密码、验证码、密钥、付款信息或文件输入自动化', 'SENSITIVE_CONTROL');
      if (!control.enabled) fail('控件当前不可用', 'CONTROL_DISABLED');
      if (action.type === 'fill' && (!control.fillable || typeof action.value !== 'string' || action.value.length > 4000)) fail('填写动作只允许普通文本输入，最多4000字符', 'FILL_UNSUPPORTED');
      if (action.type === 'click' && action.value !== undefined) fail('点击动作不能携带输入值', 'ACTION_UNSUPPORTED');
      return { type: action.type, controlId: control.controlId, selector: clone(control.selector), fingerprint: control.fingerprint, label: control.label, ...(control.href ? { href: control.href } : {}), ...(control.formAction ? { formAction: control.formAction, formMethod: control.formMethod } : {}), ...(action.type === 'fill' ? { value: action.value } : {}) };
    });
  }
  async proposeActions(sessionId, { observationId, actions, reason = '' } = {}) {
    const live = this.mustLive(sessionId);
    if (this.getSession(sessionId).status !== 'agent' || live.manualRequested) fail('人工接管期间不能发起智能体输入提案', 'MANUAL_LEASE');
    if (live.execution) fail('已有输入批次正在执行', 'SESSION_BUSY');
    if (!live.observation || observationId !== live.observation.observationId) fail('页面观察已过期，请先重新读取', 'OBSERVATION_STALE');
    const base = clone(live.observation);
    const normalizedActions = this.normalizeActions(base, actions);
    if (this.hasKnownSecret(reason)) fail('提案说明不能包含已知密钥或密码', 'KNOWN_SECRET');
    const current = await this.observe(live);
    if (current.pageVersion !== base.pageVersion) fail('页面内容已变化，请重新读取并提案', 'OBSERVATION_STALE');
    const approval = { id: id(), sessionId, taskId: live.taskId, targetId: live.target.id, targetVersion: live.target.version,
      observationId, pageVersion: base.pageVersion, url: base.url, reason: cleanText(reason,400), actions: normalizedActions,
      status: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), inputStarted: false, actionsCompleted: 0 };
    approval.digest = digest(approvalPayload(approval));
    this.store.put('browser_approvals', approval.id, approval);
    this.audit('proposed', `等待批准${approval.actions.length}个输入动作；尚未触发输入事件`, live.taskId);
    return clone(approval);
  }
  async resolveAction(live, action) {
    const descriptor = action.selector;
    if (!descriptor || descriptor.css !== CONTROL_SELECTOR || !Number.isInteger(descriptor.frameIndex) || !Number.isInteger(descriptor.controlIndex)) fail('动作定位证据无效', 'CONTROL_CHANGED');
    const frame = live.page.frames()[descriptor.frameIndex];
    if (!frame || frame.url() !== descriptor.frameUrl || !this.allowedURL(live, frame.url())) fail('控件所在页面已变化', 'CONTROL_CHANGED');
    const element = frame.locator(CONTROL_SELECTOR).nth(descriptor.controlIndex);
    if (await element.count() !== 1) fail('控件已不存在', 'CONTROL_CHANGED');
    const actual = await this.describeControl(element, descriptor, 0);
    if (!actual || actual.fingerprint !== action.fingerprint || !actual.enabled || actual.forbidden || actual.sensitive) fail('控件状态或身份已变化；不尝试猜测替代控件', 'CONTROL_CHANGED');
    return element;
  }
  async performAction(live, action) {
    const element = await this.resolveAction(live, action);
    if (this.hasKnownSecret(action)) fail('不能向网页输入已知凭据', 'KNOWN_SECRET');
    if (action.type === 'fill') await element.fill(action.value, { timeout: 5000 });
    else await element.click({ timeout: 5000, noWaitAfter: true });
  }
  async settle(live) {
    if (live.closed) return;
    // A previously reached Playwright networkidle state can resolve immediately
    // after a click while its fetch event is still queued. Keep the granted write
    // window open until this session has a fresh 350ms observed quiet period.
    const started = Date.now(); live.lastNetworkActivity = started;
    while (!live.closed && Date.now() - started < 2500) {
      if (!live.pendingRequests.size && Date.now() - live.lastNetworkActivity >= 350) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (live.writeWindow && [...live.pendingRequests].some(request => !READ_METHODS.has(request.method()))) fail('获批输入的网络响应尚未确认；不会重试', 'WRITE_OUTCOME_UNKNOWN');
  }
  async decide(approvalId, { decision, digest: suppliedDigest, signal } = {}) {
    const approval = this.store.get('browser_approvals', approvalId);
    if (!approval) fail('输入审批不存在', 'APPROVAL_NOT_FOUND');
    if (!['approve','reject'].includes(decision)) fail('审批决定无效', 'APPROVAL_DECISION');
    if (suppliedDigest !== approval.digest || digest(approvalPayload(approval)) !== approval.digest) fail('审批摘要与动作不匹配', 'APPROVAL_DIGEST');
    if (this.inflight.has(approvalId)) return this.inflight.get(approvalId);
    if (TERMINAL_APPROVALS.has(approval.status)) return { approval: clone(approval), replayed: false };
    if (decision === 'reject') {
      const rejected = { ...approval, status: 'rejected', endedAt: now() }; this.store.put('browser_approvals', approvalId, rejected);
      this.audit('rejected', '拒绝输入批次；未触发任何输入事件', approval.taskId); return { approval: rejected, replayed: false };
    }
    if (this.hasKnownSecret(approvalPayload(approval))) fail('该提案包含后来识别的凭据，必须撤销后重新提案', 'KNOWN_SECRET');
    const live = this.mustLive(approval.sessionId);
    if (live.execution) fail('该会话已有操作正在执行', 'SESSION_BUSY');
    if (live.manualRequested || this.getSession(live.id).status !== 'agent') return { approval: clone(approval), blocked: 'MANUAL_LEASE', replayed: false };
    if (Date.parse(approval.expiresAt) <= Date.now()) { const expired = { ...approval, status: 'expired', endedAt: now() }; this.store.put('browser_approvals', approvalId, expired); return { approval: expired, replayed: false }; }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const execution = { approvalId, controller, inputStarted: false, promise: null };
    live.execution = execution;
    const promise = this.executeApproval(live, approval, combined).finally(() => { if (live.execution === execution) live.execution = null; this.inflight.delete(approvalId); });
    execution.promise = promise; this.inflight.set(approvalId, promise); return promise;
  }
  async executeApproval(live, approval, signal) {
    let record = { ...approval, status: 'executing', startedAt: now() };
    this.store.put('browser_approvals', record.id, record);
    const abort = () => { live.writeWindow = false; live.context?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) fail('操作在输入前已取消', 'CANCELLED');
      const current = await this.observe(live);
      if (current.pageVersion !== approval.pageVersion || current.url !== approval.url || live.target.version !== approval.targetVersion) {
        record = { ...record, status: 'stale', error: '页面或目标已变化；必须重新提案和审批', endedAt: now() };
        this.store.put('browser_approvals', record.id, record); return { approval: clone(record), replayed: false };
      }
      for (const action of approval.actions) {
        if (this.hasKnownSecret(action)) fail('动作包含已知凭据，已阻止', 'KNOWN_SECRET');
        if (signal.aborted || live.closed) fail('操作已取消；不会重试', 'CANCELLED');
        if (live.manualRequested) fail('人工接管中；剩余动作已停止', 'MANUAL_LEASE');
        // Resolve twice around persistent bookkeeping so no DOM event precedes approval.
        await this.resolveAction(live, action);
        record = { ...record, inputStarted: true }; this.store.put('browser_approvals', record.id, record);
        live.execution.inputStarted = true; live.writeWindow = true;
        await this.performAction(live, action);
        record = { ...record, actionsCompleted: record.actionsCompleted + 1 }; this.store.put('browser_approvals', record.id, record);
        await this.settle(live);
      }
      if (signal.aborted || live.manualRequested || live.closed) fail('操作已中断；禁止自动重试', 'CANCELLED');
      live.writeWindow = false;
      const observation = await this.read(live.id);
      if (observation?.cancelled || signal.aborted || live.closed) fail('观察期间被取消；输入结果需人工核实', 'CANCELLED');
      const screenshot = await this.screenshot(live.id);
      if (screenshot?.cancelled || signal.aborted || live.closed) fail('观察期间被取消；输入结果需人工核实', 'CANCELLED');
      record = { ...record, status: 'completed', outcome: 'inputs_dispatched', businessOutcome: 'inspect_observation', endedAt: now(), resultPageVersion: observation.pageVersion };
      this.store.put('browser_approvals', record.id, record); this.audit('executed', `已执行获批的${record.actionsCompleted}个输入动作；不自动重复`, live.taskId);
      return { approval: clone(record), observation, replayed: false };
    } catch (error) {
      const unknown = record.inputStarted;
      record = { ...record, status: unknown ? 'unknown' : 'cancelled', endedAt: now(), error: unknown ? '输入可能已生效，结果未知；请人工核实，禁止自动重试' : this.sanitize(cleanText(error.message, 300)) };
      this.store.put('browser_approvals', record.id, record); this.audit(unknown ? 'unknown' : 'cancelled', record.error, live.taskId);
      return { approval: clone(record), replayed: false };
    } finally { live.writeWindow = false; signal.removeEventListener('abort', abort); }
  }

  async takeover(sessionId) {
    const ended = this.cancelledResult(sessionId); if (ended) return ended;
    const live = this.mustLive(sessionId);
    if (['manual','taking_over'].includes(this.getSession(sessionId).status)) fail('会话已由人工持有；不会创建第二份控制租约', 'MANUAL_LEASE');
    live.manualRequested = true; this.saveSession(live, { status: 'taking_over' });
    // Wait for the currently dispatched action, stopping the rest of its batch.
    if (live.execution?.promise) await live.execution.promise;
    const cancelled = this.cancelledResult(sessionId, live); if (cancelled) return cancelled;
    if (live.page.isClosed()) fail('浏览器已关闭，无法接管', 'SESSION_NOT_LIVE');
    const leaseToken = randomBytes(32).toString('hex'); live.leaseHash = digest(leaseToken);
    this.saveSession(live, { status: 'manual' });
    const observation = await this.read(sessionId); if (observation?.cancelled) return observation;
    const screenshot = await this.screenshot(sessionId); if (screenshot?.cancelled) return screenshot;
    this.audit('takeover', '人工独占控制；智能体输入已暂停', live.taskId);
    return { session: this.getSession(sessionId), leaseToken, observation };
  }
  requireLease(live, leaseToken) {
    if (this.getSession(live.id).status !== 'manual' || typeof leaseToken !== 'string' || !sameSecret(digest(leaseToken), live.leaseHash)) fail('人工控制租约无效', 'MANUAL_LEASE');
  }
  async manualAction(sessionId, { leaseToken, observationId, action } = {}) {
    const live = this.mustLive(sessionId); this.requireLease(live, leaseToken);
    if (live.manualBusy) fail('上一条人工操作尚未结束', 'SESSION_BUSY');
    if (!live.observation || live.observation.observationId !== observationId) fail('人工页面观察已过期，请先重新读取', 'OBSERVATION_STALE');
    const base = clone(live.observation), [normalized] = this.normalizeActions(base, [action]);
    live.manualBusy = true; let inputStarted = false;
    try {
      const current = await this.observe(live);
      if (current.pageVersion !== base.pageVersion) fail('页面已变化，请重新读取再操作', 'OBSERVATION_STALE');
      await this.resolveAction(live, normalized); inputStarted = true; live.writeWindow = true;
      await this.performAction(live, normalized); await this.settle(live); live.writeWindow = false;
      const observation = await this.read(sessionId); if (observation?.cancelled) fail('人工操作后会话被取消', 'CANCELLED');
      const screenshot = await this.screenshot(sessionId); if (screenshot?.cancelled) fail('人工操作后会话被取消', 'CANCELLED');
      this.audit('manual_action', `人工执行${normalized.type}动作；未开放任意脚本`, live.taskId);
      return { session: this.getSession(sessionId), observation };
    } catch (error) { if (inputStarted) fail('人工输入可能已生效；请核实页面，不自动重复', 'MANUAL_OUTCOME_UNKNOWN'); throw error; }
    finally { live.manualBusy = false; live.writeWindow = false; }
  }
  async resume(sessionId, { leaseToken } = {}) {
    const ended = this.cancelledResult(sessionId); if (ended) return ended;
    const live = this.mustLive(sessionId); this.requireLease(live, leaseToken);
    if (live.manualBusy) fail('人工操作尚未结束', 'SESSION_BUSY');
    live.leaseHash = null; live.manualRequested = false;
    for (const approval of this.store.all('browser_approvals')) if (approval.sessionId === sessionId && approval.status === 'pending') this.store.put('browser_approvals', approval.id, { ...approval, status: 'stale', endedAt: now(), error: '人工接管后必须重新提案和审批' });
    this.saveSession(live, { status: 'agent' });
    const observation = await this.read(sessionId);
    if (observation?.cancelled) return observation;
    const screenshot = await this.screenshot(sessionId);
    if (screenshot?.cancelled) return screenshot;
    this.audit('resumed', '已重新观察人工修改；旧的待批输入失效', live.taskId);
    return { session: this.getSession(sessionId), observation };
  }
  async dispose(live) {
    live.closed = true; live.writeWindow = false; live.leaseHash = null;
    await live.context?.close().catch(() => {}); await live.browser?.close().catch(() => {}); await live.proxy?.close().catch(() => {});
    this.live.delete(live.id);
  }
  async cancel(sessionId, reason = '用户取消浏览器会话') {
    const live = this.live.get(sessionId); const session = this.getSession(sessionId);
    if (!live) return session;
    live.manualRequested = true; live.writeWindow = false;
    this.saveSession(live, { status: 'cancelled', endedAt: now(), error: this.sanitize(cleanText(reason, 300)) });
    if (live.execution) live.execution.controller.abort();
    await this.dispose(live); if (live.execution?.promise) await live.execution.promise;
    for (const approval of this.store.all('browser_approvals')) if (approval.sessionId === sessionId && approval.status === 'pending') this.store.put('browser_approvals', approval.id, { ...approval, status: 'cancelled', endedAt: now(), error: this.sanitize(cleanText(reason, 300)) });
    const ended = { ...this.store.get('controlled_sessions', sessionId), status: 'cancelled', endedAt: now(), error: this.sanitize(cleanText(reason, 300)) };
    this.store.put('controlled_sessions', sessionId, ended); this.audit('session_closed', cleanText(reason,300), session.taskId); return publicSession(ended);
  }
  async close() {
    if (this.closed) return;
    for (const live of [...this.live.values()]) await this.cancel(live.id, '浏览器服务关闭；不会跨重启重放输入');
    this.closed = true;
  }
}
