'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, safeStorage, dialog, session, utilityProcess, screen } = require('electron');
const { randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { SecretVault } = require('./vault.cjs');
const { DesktopPreferences, TrayLifecycle } = require('./lifecycle.cjs');
const { WindowStateStore, manageWindowState } = require('./window-state.cjs');
const { createDesktopHandler } = require('./bridge.cjs');
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

function startBackend(persistedCredentials) {
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
        resolve({ origin: `http://127.0.0.1:${message.port}`, desktopToken });
      } else if (message?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    backend.once('exit', code => {
      clearTimeout(timer);
      stopped = true;
      if (!origin) reject(new Error(`The local backend exited before startup (code ${code}).`));
      else if (!exiting) {
        dialog.showErrorBox('本地服务已停止', '路衡的本地服务意外停止。请重新打开应用；已保存的本地数据会保留。');
        app.quit();
      }
    });
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
    if (origin) openWindow().catch(() => app.quit());
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
    desktopHandler = createDesktopHandler({
      vault, preferences, tray,
      getRestoreError: () => restoreError,
      clearRestoreError: () => { restoreError = false; },
    });
    let persistedCredentials = null;
    try { persistedCredentials = vault.load(); } catch { restoreError = true; }
    const startingBackend = startBackend(persistedCredentials);
    persistedCredentials = null;
    const info = await startingBackend;
    origin = info.origin;
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
    tray?.destroy();
    if (!backend || stopped || exiting) return;
    event.preventDefault();
    exiting = true;
    const timeout = setTimeout(() => { backend.kill(); app.exit(); }, 5000);
    backend.once('exit', () => { clearTimeout(timeout); app.exit(); });
    backend.postMessage({ type: 'shutdown' });
  });
}
