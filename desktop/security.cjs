'use strict';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function isApplicationURL(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' && !url.username && !url.password;
  } catch { return false; }
}

function isAllowedResource(value, origin, resourceType) {
  if (isApplicationURL(value, origin)) return true;
  // Data/blob images do not trigger navigation or give untrusted content privileges.
  return resourceType === 'image' && /^(data:image\/|blob:)/.test(value);
}

function isArtifactDownload(value, origin) {
  if (!isApplicationURL(value, origin)) return false;
  return /^\/api\/artifacts\/[^/]+$/.test(new URL(value).pathname);
}

function authenticatedHeaders(headers, token) {
  const clean = Object.fromEntries(Object.entries(headers).filter(
    ([key]) => key.toLowerCase() !== 'x-highway-desktop-token'
  ));
  return { ...clean, 'X-Highway-Desktop-Token': token };
}

function backendEnvironment(env) {
  // Deliberately do not forward API keys or unrelated credentials to child processes.
  const keys = [
    'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot',
    'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY',
    'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'PLAYWRIGHT_BROWSERS_PATH', 'HIGHWAY_CHROMIUM_PATH', 'CHROME_EXECUTABLE', 'CHROMIUM_PATH',
  ];
  return Object.fromEntries(keys.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

function resolveBundledBrowser(resourcesPath) {
  const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
  const manifest = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'bundle-manifest.json'), 'utf8'));
  if (manifest.target !== process.platform || manifest.arch !== process.arch) throw new Error('Bundled browser OS/architecture does not match this application.');
  if (typeof manifest.browserExecutable !== 'string' || path.isAbsolute(manifest.browserExecutable)) throw new Error('Bundled browser manifest has no safe executable path.');
  const root = fs.realpathSync(path.join(resourcesPath, 'browser-runtime'));
  const executable = fs.realpathSync(path.resolve(root, manifest.browserExecutable));
  const relative = path.relative(root, executable);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(executable).isFile()) throw new Error('Bundled browser must stay inside application resources.');
  const actual = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (actual !== manifest.browserExecutableSha256) throw new Error('Bundled browser integrity check failed; no system-browser fallback will be used.');
  return executable;
}

module.exports = { CONTENT_SECURITY_POLICY, isApplicationURL, isAllowedResource, authenticatedHeaders, backendEnvironment, isArtifactDownload, resolveBundledBrowser };
