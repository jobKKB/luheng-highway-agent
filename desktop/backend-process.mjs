// Runs only in an Electron utility process (or Node IPC during tests).
// No API keys or desktop authentication capabilities are written to disk or stdout.
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import bridge from './bridge.cjs';
import vault from './vault.cjs';

const port = process.parentPort;
const send = value => port ? port.postMessage(value) : process.send?.(value);
const desktop = bridge.createDesktopClient(send);
let backend;
let started = false;
let closing = false;
let updatePrepared = false;

async function close(code = 0) {
  if (closing) return;
  closing = true;
  desktop.close();
  const timeout = setTimeout(() => process.exit(code), 4000);
  timeout.unref();
  try { await backend?.close(); } catch { code = 1; }
  send({ type: 'closed' });
  process.exit(code);
}

async function receive(message) {
  if (desktop.receive(message)) return;
  if (['update:prepare', 'update:release', 'update:shutdown'].includes(message?.type)) {
    if (!Number.isSafeInteger(message.id) || message.id <= 0 || Object.keys(message).sort().join(',') !== 'id,type' || !backend || closing) return;
    if (message.type === 'update:prepare') {
      try { const state = backend.prepareForUpdate?.(); updatePrepared = state?.ready === true; send({ type: 'update:prepared', id: message.id, ready: updatePrepared }); }
      catch { send({ type: 'update:prepared', id: message.id, ready: false }); }
      return;
    }
    if (message.type === 'update:release') {
      updatePrepared = false; backend.releaseUpdateGate?.(); send({ type: 'update:released', id: message.id }); return;
    }
    // Update shutdown has no force-kill timer and no success acknowledgement
    // until every backend close/flush promise resolves. Exit is checked by main.
    if (!updatePrepared) { send({ type: 'update:closed', id: message.id, ok: false }); return; }
    closing = true; desktop.close();
    try { await backend.close(); send({ type: 'update:closed', id: message.id, ok: true }); process.exit(0); }
    catch { send({ type: 'update:closed', id: message.id, ok: false }); process.exit(1); }
    return;
  }
  if (message?.type === 'shutdown') return close();
  if (message?.type !== 'start' || started) return;
  started = true;
  let safeStartupError = 'The local backend could not start safely. Please check the local app data and runtime requirements.';
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) {
      safeStartupError = 'The desktop backend requires bundled Node.js 24 or newer.';
      throw new Error(safeStartupError);
    }
    if (!isAbsolute(message.serverPath) || !isAbsolute(message.dataDir)) {
      safeStartupError = 'Backend and data paths must be absolute.';
      throw new Error(safeStartupError);
    }
    if (typeof message.desktopToken !== 'string' || message.desktopToken.length < 32) {
      safeStartupError = 'Desktop session authentication was not initialized.';
      throw new Error(safeStartupError);
    }
    const persistedCredentials = message.persistedCredentials == null ? null : vault.validateBundle(message.persistedCredentials);
    message.persistedCredentials = null;
    const { startServer } = await import(pathToFileURL(message.serverPath).href);
    backend = await startServer({
      port: 0, host: '127.0.0.1', dataDir: message.dataDir, desktopToken: message.desktopToken,
      persistedCredentials, desktopBridge: desktop.api,
    });
    if (!Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535) {
      throw new Error('The backend did not return a valid local port.');
    }
    send({ type: 'ready', port: backend.port, node: process.versions.node, version: backend.version });
  } catch (error) {
    // Keep returned errors bounded and never return settings/request bodies.
    send({ type: 'error', message: safeStartupError });
    await close(1);
  }
}

if (port) port.on('message', event => receive(event.data));
else if (process.send) process.on('message', receive);
else throw new Error('The desktop backend must be started by its parent process.');

process.on('SIGTERM', () => close());
process.on('SIGINT', () => close());
process.on('disconnect', () => close());
