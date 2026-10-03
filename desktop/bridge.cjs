'use strict';

const { exactKeys, validateBundle } = require('./vault.cjs');
const { publicUpdateState, updateInput, checkUpdateInput } = require('./update-manager.cjs');

// This RPC channel exists only between the main and utility processes. There is
// deliberately no ipcMain handler, preload, contextBridge, or renderer API.
const METHODS = new Set(['status', 'preferences', 'saveCredentials', 'forgetCredentials', 'setPreferences', 'selectFolders', 'updateStatus', 'checkUpdate', 'downloadUpdate', 'cancelUpdate', 'installUpdate']);
const ERRORS = Object.freeze({
  unavailable: '桌面安全功能暂不可用，请重新打开应用。',
  timeout: '桌面安全操作超时，请检查状态后重试。',
  invalid: '桌面安全操作格式无效。',
  vault: '系统安全密钥库操作失败；未使用明文回退，请检查凭据保存状态。',
  tray: '系统托盘不可用，关闭窗口将退出应用。',
  preferences: '桌面偏好保存失败，请重试。',
  update: '更新操作暂不可用或已过期，请重新检查版本。',
  folders: '文件夹选择暂不可用；未授予任何权限，请重试或填写绝对路径。',
});

function publicStatus(value) {
  if (!value || typeof value.available !== 'boolean' || typeof value.stored !== 'boolean') throw new Error(ERRORS.invalid);
  const backend = ['dpapi', 'keychain', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic_text', 'unknown'].includes(value.backend) ? value.backend : 'unknown';
  // Never forward arbitrary thrown text or additional vault properties, even if
  // a dependency or future implementation accidentally attaches a secret.
  return {
    available: value.available, stored: value.stored, backend,
    ...(!value.available ? { reason: '系统安全密钥库不可用；凭据仅保留在运行内存中，不会用明文回退保存。' } : {}),
    ...(value.restoreError === true ? { restoreError: true } : {}),
  };
}
function publicPreferences(value) {
  if (!value || typeof value.backgroundEnabled !== 'boolean' || typeof value.trayAvailable !== 'boolean') throw new Error(ERRORS.invalid);
  return { backgroundEnabled: value.backgroundEnabled, trayAvailable: value.trayAvailable };
}
function publicFolders(value) {
  const { isAbsolute } = require('node:path');
  if (!value || typeof value.cancelled !== 'boolean' || !Array.isArray(value.paths) || value.paths.length > 12
    || value.paths.some(p => typeof p !== 'string' || !isAbsolute(p) || p.length > 4096 || p.includes('\0'))) throw new Error(ERRORS.invalid);
  return { cancelled: value.cancelled, paths: value.cancelled ? [] : [...value.paths] };
}
function validRequest(message) {
  return message && Number.isSafeInteger(message.id) && message.id > 0
    && METHODS.has(message.method)
    && exactKeys(message, Object.hasOwn(message, 'payload') ? ['type', 'id', 'method', 'payload'] : ['type', 'id', 'method'])
    && message.type === 'desktop:request';
}

function createDesktopHandler({ vault, preferences, tray, getRestoreError = () => false, clearRestoreError = () => {}, selectFolders, updater }) {
  const readPreferences = () => publicPreferences({ backgroundEnabled: preferences.backgroundEnabled, trayAvailable: tray.available() });
  return async function handle(message) {
    if (message?.type !== 'desktop:request' || !Number.isSafeInteger(message.id) || message.id <= 0) return null;
    const response = { type: 'desktop:response', id: message.id };
    let code = 'invalid';
    try {
      if (!validRequest(message)) throw new Error('invalid');
      const hasPayload = Object.hasOwn(message, 'payload');
      if (!['saveCredentials', 'setPreferences', 'downloadUpdate', 'installUpdate', 'checkUpdate'].includes(message.method) && hasPayload) throw new Error('invalid');
      let result;
      if (['updateStatus', 'checkUpdate', 'downloadUpdate', 'cancelUpdate', 'installUpdate'].includes(message.method)) {
        if (['downloadUpdate', 'installUpdate'].includes(message.method)) updateInput(message.payload);
        if (message.method === 'checkUpdate') checkUpdateInput(message.payload);
        code = 'update';
        if (!updater) throw new Error('update');
        const method = message.method === 'updateStatus' ? 'status' : message.method;
        result = publicUpdateState(updater[method](message.payload));
      } else if (message.method === 'selectFolders') {
        code = 'folders';
        if (typeof selectFolders !== 'function') throw new Error('folders');
        result = publicFolders(await selectFolders());
      } else if (message.method === 'preferences') result = readPreferences();
      else if (message.method === 'setPreferences') {
        if (!exactKeys(message.payload, ['backgroundEnabled']) || typeof message.payload.backgroundEnabled !== 'boolean') throw new Error('invalid');
        code = 'tray';
        if (message.payload.backgroundEnabled && !tray.available()) throw new Error('tray');
        code = 'preferences';
        preferences.set(message.payload);
        result = readPreferences();
      } else {
        if (message.method === 'saveCredentials') validateBundle(message.payload);
        code = 'vault';
        if (message.method === 'saveCredentials') {
          result = vault.save(message.payload);
          clearRestoreError();
        } else if (message.method === 'forgetCredentials') {
          result = vault.forget();
          clearRestoreError();
        } else result = vault.status();
        result = publicStatus({ ...result, restoreError: getRestoreError() });
      }
      return { ...response, ok: true, result };
    } catch {
      return { ...response, ok: false, error: { code } };
    }
  };
}

function createDesktopClient(send, { timeoutMs = 8000 } = {}) {
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  function request(method, payload) {
    if (closed) return Promise.reject(new Error(ERRORS.unavailable));
    if (pending.size >= 32) return Promise.reject(new Error(ERRORS.unavailable));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(ERRORS.timeout)); }, method === 'selectFolders' ? 120000 : timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try { send({ type: 'desktop:request', id, method, ...(payload === undefined ? {} : { payload }) }); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error(ERRORS.unavailable)); }
    });
  }
  function receive(message) {
    if (message?.type !== 'desktop:response') return false;
    const entry = pending.get(message.id);
    if (!entry) return true;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok !== true) entry.reject(new Error(ERRORS[message.error?.code] || ERRORS.unavailable));
    else {
      try {
        entry.resolve(['updateStatus', 'checkUpdate', 'downloadUpdate', 'cancelUpdate', 'installUpdate'].includes(entry.method) ? publicUpdateState(message.result) : entry.method === 'selectFolders' ? publicFolders(message.result) : ['preferences', 'setPreferences'].includes(entry.method) ? publicPreferences(message.result) : publicStatus(message.result));
      } catch { entry.reject(new Error(ERRORS.invalid)); }
    }
    return true;
  }
  function close() {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(ERRORS.unavailable)); }
    pending.clear();
  }
  return {
    receive, close,
    api: Object.freeze({
      updateStatus: () => request('updateStatus'),
      checkUpdate: input => { checkUpdateInput(input); return request('checkUpdate', input); },
      downloadUpdate: input => { updateInput(input); return request('downloadUpdate', input); },
      cancelUpdate: () => request('cancelUpdate'),
      installUpdate: input => { updateInput(input); return request('installUpdate', input); },
      status: () => request('status'),
      preferences: () => request('preferences'),
      saveCredentials: bundle => { validateBundle(bundle); return request('saveCredentials', bundle); },
      forgetCredentials: () => request('forgetCredentials'),
      setPreferences: value => request('setPreferences', value),
      selectFolders: () => request('selectFolders'),
    }),
  };
}

module.exports = { createDesktopHandler, createDesktopClient, publicStatus, publicPreferences, publicFolders, ERRORS };
