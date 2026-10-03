'use strict';

const { Transform } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { API_ROOT, MAX_ASSET_BYTES, ASSET_CONTENT_TYPES, policyError, validateRepository,
  validateCandidate, validateAPIURL, validateDownloadURL } = require('./update-policy.cjs');
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUTS = Object.freeze({ firstByte: 15_000, idle: 30_000,
  metadataTotal: 60_000, assetTotal: 30 * 60_000 });
const SAFE_REQUEST_HEADERS = new Set(['accept', 'accept-encoding', 'user-agent',
  'if-none-match', 'x-github-api-version', 'host']);

// Call after app readiness. A fresh, non-persistent session has no application
// page cookies, stored authorization, renderer headers, referrer, or model keys.
function createUpdateSession(electronSession) {
  const session = electronSession.fromPartition(`luheng-update-${randomUUID()}`, { cache: false });
  if (session.isPersistent()) throw policyError('UNSAFE_SESSION', '更新需要独立内存会话');
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = {};
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (SAFE_REQUEST_HEADERS.has(name.toLowerCase())) requestHeaders[name] = value;
    }
    callback({ requestHeaders });
  });
  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(details.responseHeaders)) {
      if (!['set-cookie', 'set-cookie2'].includes(name.toLowerCase())) responseHeaders[name] = value;
    }
    callback({ responseHeaders });
  });
  return session;
}
function header(headers, name) {
  const value = headers[name];
  if (value === undefined) return null;
  const item = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof item !== 'string' || /[\r\n\u0000]/.test(item)) {
    throw policyError('INVALID_HEADERS', '更新响应头不符合要求');
  }
  return item;
}
function checkDuplicateHeaders(response) {
  const raw = response.rawHeaders || [];
  const counts = new Map();
  for (let i = 0; i < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    if (['content-length', 'content-type', 'content-encoding'].includes(name)) {
      counts.set(name, (counts.get(name) || 0) + 1);
      if (counts.get(name) > 1) throw policyError('INVALID_HEADERS', '更新响应头重复');
    }
  }
}
function contentLength(headers) {
  const value = header(headers, 'content-length');
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw policyError('INVALID_LENGTH', '更新响应长度不合法');
  }
  return Number(value);
}
function retryDelay(headers, now) {
  let milliseconds = 60_000;
  const retry = header(headers, 'retry-after');
  const reset = header(headers, 'x-ratelimit-reset');
  if (retry !== null) {
    const parsed = /^[0-9]+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
    if (Number.isFinite(parsed)) milliseconds = parsed;
  } else if (reset && /^[0-9]+$/.test(reset)) milliseconds = Number(reset) * 1000 - now;
  return Math.max(1000, Math.min(milliseconds, 24 * 60 * 60 * 1000));
}
function httpError(statusCode, headers, now) {
  if ([403, 429].includes(statusCode)) return Object.assign(
    policyError('RATE_LIMITED', '更新服务限制请求，请稍后重试'), { retryAfterMs: retryDelay(headers, now) });
  if (statusCode === 404) return policyError('SOURCE_NOT_FOUND', '固定更新来源暂时不可用');
  return policyError('HTTP_ERROR', '更新服务响应失败');
}

