import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { redactSecrets } from './redact.mjs';

const MAX_BYTES = 256 * 1024, MAX_OUTPUT = 64 * 1024, MAX_PENDING = 20;
const MODES = new Set(['disabled', 'read_only', 'confirm', 'full']);
const CONFIRMATION = '我理解本机完全访问风险';
const clone = value => structuredClone(value);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const text = (value, label, limit = 4096) => { if (typeof value !== 'string' || !value.trim() || value.length > limit || /\0/.test(value)) throw new Error(`${label}无效`); return value; };
const exactKeys = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('本机操作参数未获允许'); };
const safeOutput = (value, secrets) => redactSecrets(value, secrets).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[敏感凭据已隐藏]').replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[敏感凭据已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[敏感凭据已隐藏]');

export function validateLocalAbsolutePath(value, pathAPI = path, platform = process.platform) {
    text(value, '绝对路径');
    if (!pathAPI.isAbsolute(value)) throw new Error('请使用本机绝对路径');
    if (platform === 'win32' && (/^[\\/]{2}/.test(value) || /^(?:\\\\[?.]\\)/.test(value) || value.slice(2).includes(':') || value.split(/[\\/]/).some(p => /[. ]$/.test(p) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))) throw new Error('不支持网络路径、设备路径、备用数据流或不规范Windows路径');
    const normalized = pathAPI.normalize(value);
    return normalized === pathAPI.parse(normalized).root ? normalized : normalized.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  }

