'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { exactKeys } = require('./vault.cjs');
const policy = require('./update-policy.cjs');
const ERROR_TEXT = Object.freeze({
  UNSUPPORTED: '在线更新暂仅支持已安装的 Windows x64 客户端；其他平台请手动下载。',
  UNAVAILABLE: '更新服务暂不可用，请重试检查；当前版本是否最新尚未确认。',
  NO_RELEASE: '当前渠道暂无可用发布；未确认当前版本是最新版。',
  INVALID_METADATA: '发布信息不完整或不符合更新规则；未下载或执行安装包。',
  INVALID_SOURCE: '更新来源不符合固定 GitHub 发布源；已停止。',
  RATE_LIMIT: 'GitHub 暂时限流，请稍后重新检查。',
  HTTP_ERROR: 'GitHub 发布服务返回错误，请稍后重试。',
  TIMEOUT: '下载或检查超时，请重试；下载会从头开始。',
  NETWORK: '无法连接更新服务，请检查网络后重试。',
  DISK_SPACE: '可用磁盘空间不足。下载需安装包大小的两倍加 128 MiB；安装卷需至少 2 GiB（保守门槛，并非精确解包保证）。',
  FILE_SECURITY: '无法确认更新缓存路径、当前账户权限或互联网来源标记；未执行安装包。',
  FILE_CHANGED: '已下载的安装包发生变化或校验失败，请重新下载。',
  DOWNLOAD_INVALID: '下载内容、大小或 SHA-256 不匹配；未执行安装包，请重试下载。',
  INSTALL_SCOPE: '未确认这是当前用户拥有且可写的安装，或存在全用户安装；请手动处理安装。',
  INSTALL_BUSY: '任务、邮件、本机操作或网页动作仍在进行，请完成或停止操作，并关闭受控浏览器会话后再安装。',
  SHUTDOWN: '本地服务未确认完整关闭；未启动安装器。请重新打开当前版本。仅内存中的密钥需重新输入。',
  LAUNCH: 'Windows 未接受打开安装器的请求；未确认安装完成。请重新打开当前版本或从官方发布页手动安装。仅内存中的密钥需重新输入。',
  INVALID: '更新操作已过期或格式无效，请重新检查版本。',
  INSTALL_NOT_CONFIRMED: '上次已请求 Windows 打开安装向导，但当前启动版本未达到目标；安装未确认完成。可重新检查后重试。',
});
const PHASES = new Set(['unsupported', 'idle', 'checking', 'current', 'available', 'downloading', 'verifying', 'ready', 'cancelled', 'error', 'confirming', 'blocked', 'launching', 'launch-pending', 'updated']);
function updateInput(input) {
  if (!exactKeys(input, ['candidateId']) || typeof input.candidateId !== 'string' || !/^[a-f0-9]{32}$/.test(input.candidateId)) throw Object.assign(new Error('INVALID'), { code: 'INVALID' });
  return input.candidateId;
}
function checkUpdateInput(input) {
  if (input === undefined || exactKeys(input, [])) return null;
  if (!exactKeys(input, ['channel']) || !['stable', 'preview'].includes(input.channel)) throw Object.assign(new Error('INVALID'), { code: 'INVALID' });
  return input.channel;
}
function publicUpdateState(value) {
  if (!value || typeof value.supported !== 'boolean' || typeof value.currentVersion !== 'string' || value.currentVersion.length > 100 || !PHASES.has(value.phase) || !['preview', 'stable'].includes(value.channel)) throw new Error('INVALID');
  const result = { supported: value.supported, currentVersion: value.currentVersion, channel: value.channel, phase: value.phase };
  if (value.candidate) {
    if (!/^[a-f0-9]{32}$/.test(value.candidate.id || '')) throw new Error('INVALID');
    const c = value.candidate;
    policy.parseReleaseVersion(c.version);
    if (!Number.isSafeInteger(c.sizeBytes) || c.sizeBytes <= 0 || c.sizeBytes > policy.MAX_ASSET_BYTES || !/^[a-f0-9]{64}$/.test(c.sha256 || '') || c.releaseUrl !== policy.releaseURL(c.version) || c.unsigned !== true || typeof c.releaseDate !== 'string' || c.releaseDate.length > 40 || !Number.isFinite(Date.parse(c.releaseDate))) throw new Error('INVALID');
    result.candidate = { id: c.id, version: c.version, sizeBytes: c.sizeBytes, sha256: c.sha256, releaseDate: c.releaseDate, releaseNotes: policy.sanitizeReleaseNotes(c.releaseNotes), releaseUrl: c.releaseUrl, unsigned: true };
  }
  if (Number.isSafeInteger(value.bytesReceived) && value.bytesReceived >= 0) result.bytesReceived = value.bytesReceived;
  if (Number.isFinite(value.percent)) result.percent = Math.min(100, Math.max(0, value.percent));
  if (value.error) {
    const code = Object.hasOwn(ERROR_TEXT, value.error.code) ? value.error.code : 'UNAVAILABLE';
    result.error = { code, message: ERROR_TEXT[code], retryable: value.error.retryable === true };
  }
  if (Number.isSafeInteger(value.retryAt) && value.retryAt > 0) result.retryAt = value.retryAt;
  return result;
}
class UpdateManager {
  constructor({ currentVersion, supported, files, transport, lifecycle, journal, now = Date.now, cooldownMs = 30000, downloadTimeoutMs = 30 * 60 * 1000, idleTimeoutMs = 30000 }) {
    Object.assign(this, { files, transport, lifecycle, journal, now, cooldownMs, downloadTimeoutMs, idleTimeoutMs });
    this.state = { supported, currentVersion, channel: policy.DEFAULT_CHANNEL, phase: supported ? 'idle' : 'unsupported', bytesReceived: 0, percent: 0 };
    if (!supported) this.state.error = { code: 'UNSUPPORTED', retryable: false };
    this.candidate = null; this.record = null; this.operation = null; this.generation = 0; this.lastCheckAt = -Infinity; this.closed = false;
  }
  status() { return publicUpdateState(this.state); }
  transition(phase, fields = {}) { this.state = { ...this.state, phase, ...fields }; }
  fail(error, phase = 'error') {
    const aliases = { SOURCE_CHANGED: 'INVALID_SOURCE', UNSAFE_URL: 'INVALID_SOURCE', REDIRECT_LIMIT: 'INVALID_SOURCE', UNSAFE_SESSION: 'INVALID_SOURCE', SOURCE_NOT_FOUND: 'UNAVAILABLE', RATE_LIMITED: 'RATE_LIMIT', NETWORK_ERROR: 'NETWORK', INVALID_VERSION: 'INVALID_METADATA', INVALID_CHANNEL: 'INVALID_METADATA', INVALID_JSON: 'INVALID_METADATA', CACHE_MISS: 'UNAVAILABLE', INVALID_HEADERS: 'DOWNLOAD_INVALID', INVALID_LENGTH: 'DOWNLOAD_INVALID', INVALID_EXECUTABLE: 'DOWNLOAD_INVALID', BODY_TOO_LARGE: 'DOWNLOAD_INVALID', SIZE_MISMATCH: 'DOWNLOAD_INVALID', CONTENT_TYPE: 'DOWNLOAD_INVALID', INVALID_CONTENT_TYPE: 'DOWNLOAD_INVALID', INVALID_ENCODING: 'DOWNLOAD_INVALID', STREAM_ABORTED: 'NETWORK', STREAM_ERROR: 'NETWORK', AUTH_REQUIRED: 'NETWORK', UNSAFE_REDIRECT: 'INVALID_SOURCE', FIRST_BYTE_TIMEOUT: 'TIMEOUT', IDLE_TIMEOUT: 'TIMEOUT', TOTAL_TIMEOUT: 'TIMEOUT', TIMEOUT_FIRST_BYTE: 'TIMEOUT', TIMEOUT_IDLE: 'TIMEOUT', TIMEOUT_TOTAL: 'TIMEOUT' };
    const normalized = aliases[error?.code] || error?.code;
    let code = Object.hasOwn(ERROR_TEXT, normalized) ? normalized : 'UNAVAILABLE';
    this.transition(phase, { error: { code, retryable: !['UNSUPPORTED', 'FILE_SECURITY', 'INSTALL_SCOPE'].includes(code) } });
    if (Number.isFinite(error?.retryAfterMs)) this.state.retryAt = this.now() + Math.min(86400000, Math.max(1000, error.retryAfterMs));
  }
  begin(work) {
    const generation = ++this.generation;
    const controller = new AbortController();
    const operation = { generation, controller, promise: null };
    this.operation = operation;
    operation.promise = Promise.resolve().then(() => work(controller.signal, generation)).catch(error => {
      if (!this.closed && generation === this.generation && !controller.signal.aborted) this.fail(error);
    }).finally(() => { if (this.operation === operation) this.operation = null; });
  }
  checkUpdate(input) {
    const channel = checkUpdateInput(input) || this.state.channel;
    if (!this.state.supported || this.closed || this.operation || this.state.phase === 'launch-pending') return this.status();
    const changed = channel !== this.state.channel;
    if (changed) {
      // A preview candidate can never remain installable after requesting stable.
      this.candidate = null;
      this.transition('idle', { channel, candidate: undefined, bytesReceived: 0, percent: 0, error: undefined });
      this.lastCheckAt = -Infinity;
    }
    if (this.now() < (this.state.retryAt || 0)) { this.fail({ code: 'RATE_LIMIT' }); return this.status(); }
    if (this.now() - this.lastCheckAt < this.cooldownMs) return this.status();
    this.lastCheckAt = this.now();
    this.candidate = null;
    this.transition('checking', { channel, candidate: undefined, error: undefined, retryAt: undefined });
    this.begin(async (signal, generation) => {
      if (this.record) await this.files.discard(this.record);
      this.record = null;
      const { repository, releases } = await this.transport.fetchReleases({ signal });
      policy.validateRepository(repository);
      const candidate = policy.chooseCandidate(releases, { currentVersion: this.state.currentVersion, channel: this.state.channel });
      if (signal.aborted || generation !== this.generation) return;
      this.candidate = candidate ? Object.freeze({ ...candidate, channel: this.state.channel, id: randomBytes(16).toString('hex') }) : null;
      this.transition(candidate ? 'available' : 'current', { candidate: this.candidate || undefined, bytesReceived: 0, percent: 0 });
    });
    return this.status();
  }
  assertCandidate(input) {
    const id = updateInput(input);
    if (!this.state.supported || this.closed || !this.candidate || this.candidate.id !== id || this.candidate.channel !== this.state.channel || policy.compareVersions(this.candidate.version, this.state.currentVersion) <= 0) throw Object.assign(new Error('INVALID'), { code: 'INVALID' });
    return this.candidate;
  }
  downloadUpdate(input) {
    const candidate = this.assertCandidate(input);
    if (this.operation || this.state.phase === 'launch-pending') return this.status();
    if (!['available', 'cancelled', 'error', 'blocked', 'ready'].includes(this.state.phase)) throw Object.assign(new Error('INVALID'), { code: 'INVALID' });
    this.transition('downloading', { error: undefined, bytesReceived: 0, percent: 0 });
    this.begin(async (signal, generation) => {
      if (this.record) await this.files.discard(this.record);
      this.record = null;
      const record = await this.files.create(candidate);
      this.record = record;
      let idleTimer;
      const totalTimer = setTimeout(() => this.operation?.controller.abort('TIMEOUT'), this.downloadTimeoutMs);
      const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => this.operation?.controller.abort('TIMEOUT'), this.idleTimeoutMs); };
      resetIdle();
      let stream, bytes = 0, magic = Buffer.alloc(0);
      const hash = createHash('sha256');
      try {
        const response = await this.transport.openAssetStream({ candidate, signal });
        stream = response.stream;
        const aborted = () => stream.destroy(Object.assign(new Error('abort'), { code: signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED' }));
        signal.addEventListener('abort', aborted, { once: true });
        try {
          if (signal.aborted) aborted();
          const length = response.headers['content-length'];
          const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
          if (response.statusCode !== 200 || length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== candidate.sizeBytes) || !policy.ASSET_CONTENT_TYPES.includes(type)) throw Object.assign(new Error('DOWNLOAD_INVALID'), { code: 'DOWNLOAD_INVALID' });
          for await (const chunk of stream) {
            if (signal.aborted) throw Object.assign(new Error('abort'), { code: signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED' });
            resetIdle();
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;
            if (bytes > candidate.sizeBytes || bytes > 1024 ** 3) throw Object.assign(new Error('DOWNLOAD_INVALID'), { code: 'DOWNLOAD_INVALID' });
            if (magic.length < 2) magic = Buffer.concat([magic, data]).subarray(0, 2);
            hash.update(data);
            // FileHandle.write can be short; explicit offset and bounded chunks retain backpressure.
            let offset = 0;
            while (offset < data.length) { const { bytesWritten } = await record.handle.write(data, offset, data.length - offset); if (!bytesWritten) throw new Error('write'); offset += bytesWritten; }
            if (!signal.aborted && generation === this.generation) this.transition('downloading', { bytesReceived: bytes, percent: bytes / candidate.sizeBytes * 100 });
          }
        } finally { signal.removeEventListener('abort', aborted); }
        if (signal.aborted) throw Object.assign(new Error('abort'), { code: signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED' });
        this.transition('verifying');
        if (bytes !== candidate.sizeBytes || magic.toString('ascii') !== 'MZ' || hash.digest('hex') !== candidate.sha256) throw Object.assign(new Error('DOWNLOAD_INVALID'), { code: 'DOWNLOAD_INVALID' });
        await record.handle.sync(); await record.handle.close(); record.handle = null;
        await this.files.finish(record, candidate);
        await this.files.verify(record, candidate);
        if (signal.aborted || generation !== this.generation) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
        this.transition('ready', { error: undefined, bytesReceived: bytes, percent: 100 });
      } catch (error) {
        stream?.destroy();
        await this.files.discard(record);
        if (this.record === record) this.record = null;
        if (generation === this.generation && !this.closed) {
          if (signal.aborted && signal.reason !== 'TIMEOUT') this.transition('cancelled', { error: undefined, bytesReceived: 0, percent: 0 });
          else this.fail(signal.reason === 'TIMEOUT' ? { code: 'TIMEOUT' } : error);
        }
      } finally { clearTimeout(totalTimer); clearTimeout(idleTimer); }
    });
    return this.status();
  }
  cancelUpdate() {
    if (['downloading', 'verifying'].includes(this.state.phase) && this.operation) {
      this.operation.controller.abort('CANCELLED');
      this.transition('cancelled', { error: undefined });
    }
    return this.status();
  }
  installUpdate(input) {
    const candidate = this.assertCandidate(input);
    if (this.operation || ['launching', 'launch-pending'].includes(this.state.phase)) return this.status();
    if (!this.record || !['ready', 'blocked'].includes(this.state.phase)) throw Object.assign(new Error('INVALID'), { code: 'INVALID' });
    this.transition('confirming', { error: undefined });
    this.begin(async signal => {
      const active = () => { if (this.closed || signal.aborted) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }); };
      let gate = false, shutdownStarted = false;
      try {
        await this.files.verify(this.record, candidate);
        await this.files.installSpace(this.lifecycle.executable); active();
        if (!await this.lifecycle.confirm(candidate)) { if (!this.closed) this.transition('ready'); return; }
        active();
        const readiness = await this.lifecycle.prepare();
        if (readiness?.ready !== true) { this.fail({ code: 'INSTALL_BUSY' }, 'blocked'); return; }
        gate = true; active();
        await this.files.verify(this.record, candidate);
        await this.journal?.write(candidate); active();
        this.transition('launching');
        shutdownStarted = true;
        if (await this.lifecycle.shutdown() !== true) throw Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' });
        // This is the normal Shell open, with preserved MOTW and no flags. Its
        // empty error response acknowledges an open request, never installation.
        active();
        const file = await this.files.verify(this.record, candidate); active();
        this.transition('launch-pending');
        const error = await this.lifecycle.launch(file);
        if (error !== '') throw Object.assign(new Error('LAUNCH'), { code: 'LAUNCH' });
        await this.lifecycle.exit();
      } catch (error) {
        await this.journal?.clear().catch(() => {});
        if (this.closed) return;
        this.fail(error, error?.code === 'INSTALL_BUSY' ? 'blocked' : 'error');
        if (shutdownStarted) await this.lifecycle.recover?.(this.state.error.code).catch(() => {});
      } finally { if (gate && !shutdownStarted) await this.lifecycle.release?.(); }
    });
    return this.status();
  }
  async verifyStartup(backendVersion) {
    const pending = await this.journal?.read();
    if (!pending) return;
    if (pending.version === this.state.currentVersion && backendVersion === this.state.currentVersion) {
      this.transition('updated', { error: undefined }); await this.journal.clear();
    } else this.fail({ code: 'INSTALL_NOT_CONFIRMED' });
  }
  async waitForIdle() { await this.operation?.promise; }
  close() { this.closed = true; this.operation?.controller.abort('CANCELLED'); }
}
module.exports = { UpdateManager, publicUpdateState, updateInput, checkUpdateInput, ERROR_TEXT };
