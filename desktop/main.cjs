'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, safeStorage, dialog, session, utilityProcess, screen, net, shell } = require('electron');
const { randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { SecretVault } = require('./vault.cjs');
const { DesktopPreferences, TrayLifecycle } = require('./lifecycle.cjs');
const { WindowStateStore, manageWindowState } = require('./window-state.cjs');
const { createDesktopHandler } = require('./bridge.cjs');
const { UpdateManager } = require('./update-manager.cjs');
const { createUpdateFiles } = require('./update-files.cjs');
const { createUpdateTransport, createUpdateSession } = require('./update-transport.cjs');
const {
  CONTENT_SECURITY_POLICY, isApplicationURL, isAllowedResource,
  authenticatedHeaders, backendEnvironment, isArtifactDownload, resolveBundledBrowser,
} = require('./security.cjs');

app.setName('路衡办公智能体');
// Expose the standard renderer accessibility tree to screen readers and native QA.
app.commandLine.appendSwitch('force-renderer-accessibility');
const stateRoot = process.env.HIGHWAY_DESKTOP_DATA_DIR
  ? path.resolve(process.env.HIGHWAY_DESKTOP_DATA_DIR)
  : path.join(app.getPath('appData'), 'LuhengOfficeAgent');
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
app.setPath('userData', stateRoot);
app.setPath('sessionData', path.join(stateRoot, 'browser-session'));
// Do not opt out of Chromium's sandbox, including when running in a container.
app.enableSandbox();

let window;
let backend;
let origin;
let exiting = false;
let stopped = false;
let tray;
let preferences;
let windowState;
let windowStateController;
let vault;
let desktopHandler;
let restoreError = false;
let updater;
let updateShutdown = false;
let nextBackendRequest = 0;

function startBackend(persistedCredentials) {
  stopped = false;
  return new Promise((resolve, reject) => {
    const desktopToken = randomBytes(32).toString('hex');
    const childEnvironment = backendEnvironment(process.env);
    if (app.isPackaged) {
      delete childEnvironment.HIGHWAY_CHROMIUM_PATH;
      delete childEnvironment.CHROME_EXECUTABLE;
      delete childEnvironment.CHROMIUM_PATH;
      childEnvironment.HIGHWAY_BUNDLED_BROWSER = '1';
      childEnvironment.HIGHWAY_BUNDLED_BROWSER_EXECUTABLE = resolveBundledBrowser(process.resourcesPath);
      childEnvironment.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browser-runtime');
    }
    const timer = setTimeout(() => {
      backend?.kill();
      reject(new Error('The local backend did not become ready within 25 seconds.'));
    }, 25000);
    backend = utilityProcess.fork(path.join(__dirname, 'backend-process.mjs'), [], {
      serviceName: 'Luheng local backend',
      stdio: 'pipe',
      env: childEnvironment,
    });
    // Drain pipe buffers; do not mirror backend output that may contain user content.
    backend.stdout?.on('data', () => {});
    backend.stderr?.on('data', () => {});
    backend.once('spawn', () => {
      backend.postMessage({
        type: 'start',
        serverPath: app.isPackaged
          ? path.join(process.resourcesPath, 'backend', 'server.mjs')
          : path.resolve(__dirname, '..', 'server.mjs'),
        dataDir: path.join(stateRoot, 'data'),
        desktopToken,
        persistedCredentials,
      });
      persistedCredentials = null;
    });
    backend.on('message', message => {
      if (message?.type === 'desktop:request') {
        desktopHandler(message).then(response => {
          if (response && !stopped) { try { backend.postMessage(response); } catch {} }
        });
      } else if (message?.type === 'ready') {
        clearTimeout(timer);
        resolve({ origin: `http://127.0.0.1:${message.port}`, desktopToken, version: message.version });
      } else if (message?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    backend.once('exit', code => {
      clearTimeout(timer);
      stopped = true;
      if (!origin) reject(new Error(`The local backend exited before startup (code ${code}).`));
      else if (!exiting && !updateShutdown) {
        dialog.showErrorBox('本地服务已停止', '路衡的本地服务意外停止。请重新打开应用；已保存的本地数据会保留。');
        app.quit();
      }
    });
  });
}


// Fixed main-to-sidecar control messages; no renderer IPC, path, URL or command.
function updateBackendRequest(type, responseType) {
  return new Promise((resolve, reject) => {
    if (!backend || stopped) return reject(Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' }));
    const child = backend, id = ++nextBackendRequest;
    const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' })); }, 20000);
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
    function message(value) { if (value?.type === responseType && value.id === id) { cleanup(); resolve(value); } }
    function exit() { cleanup(); reject(Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' })); }
    child.on('message', message); child.once('exit', exit);
    try { child.postMessage({ type, id }); } catch { exit(); }
  });
}
function shutdownForUpdate() {
  return new Promise((resolve, reject) => {
    if (!backend || stopped) return reject(Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' }));
    updateShutdown = true;
    windowStateController?.flush();
    const child = backend, id = ++nextBackendRequest;
    let flushed = false;
    const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' })); }, 20000);
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
    function message(value) { if (value?.type === 'update:closed' && value.id === id) flushed = value.ok === true; }
    function exit(code) { cleanup(); if (flushed && code === 0) resolve(true); else reject(Object.assign(new Error('SHUTDOWN'), { code: 'SHUTDOWN' })); }
    child.on('message', message); child.once('exit', exit);
    try { child.postMessage({ type: 'update:shutdown', id }); } catch { exit(1); }
  });
}
async function recoverCurrentVersion() {
  if (!stopped) {
    dialog.showErrorBox('更新未启动', '本地服务仍在关闭或未确认完整关闭；没有打开安装器。请关闭并重新打开当前版本。仅内存中的密钥及未保存输入需重新填写。');
    return;
  }
  dialog.showErrorBox('安装未确认完成', 'Windows 未接受安装器打开请求，或本地服务没有完整关闭。正在重新打开当前版本；仅内存中的密钥需重新输入，未保存输入可能丢失。请勿重复确认系统安装窗口。');
  updateShutdown = false;
  let saved = null;
  try { saved = vault.load(); } catch { restoreError = true; }
  const info = await startBackend(saved); saved = null;
  origin = info.origin;
  configureSession(session.fromPartition('luheng-desktop-session'), origin, info.desktopToken);
  if (window && !window.isDestroyed()) await window.loadURL(origin); else await openWindow();
}
function initializeUpdater() {
  const supported = process.platform === 'win32' && process.arch === 'x64' && app.isPackaged;
  const updateSession = createUpdateSession(session); // Separate, memory-only; not the authenticated UI session.
  updateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  updateSession.setPermissionCheckHandler(() => false);
  let ownedFiles;
  const filesReady = () => ownedFiles ||= createUpdateFiles({ stateRoot, privateDirectoryModule: app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'lib', 'private-directory.mjs')
    : path.resolve(__dirname, '..', 'lib', 'private-directory.mjs') });
  const files = Object.fromEntries(['create', 'finish', 'verify', 'discard', 'installSpace'].map(method => [method, async (...args) => (await filesReady())[method](...args)]));
  const journal = supported ? Object.fromEntries(['read', 'write', 'clear'].map(method => [method, async (...args) => (await filesReady()).journal[method](...args)])) : undefined;
  const transport = createUpdateTransport();
  return new UpdateManager({ currentVersion: app.getVersion(), supported, files,
    transport: { fetchReleases: args => transport.fetchReleases({ ...args, net, session: updateSession }), openAssetStream: args => transport.openAssetStream({ ...args, net, session: updateSession }) }, journal,
    lifecycle: {
      executable: process.execPath,
      confirm: async candidate => {
        const options = { type: 'warning', title: '安装路衡测试版更新', buttons: ['取消', '退出并打开安装向导'], defaultId: 0, cancelId: 0, noLink: true,
          message: `安装路衡 ${candidate.version}（${(candidate.sizeBytes / 1024 ** 2).toFixed(1)} MiB）？`,
          detail: `来源：固定 GitHub 仓库 jobKKB/luheng-highway-agent，${candidate.channel === 'preview' ? '你明确选择的测试版渠道' : '正式版渠道'}。\n此安装包未签名。大小与 SHA-256 校验仅验证下载完整性，不能独立认证发布者。Windows 安全提示由你决定，应用不会绕过提示或请求自动提权。\n仅支持当前用户安装。本地服务将先完整关闭，再通过 Windows 正常方式打开可见安装向导；这不表示安装成功。\n待审批和排队记录保留，但请先完成或停止运行中的任务，并关闭受控浏览器会话。仅内存中的密钥及未保存输入将在退出时丢失，已选择保存的系统加密快照保持原处。\n安装器失败或断电没有自动回滚保证，可从官方发布页重新安装修复。` };
        const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        return result.response === 1;
      },
      prepare: () => updateBackendRequest('update:prepare', 'update:prepared'),
      release: () => updateBackendRequest('update:release', 'update:released'),
      shutdown: shutdownForUpdate,
      launch: file => shell.openPath(file),
      exit: () => { exiting = true; tray?.destroy(); app.quit(); },
      recover: recoverCurrentVersion,
    },
  });
}

function configureSession(ses, localOrigin, desktopToken) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event, item) => {
    if (!item.getURLChain().every(url => isArtifactDownload(url, localOrigin))) {
      event.preventDefault();
      return;
    }
    // Do not setSavePath: Electron's native Save dialog asks the user where to save.
    item.setSaveDialogOptions({ title: '保存路衡工作成果' });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedResource(details.url, localOrigin, details.resourceType) });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isApplicationURL(details.url, localOrigin)) return callback({ cancel: true });
    callback({ requestHeaders: authenticatedHeaders(details.requestHeaders, desktopToken) });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!isApplicationURL(details.url, localOrigin)) return callback({ cancel: true });
    const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders || {}).filter(
      ([key]) => !['content-security-policy', 'x-content-type-options', 'referrer-policy'].includes(key.toLowerCase())
    ));
    callback({ responseHeaders: {
      ...responseHeaders,
      'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      'X-Content-Type-Options': ['nosniff'],
      'Referrer-Policy': ['no-referrer'],
    } });
  });
}