/** Application-level authorization, deliberately NOT an OS command sandbox. */
export class LocalAccessService {
  #digestKey = randomBytes(32);
  digest(value) { return createHmac('sha256', this.#digestKey).update(JSON.stringify(value)).digest('hex'); }
  constructor(store, { getSecrets = () => [], protectedPaths = [] } = {}) {
    this.store = store; this.getSecrets = getSecrets; this.operations = new Map(); this.challenges = new Map(); this.running = new Map(); this.closed = false; this.inflight = new Set();
    this.protectedPaths = [...protectedPaths, store.dir].map(p => path.resolve(p));
    const saved = store.get('local_access', 'policy');
    this.policy = saved && MODES.has(saved.mode) ? { ...saved, mode: saved.mode === 'full' ? 'confirm' : saved.mode, allFiles: false, revision: (saved.revision || 0) + 1 } : { mode: 'disabled', roots: [], allFiles: false, revision: 1, configured: false };
    for (const record of store.all('local_operations')) {
      if (['pending', 'executing'].includes(record.status)) this.store.put('local_operations', record.id, { ...record, status: 'invalidated', finishedAt: new Date().toISOString(), error: '程序重启，旧操作不会重放' });
    }
    this.persistPolicy();
  }
  persistPolicy() { this.store.put('local_access', 'policy', this.policy); }
  clean(value) { return safeOutput(typeof value === 'string' ? value : JSON.stringify(value), this.getSecrets()); }
  state() {
    this.expire();
    return { ...clone(this.policy), platform: process.platform, executionBoundary: 'application_authorization',
      limitations: ['文件工具只访问所选文件夹；完全访问可另行明确允许全部文件。', '命令以当前用户权限在本机执行；文件夹范围不隔离命令，命令可能访问其他文件或网络。', '这是应用层授权，不是操作系统沙箱，也不会授予管理员、屏幕录制或辅助功能权限。', '撤销会使旧审批失效并停止当前受管理进程；已发生的修改与外部操作不能撤回，逃逸的子进程不能保证终止。', 'API 模式下，文件内容及命令结果可能发送给你配置的模型服务。', '完全访问不会跨程序重启自动恢复；重启后降为操作前确认。'],
      pending: [...this.operations.values()].filter(o => o.status === 'pending').map(o => clone(o.public)),
      operations: this.store.all('local_operations').slice(0, 100).map(o => clone(o)), };
  }
  pathValue(value) { return validateLocalAbsolutePath(value); }
  checkProtected(target) {
    if (this.protectedPaths.some(p => inside(p, target))) throw new Error('应用程序、内部数据库与凭据目录不开放给本机工具');
    const parts = target.split(/[\\/]/).filter(Boolean);
    if (parts.some(p => /^(?:\.ssh|\.aws|\.gnupg|\.codex|\.azure|\.kube|\.npmrc|\.netrc|\.git-credentials|\.docker|gcloud|application_default_credentials\.json|\.env(?:\..*)?|credentials(?:\.[^.]*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|Login Data|Cookies|keychain.*)$/i.test(p)) || /\.(?:pem|pfx|p12|key|kdbx)$/i.test(target)) throw new Error('敏感凭据路径未开放');
    if (process.platform !== 'win32' && ['/proc', '/sys', '/dev', '/run'].some(p => inside(p, target))) throw new Error('系统设备与进程接口不开放');
  }
  // Reject every symlink / Windows junction in the path, not only the leaf.
  inspect(target, { missingLeaf = false } = {}) {
    this.checkProtected(target);
    const parsed = path.parse(target); let cursor = parsed.root, stats = [];
    for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      let stat;
      try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT' && missingLeaf && cursor === target) return { exists: false, stats }; throw new Error('路径不存在或当前用户无访问权限'); }
      if (stat.isSymbolicLink()) throw new Error('禁止通过符号链接或目录联接访问文件');
      if (cursor !== target && !stat.isDirectory()) throw new Error('父路径不是文件夹');
      stats.push({ path: cursor, stat });
    }
    const real = fs.realpathSync(target);
    if (path.normalize(real).toLowerCase() !== target.toLowerCase() && process.platform === 'win32' || process.platform !== 'win32' && real !== target) throw new Error('路径规范化校验失败');
    this.checkProtected(real);
    return { exists: true, stat: fs.lstatSync(target), stats };
  }
  normalizeRoots(roots) {
    if (!Array.isArray(roots) || roots.length > 12) throw new Error('最多允许12个本机文件夹');
    return [...new Set(roots.map(raw => { const p = this.pathValue(raw); const s = this.inspect(p); if (!s.stat.isDirectory()) throw new Error('授权范围必须是已有文件夹'); if (p === path.parse(p).root) throw new Error('整盘范围需要完全访问及全部文件二次确认'); return p; }))];
  }
  scope(input) {
    const roots = this.normalizeRoots(input.roots ?? this.policy.roots);
    if (input.allFiles !== undefined && typeof input.allFiles !== 'boolean') throw new Error('全部文件选项无效');
    return { roots, allFiles: input.allFiles === true };
  }
  requestFullAccess(input) {
    exactKeys(input, ['roots', 'allFiles']); if (this.closed) throw new Error('本机工具已关闭');
    const scope = this.scope(input); if (!scope.allFiles && !scope.roots.length) throw new Error('请先选择文件夹或明确选择全部文件');
    const challenge = randomBytes(32).toString('hex'), expiresAt = Date.now() + 120000;
    this.challenges.clear(); this.challenges.set(challenge, { digest: this.digest(scope), revision: this.policy.revision, expiresAt });
    return { challenge, expiresAt: new Date(expiresAt).toISOString(), summary: '完全访问会立即执行本机文件修改和命令，不逐项询问。命令不受文件夹范围隔离，能够访问当前用户拥有权限的文件和网络。不能自动获得管理员、屏幕录制或辅助功能权限。已发生操作无法通过撤销恢复。' };
  }
  configure(input) {
    exactKeys(input, ['mode', 'roots', 'allFiles', 'onboardingComplete', 'challenge', 'confirmation']); if (!MODES.has(input.mode) || this.closed) throw new Error('权限模式无效');
    if (input.onboardingComplete !== undefined && typeof input.onboardingComplete !== 'boolean') throw new Error('引导选项无效');
    const scope = input.mode === 'disabled' ? { roots: [], allFiles: false } : this.scope(input);
    if (input.mode !== 'disabled' && !scope.roots.length && !scope.allFiles) throw new Error('请明确选择至少一个本机文件夹');
    if (input.mode !== 'full' && scope.allFiles) throw new Error('全部文件仅在完全访问二次确认后开放');
    if (input.mode === 'full') {
      const challenge = this.challenges.get(input.challenge);
      if (!challenge || challenge.expiresAt < Date.now() || challenge.revision !== this.policy.revision || challenge.digest !== this.digest(scope) || input.confirmation !== CONFIRMATION) throw new Error('完全访问需要有效的范围绑定二次确认');
    }
    this.invalidateAll('权限或范围已改变，旧审批失效'); this.challenges.clear();
    this.policy = { mode: input.mode, ...scope, revision: this.policy.revision + 1, configured: input.onboardingComplete === true || this.policy.configured };
    this.persistPolicy(); this.store.audit('local_access.changed', `本机授权更新：${input.mode}；范围${scope.allFiles ? '全部文件' : scope.roots.length + '个文件夹'}`);
    return this.state();
  }
  revoke() { return this.configure({ mode: 'disabled', onboardingComplete: true }); }
  authorizePath(raw, options = {}) {
    if (this.closed || this.policy.mode === 'disabled') throw new Error('尚未连接本机访问权限');
    const p = this.pathValue(raw); const check = this.inspect(p, options);
    if (!this.policy.allFiles && !this.policy.roots.some(root => inside(root, p))) throw new Error('路径超出明确授权的文件夹范围');
    // Recheck roots too, so swapping an authorized root for a link does not grant access.
    for (const root of this.policy.roots.filter(r => inside(r, p))) if (!this.inspect(root).stat.isDirectory()) throw new Error('授权文件夹已变化');
    return { path: p, ...check };
  }
  normalize(input) {
    exactKeys(input, ['kind', 'path', 'content', 'executable', 'args', 'cwd', 'timeoutMs']);
    if (!['list', 'read', 'write', 'command'].includes(input.kind)) throw new Error('未开放的本机操作');
    if (this.policy.mode === 'disabled' || this.closed) throw new Error('尚未连接本机访问权限');
    if (input.kind === 'command') {
      if (this.policy.mode === 'read_only') throw new Error('只读模式禁止本机命令');
      const executable = this.pathValue(input.executable); const check = this.inspectExecutable(executable);
      if (!Array.isArray(input.args) || input.args.length > 80 || input.args.some(a => typeof a !== 'string' || a.length > 12000 || /\0/.test(a)) || JSON.stringify(input.args).length > 30000) throw new Error('命令参数类型或长度无效');
      const cwd = this.authorizePath(input.cwd); if (!cwd.stat.isDirectory()) throw new Error('命令工作目录必须是授权文件夹');
      const timeoutMs = input.timeoutMs ?? 15000; if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('命令超时范围为100至60000毫秒');
      const operation = { kind: input.kind, executable, args: [...input.args], cwd: cwd.path, timeoutMs };
      this.rejectSecrets(operation); return { ...operation, executableIdentity: { dev: check.stat.dev, ino: check.stat.ino, size: check.stat.size, mtimeMs: check.stat.mtimeMs } };
    }
    if (Object.keys(input).some(k => !['kind', 'path', 'content'].includes(k))) throw new Error('文件工具参数未获允许');
    if (input.kind === 'write' && this.policy.mode === 'read_only') throw new Error('只读模式禁止文件写入');
    const check = this.authorizePath(input.path, { missingLeaf: input.kind === 'write' });
    if (input.kind === 'list' && !check.stat.isDirectory() || ['read', 'write'].includes(input.kind) && check.exists && (!check.stat.isFile() || check.stat.nlink !== 1)) throw new Error('仅支持普通文件或文件夹，硬链接和设备被拒绝');
    const operation = { kind: input.kind, path: check.path };
    if (input.kind === 'write') { if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_BYTES || input.content.includes('\0')) throw new Error('文件内容须为不超过256KiB的纯文本'); operation.content = input.content; operation.contentDigest = this.digest(input.content); this.rejectSecrets(operation); }
    return operation;
  }
  inspectExecutable(executable) {
    // Common system executable aliases (/usr/bin/node, /bin/sh) may be symlinks.
    // Resolve once, bind the executable identity, and check again before spawn.
    let real; try { real = fs.realpathSync(executable); } catch { throw new Error('命令程序不存在'); }
    this.checkProtected(real); const stat = fs.statSync(real); if (!stat.isFile()) throw new Error('命令程序必须是本机普通可执行文件');
    if (process.platform === 'win32' && !/\.exe$/i.test(real)) throw new Error('Windows只直接运行exe；脚本须明确选择命令解释器和参数');
    return { real, stat };
  }
  rejectSecrets(value) {
    const secrets = this.getSecrets().filter(s => typeof s === 'string' && s);
    const contains = v => typeof v === 'string' ? secrets.some(s => v.includes(s)) : v && typeof v === 'object' ? Object.values(v).some(contains) : false;
    if (contains(value)) throw new Error('本机操作不得包含应用内存凭据');
  }
  metadata(record) { return { id: record.id, kind: record.payload.kind, type: record.public.type, status: record.status, taskId: record.taskId || null, createdAt: record.createdAt, digest: record.digest, finishedAt: record.finishedAt, error: record.error ? '操作未完成，请在当前对话查看原因并人工核实' : undefined, revision: record.revision, summary: `${record.payload.kind === 'command' ? '本机命令' : '本机文件'} · ${record.status}` }; }
  save(record) { record.public.status = record.status; this.store.put('local_operations', record.id, this.metadata(record)); }
  prune() {
    const completed = [...this.operations.values()].filter(o => !['pending', 'executing'].includes(o.status));
    for (const record of completed.slice(0, Math.max(0, this.operations.size - 100))) this.operations.delete(record.id);
    for (const record of this.store.all('local_operations').slice(1000)) if (!['pending', 'executing'].includes(record.status)) this.store.delete('local_operations', record.id);
  }
  expire() {
    for (const o of this.operations.values()) if (o.status === 'pending') {
      if (Date.now() > o.expiresAt) this.finish(o, 'expired', '审批已过期');
      else { try { this.rejectSecrets(o.payload); } catch { this.finish(o, 'invalidated', '凭据已变化，含敏感数据的旧审批失效'); } }
    }
  }
  finish(record, status, error) { record.status = status; record.finishedAt = new Date().toISOString(); record.error = error; this.save(record); this.store.audit('local_access.operation', `${record.payload.kind} · ${status}`, record.taskId); this.prune(); }
  async propose(input, { taskId, signal, actor = 'user' } = {}) {
    this.expire(); this.prune(); if (signal?.aborted) throw new Error('本机操作已取消');
    if ([...this.operations.values()].filter(o => o.status === 'pending').length >= MAX_PENDING) throw new Error('待审批本机操作过多，请先处理');
    const payload = this.normalize(input), id = randomUUID(), createdAt = new Date().toISOString();
    const snapshot = clone(payload); delete snapshot.executableIdentity;
    const record = { id, payload, taskId, actor, createdAt, revision: this.policy.revision, digest: this.digest(payload), status: 'pending', expiresAt: Date.now() + 5 * 60000,
      public: { id, kind: payload.kind, type: 'local.' + payload.kind, taskId: taskId || null, status: 'pending', createdAt, expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), digest: this.digest(payload), summary: payload.kind === 'command' ? '运行本机命令；不受文件夹范围隔离' : payload.kind === 'write' ? '写入本机文件；可能覆盖已有内容' : '读取已授权本机文件', snapshot } };
    this.operations.set(id, record); this.save(record);
    if (['read', 'list'].includes(payload.kind) || this.policy.mode === 'full') return this.execute(record, { signal });
    return { operation: clone(record.public), pending: true };
  }
  async approve(id, { signal } = {}) {
    this.expire(); const record = this.operations.get(id);
    if (!record || record.status !== 'pending') throw new Error('审批不存在、已处理或已失效');
    if (record.revision !== this.policy.revision || record.digest !== this.digest(record.payload) || !['confirm', 'full'].includes(this.policy.mode)) { this.finish(record, 'invalidated', '审批权限或内容已变化'); throw new Error('审批权限或内容已变化'); }
    // Status is consumed synchronously before any await; double-click cannot replay.
    return this.execute(record, { signal });
  }
  reject(id) { const record = this.operations.get(id); if (!record || record.status !== 'pending') throw new Error('没有待拒绝操作'); this.finish(record, 'rejected', '用户拒绝本次操作'); return { operation: clone(record.public) }; }
  cancel(id) { const record = this.operations.get(id); if (!record || !['pending', 'executing'].includes(record.status)) return false; this.running.get(id)?.abort(); this.finish(record, 'cancelled', '操作已取消，已发生的动作不能撤回'); return true; }
  cancelTask(taskId) { for (const record of this.operations.values()) if (record.taskId === taskId) this.cancel(record.id); }
  invalidateAll(reason) { for (const record of this.operations.values()) if (['pending', 'executing'].includes(record.status)) { this.running.get(record.id)?.abort(); this.finish(record, 'invalidated', reason); } }
  verifyAncestors(check) { for (const item of check.stats) { const current = fs.lstatSync(item.path); if (current.isSymbolicLink() || !sameFile(current, item.stat)) throw new Error('路径在执行前已变化'); } }
  fileOperation(payload) {
    const check = this.authorizePath(payload.path, { missingLeaf: payload.kind === 'write' }); this.verifyAncestors(check);
    if (payload.kind === 'list') {
      if (!check.stat.isDirectory()) throw new Error('目录已变化');
      const directory = fs.opendirSync(check.path), entries = [];
      try { let e; while (entries.length < 200 && (e = directory.readSync())) entries.push({ name: this.clean(e.name), type: e.isSymbolicLink() ? 'blocked_link' : e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'blocked_special' }); } finally { directory.closeSync(); }
      return { path: check.path, entries, limit: 200 };
    }
    let fd, created = false;
    try {
      const flags = payload.kind === 'read' ? fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) : fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0) | (!check.exists ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
      fd = fs.openSync(check.path, flags, 0o600); created = !check.exists;
      const current = fs.fstatSync(fd); if (!current.isFile() || current.nlink !== 1 || check.exists && !sameFile(current, check.stat)) throw new Error('文件对象变化或非普通文件');
      this.verifyAncestors(check);
      const after = this.authorizePath(check.path); if (!sameFile(current, after.stat)) throw new Error('文件路径在打开期间变化');
      if (payload.kind === 'read') { if (current.size > MAX_BYTES) throw new Error('文本读取上限256KiB'); const bytes = Buffer.alloc(current.size); const size = fs.readSync(fd, bytes, 0, bytes.length, 0); const value = bytes.subarray(0, size).toString('utf8'); if (value.includes('\0')) throw new Error('只支持纯文本读取'); return { path: check.path, content: this.clean(value), bytes: size }; }
      const bytes = Buffer.from(payload.content); fs.ftruncateSync(fd, 0); let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); fs.fsyncSync(fd);
      return { path: check.path, bytes: bytes.length, contentDigest: payload.contentDigest, written: true };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  commandEnvironment() {
    const allow = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
    return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allow.some(a => a.toLowerCase() === key.toLowerCase()) && typeof value === 'string'));
  }
  async commandOperation(record, signal) {
    const payload = record.payload; const cwd = this.authorizePath(payload.cwd); if (!cwd.stat.isDirectory()) throw new Error('命令目录已变化');
    const executable = this.inspectExecutable(payload.executable), bound = payload.executableIdentity;
    if (!sameFile(executable.stat, bound) || executable.stat.size !== bound.size || executable.stat.mtimeMs !== bound.mtimeMs) throw new Error('命令程序在审批后已变化');
    if (signal.aborted) throw new Error('本机命令已取消');
    return new Promise((resolve, reject) => {
      let child, timer, stopReason = '', bytes = 0, out = [], err = [], settled = false;
      const kill = () => {
        if (!child?.pid) return;
        try {
          if (process.platform === 'win32') {
            const root = process.env.SystemRoot || process.env.WINDIR;
            if (root && path.isAbsolute(root)) { const killer = spawn(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', env: this.commandEnvironment() }); killer.on('error', () => { try { child.kill(); } catch {} }); }
            else child.kill();
          } else process.kill(-child.pid, 'SIGKILL');
        } catch { try { child.kill('SIGKILL'); } catch {} }
      };
      const stop = reason => { if (!stopReason) stopReason = reason; kill(); };
      const onAbort = () => stop('命令已取消或本机权限已撤销');
      try { child = spawn(executable.real, payload.args, { cwd: cwd.path, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: this.commandEnvironment() }); }
      catch { reject(new Error('本机命令无法启动')); return; }
      const collect = (array, data) => { bytes += data.length; if (bytes > MAX_OUTPUT) return stop('命令输出超过64KiB上限，已停止'); array.push(data); };
      child.stdout.on('data', d => collect(out, d)); child.stderr.on('data', d => collect(err, d));
      signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
      timer = setTimeout(() => stop('命令超过执行时限，已停止'), payload.timeoutMs);
      const finish = (error, code, terminationSignal) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); if (error || stopReason) reject(new Error(stopReason || '本机命令无法启动')); else resolve({ executable: payload.executable, cwd: payload.cwd, exitCode: code, signal: terminationSignal, stdout: this.clean(Buffer.concat(out).toString('utf8')), stderr: this.clean(Buffer.concat(err).toString('utf8')), outputBytes: bytes, executionBoundary: 'host_process_no_os_sandbox' }); };
      child.once('error', error => finish(error)); child.once('close', (code, sig) => finish(null, code, sig));
    });
  }
  async execute(record, { signal } = {}) {
    this.rejectSecrets(record.payload);
    if (signal?.aborted || record.revision !== this.policy.revision || this.closed) throw new Error('本机操作已取消或权限已改变');
    if (record.payload.kind === 'command' && this.running.size >= 2) { this.finish(record, 'failed', '本机命令并发上限为2，请等待当前操作结束'); throw new Error('本机命令并发上限为2，请等待当前操作结束'); }
    record.status = 'executing'; this.save(record);
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); this.running.set(record.id, controller);
    try {
      let result;
      if (record.payload.kind === 'command') {
        const run = this.commandOperation(record, controller.signal); this.inflight.add(run);
        try { result = await run; } finally { this.inflight.delete(run); }
      } else result = this.fileOperation(record.payload);
      if (controller.signal.aborted || record.revision !== this.policy.revision || record.status !== 'executing') throw new Error('本机权限已撤销；已发生操作不能撤回');
      this.finish(record, record.payload.kind === 'command' && result.exitCode !== 0 ? 'failed' : 'completed');
      return { operation: clone(record.public), result };
    } catch (error) { if (record.status === 'executing') this.finish(record, controller.signal.aborted ? 'cancelled' : 'failed', this.clean(error.message)); throw new Error(this.clean(error.message)); }
    finally { signal?.removeEventListener('abort', abort); this.running.delete(record.id); }
  }
  async close() { if (this.closed) return; this.invalidateAll('程序关闭，旧操作失效'); this.closed = true; this.challenges.clear(); await Promise.allSettled([...this.inflight]); }
}
export { CONFIRMATION as FULL_ACCESS_CONFIRMATION };