// Dependency injection changes clock/timeout behavior only. Source, repository
// identity, HTTPS enforcement, redirect paths, credentials and size limits are
// not configurable through this interface or any environment variable.
function createUpdateTransport({ timeouts = {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid update timeout');
  }
  const sessions = new WeakMap();
  function stateFor(session) {
    if (!session || typeof session.isPersistent !== 'function' || session.isPersistent()) {
      throw policyError('UNSAFE_SESSION', '更新需要独立内存会话');
    }
    if (!sessions.has(session)) sessions.set(session, { cache: new Map(), cooldownUntil: 0 });
    const state = sessions.get(session);
    if (state.cooldownUntil > now()) throw Object.assign(
      policyError('RATE_LIMITED', '更新服务限制请求，请稍后重试'),
      { retryAfterMs: state.cooldownUntil - now() });
    return state;
  }
  function request({ url, candidate, session, net, signal, binary, etag }) {
    const state = stateFor(session);
    if (!net || typeof net.request !== 'function') throw new TypeError('Electron net is required');
    if (binary) validateDownloadURL(url, { candidate, redirectHop: 0 }); else validateAPIURL(url);
    return new Promise((resolve, reject) => {
      let req; let response; let stream; let resolved = false; let finished = false;
      let firstTimer; let idleTimer; let totalTimer; let received = 0; let prefix = Buffer.alloc(0);
      let declaredLength = null; let hop = 0;
      const abortError = () => policyError('CANCELLED', '更新请求已取消');
      const cleanup = () => {
        for (const timer of [firstTimer, idleTimer, totalTimer]) if (timer !== undefined) clearTimer(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const fail = error => {
        if (finished) return;
        finished = true; cleanup();
        if (error.code === 'RATE_LIMITED') state.cooldownUntil = now() + error.retryAfterMs;
        if (!resolved) reject(error);
        if (stream && !stream.destroyed) stream.destroy(error);
        if (response && !response.destroyed && typeof response.destroy === 'function') response.destroy();
        if (req) req.abort();
      };
      const onAbort = () => fail(abortError());
      const progress = () => {
        if (firstTimer !== undefined) { clearTimer(firstTimer); firstTimer = undefined; }
        if (idleTimer !== undefined) clearTimer(idleTimer);
        idleTimer = setTimer(() => fail(policyError('IDLE_TIMEOUT', '更新传输长时间没有进展')), limits.idle);
      };
      if (signal && signal.aborted) { reject(abortError()); return; }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      firstTimer = setTimer(() => fail(policyError('FIRST_BYTE_TIMEOUT', '更新连接等待超时')), limits.firstByte);
      totalTimer = setTimer(() => fail(policyError('TOTAL_TIMEOUT', '更新传输超时')),
        binary ? limits.assetTotal : limits.metadataTotal);
      try {
        const headers = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
          'Accept-Encoding': 'identity', 'User-Agent': 'Luheng-Office-Agent-Updater' };
        if (!binary) headers['X-GitHub-Api-Version'] = '2022-11-28';
        if (etag) headers['If-None-Match'] = etag;
        req = net.request({ method: 'GET', url, session, credentials: 'omit',
          useSessionCookies: false, redirect: 'manual', referrerPolicy: 'no-referrer',
          cache: 'no-store', bypassCustomProtocolHandlers: true, headers });
        req.on('redirect', (statusCode, method, redirectURL) => {
          if (finished) return;
          try {
            if (!binary || method !== 'GET' || ![301, 302, 303, 307, 308].includes(statusCode)) {
              throw policyError('UNSAFE_REDIRECT', '更新来源重定向被拒绝');
            }
            validateDownloadURL(redirectURL, { candidate, redirectHop: ++hop });
            req.followRedirect(); // Electron requires a synchronous call here.
          } catch (error) { fail(error); }
        });
        req.on('login', (_authInfo, callback) => {
          callback(); fail(policyError('AUTH_REQUIRED', '更新来源不能要求登录')); // No proxy/account secrets.
        });
        req.on('error', () => fail(policyError('NETWORK_ERROR', '更新网络连接失败')));
        req.on('abort', () => { if (!finished) fail(abortError()); });
        // Do not infer response EOF from ClientRequest's Writable close: the
        // v44.5.1 implementation auto-destroys its request-body stream after
        // end(), independently of the IncomingMessage completion. Response EOF,
        // response errors/close, abort and bounded timers are the evidence.
        req.on('response', incoming => {
          response = incoming;
          // Install listeners before any stream can start flowing.
          response.on('error', () => fail(policyError('STREAM_ERROR', '更新传输失败')));
          response.on('aborted', () => fail(policyError('STREAM_ABORTED', '更新传输意外中断')));
          response.on('close', () => {
            if (!finished && !response.readableEnded) fail(policyError('STREAM_ABORTED', '更新传输意外中断'));
          });
          if (finished) { if (response.destroy) response.destroy(); return; }
          try {
            const headers = response.headers || {};
            checkDuplicateHeaders(response);
            const statusCode = response.statusCode;
            if (statusCode === 304 && !binary) {
              finished = true; cleanup(); resolved = true;
              resolve({ statusCode, headers, stream: null });
              // There is no useful 304 body. Stop even a malformed server body
              // rather than draining it without a bound or timeout.
              response.destroy(); req.abort(); return;
            }
            if (statusCode !== 200) throw httpError(statusCode, headers, now());
            const type = (header(headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
            if (!(binary ? ASSET_CONTENT_TYPES : ['application/json', 'application/vnd.github+json']).includes(type)) {
              throw policyError('INVALID_CONTENT_TYPE', '更新响应类型不符合要求');
            }
            const encoding = header(headers, 'content-encoding');
            if (encoding && encoding.toLowerCase() !== 'identity') throw policyError('INVALID_ENCODING', '更新响应编码不受支持');
            declaredLength = contentLength(headers);
            const bound = binary ? candidate.sizeBytes : MAX_JSON_BYTES;
            if (declaredLength !== null && (declaredLength > bound
              || (binary && declaredLength !== candidate.sizeBytes))) {
              throw policyError('SIZE_MISMATCH', '更新响应大小与元数据不一致');
            }
            stream = new Transform({ readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024,
              transform(chunk, _encoding, callback) {
                if (finished) { callback(abortError()); return; }
                received += chunk.length; progress();
                if (received > bound || received > MAX_ASSET_BYTES) {
                  callback(policyError('BODY_TOO_LARGE', '更新响应超过允许大小')); return;
                }
                if (binary && prefix.length < 2) {
                  const combined = prefix.length ? Buffer.concat([prefix, chunk]) : chunk;
                  if (combined.length < 2) { prefix = combined; callback(); return; }
                  if (combined[0] !== 0x4d || combined[1] !== 0x5a) {
                    callback(policyError('INVALID_EXECUTABLE', '更新正文不是 Windows 安装包')); return;
                  }
                  prefix = combined.subarray(0, 2); callback(null, combined); return;
                }
                callback(null, chunk);
              },
              flush(callback) {
                if ((declaredLength !== null && received !== declaredLength)
                  || (binary && (received !== candidate.sizeBytes || prefix.length !== 2))) {
                  callback(policyError('SIZE_MISMATCH', '更新下载不完整')); return;
                }
                finished = true; cleanup(); callback();
              },
              destroy(error, callback) {
                if (!finished) fail(error || abortError());
                callback(error);
              },
            });
            // No-op prevents a late transport failure from becoming an unhandled
            // event before the Promise consumer installs pipeline listeners.
            stream.on('error', error => fail(error));
            resolved = true;
            const publicHeaders = { 'content-type': type };
            if (declaredLength !== null) publicHeaders['content-length'] = String(declaredLength);
            if (!binary) {
              const tag = header(headers, 'etag');
              if (tag && tag.length <= 256 && /^(?:W\/)?"[^"\r\n]*"$/.test(tag)) publicHeaders.etag = tag;
            }
            resolve({ statusCode, headers: publicHeaders, stream });
            response.pipe(stream); // Node/Electron Readable.pipe propagates backpressure.
          } catch (error) { fail(error); }
        });
        req.end();
      } catch (error) { fail(error.code ? error : policyError('NETWORK_ERROR', '更新网络连接失败')); }
    });
  }

  async function fetchJSON(url, options, state) {
    const cached = state.cache.get(url);
    let result;
    try { result = await request({ ...options, url, binary: false, etag: cached?.etag }); }
    catch (error) {
      if (error.code === 'RATE_LIMITED') state.cooldownUntil = now() + error.retryAfterMs;
      throw error;
    }
    if (result.statusCode === 304) {
      if (!cached) throw policyError('CACHE_MISS', '更新缓存不可用，请重试');
      return structuredClone(cached.json);
    }
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    let json;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw policyError('INVALID_JSON', '更新元数据无法解析'); }
    state.cache.set(url, { etag: result.headers.etag, json: structuredClone(json) });
    return json;
  }
  async function fetchReleases({ session, net, signal } = {}) {
    const state = stateFor(session);
    const options = { session, net, signal };
    // Verify repository numeric identity before requesting a release page. API
    // redirects are refused even if they point to another valid GitHub endpoint.
    const repository = validateRepository(await fetchJSON(API_ROOT, options, state));
    const releases = [];
    for (let page = 1; page <= 3; page += 1) {
      const json = await fetchJSON(`${API_ROOT}/releases?per_page=100&page=${page}`, options, state);
      if (!Array.isArray(json) || json.length > 100) throw policyError('INVALID_METADATA', '更新版本列表不合法');
      releases.push(...json);
      if (json.length < 100) break;
    }
    return { repository, releases };
  }
  function openAssetStream({ candidate, session, net, signal } = {}) {
    validateCandidate(candidate);
    return request({ candidate, session, net, signal, url: candidate.downloadUrl, binary: true });
  }
  return Object.freeze({ fetchReleases, openAssetStream });
}

// HTTP manager interface: fetchReleases({session,net,signal}) resolves to
// {repository,releases}, repository verified first; openAssetStream with the same
// arguments plus main-owned candidate resolves to {stream,headers,statusCode}.
// The bounded Readable enforces headers/length/MZ/cancellation/timeouts; manager
// still owns streamed SHA-256, exclusive disk writes, filesystem and install
// verification. Errors carry fixed safe code/message and rate-limit retryAfterMs.
const production = createUpdateTransport();
module.exports = { createUpdateSession, createUpdateTransport, MAX_JSON_BYTES, DEFAULT_TIMEOUTS,
  fetchReleases: production.fetchReleases, openAssetStream: production.openAssetStream };