async function openWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  const ses = session.fromPartition('luheng-desktop-session'); // Memory-only browser session.
  const restored = windowState.restore(screen);
  window = new BrowserWindow({
    ...restored.bounds, minWidth: restored.minWidth, minHeight: restored.minHeight,
    frame: true, resizable: true, maximizable: true, minimizable: true,
    title: '路衡 · 办公智能体', backgroundColor: '#f5f6f8', show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventOutsideApp = (event, url) => {
    const target = typeof url === 'string' ? url : (url?.url || event.url);
    if (!isApplicationURL(target, origin)) event.preventDefault();
  };
  window.webContents.on('will-navigate', preventOutsideApp);
  window.webContents.on('will-redirect', preventOutsideApp);
  window.webContents.on('will-frame-navigate', preventOutsideApp);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  windowStateController = manageWindowState(window, screen, windowState, restored);
  window.once('ready-to-show', () => {
    if (restored.maximized) window.maximize();
    window.show();
  });
  window.on('close', event => tray?.handleClose(event, window, {
    backgroundEnabled: preferences?.backgroundEnabled === true, exiting,
  }));
  window.on('closed', () => { window = null; windowStateController = null; });
  await window.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (origin && !updateShutdown) openWindow().catch(() => app.quit());
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    preferences = new DesktopPreferences(stateRoot);
    windowState = new WindowStateStore(stateRoot);
    tray = new TrayLifecycle({
      Tray, Menu, nativeImage, iconPath: path.join(__dirname, 'assets', 'tray.png'),
      showWindow: () => { if (origin && !exiting) openWindow().catch(() => app.quit()); },
      quit: () => app.quit(),
    });
    tray.create();
    vault = new SecretVault({ safeStorage, stateRoot });
    updater = initializeUpdater();
    desktopHandler = createDesktopHandler({
      vault, preferences, tray, updater,
      selectFolders: async () => {
        const options = { title: '选择允许路衡访问的本机文件夹', properties: ['openDirectory', 'multiSelections', 'dontAddToRecent'] };
        const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return { cancelled: result.canceled, paths: result.canceled ? [] : result.filePaths };
      },
      getRestoreError: () => restoreError,
      clearRestoreError: () => { restoreError = false; },
    });
    let persistedCredentials = null;
    try { persistedCredentials = vault.load(); } catch { restoreError = true; }
    const startingBackend = startBackend(persistedCredentials);
    persistedCredentials = null;
    const info = await startingBackend;
    origin = info.origin;
    await updater.verifyStartup(info.version).catch(error => updater.fail(error));
    configureSession(session.fromPartition('luheng-desktop-session'), origin, info.desktopToken);
    await openWindow();
  }).catch(error => {
    dialog.showErrorBox('路衡启动失败', `${String(error.message || error)}\n\n请查看 docs/DESKTOP.md 的启动和环境要求。`);
    app.quit();
  });
  app.on('activate', () => { if (origin && !exiting) openWindow().catch(() => app.quit()); });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.on('before-quit', event => {
    windowStateController?.flush();
    updater?.close();
    tray?.destroy();
    if (!backend || stopped || exiting) return;
    event.preventDefault();
    exiting = true;
    const timeout = setTimeout(() => { backend.kill(); app.exit(); }, 5000);
    backend.once('exit', () => { clearTimeout(timeout); app.exit(); });
    backend.postMessage({ type: 'shutdown' });
  });
}
