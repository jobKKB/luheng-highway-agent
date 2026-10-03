'use strict';
// A build-only, version-bound template copy. The installed dependency and
// electron-builder's normal uninstaller generation/signing remain unchanged.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const pinned = require('./nsis-26.15.3-template-sha256.json');
let active;
function inventory(directory, relative = '') {
  const names = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    const stat = fs.lstatSync(path.join(directory, name));
    if (stat.isSymbolicLink()) throw new Error('NSIS template link rejected: ' + name);
    if (stat.isDirectory()) names.push(...inventory(directory, name));
    else if (stat.isFile()) names.push(name);
    else throw new Error('Unexpected NSIS template entry: ' + name);
  }
  return names.sort();
}
function replaceOnce(text, before, after, name) {
  if (text.split(before).length !== 2) throw new Error('Pinned NSIS template layout changed: ' + name);
  return text.replace(before, after);
}
function copyBoundNsisTemplates(sourceDirectory, { version, temporaryRoot = os.tmpdir() } = {}) {
  if (version !== pinned.builderVersion || pinned.schema !== 1) throw new Error('Only byte-verified electron-builder 26.15.3 templates are supported.');
  const names = inventory(sourceDirectory);
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(pinned.files).sort())) throw new Error('NSIS template inventory changed; packaging stopped.');
  const files = new Map();
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(sourceDirectory, name));
    if (createHash('sha256').update(bytes).digest('hex') !== pinned.files[name]) throw new Error('NSIS template bytes changed; packaging stopped: ' + name);
    files.set(name, bytes);
  }
  // Initial output must never implicitly create the installation destination.
  const installer = replaceOnce(files.get('installer.nsi').toString('utf8'),
    '  SetOutPath $INSTDIR\n  ${LogSet} on',
    '  InitPluginsDir\n  SetOutPath "$PLUGINSDIR"\n  ${LogSet} on', 'installer.nsi');
  let section = replaceOnce(files.get('installSection.nsh').toString('utf8'),
    '!insertmacro uninstallOldVersion SHELL_CONTEXT',
    '!insertmacro luhengPreflightInstallDirectory\n\n!insertmacro uninstallOldVersion SHELL_CONTEXT', 'installSection.nsh preflight');
  section = replaceOnce(section, 'SetOutPath $INSTDIR',
    '!insertmacro luhengCreateInstallDirectory\n\nSetOutPath $INSTDIR', 'installSection.nsh creation');
  files.set('installer.nsi', Buffer.from(installer));
  files.set('installSection.nsh', Buffer.from(section));
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'luheng-nsis26-templates-'));
  const identity = fs.lstatSync(directory, { bigint: true });
  const cleanup = () => {
    try {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
  };
  try {
    for (const [name, bytes] of files) {
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) { cleanup(); throw error; }
  return { directory, cleanup, sourceFilesVerified: names.length, builderVersion: version };
}
function activateBoundNsisTemplates() {
  if (active) return active;
  const builderVersion = require('app-builder-lib/package.json').version;
  const nsis = require('app-builder-lib/out/targets/nsis/nsisUtil.js');
  const original = nsis.nsisTemplatesDir;
  const prepared = copyBoundNsisTemplates(original, { version: builderVersion });
  // 26.15.3 reads this CommonJS property at each template use, for both the
  // normal signed-uninstaller preparation and final installer compilation.
  nsis.nsisTemplatesDir = prepared.directory;
  if (nsis.nsisTemplatesDir !== prepared.directory) { prepared.cleanup(); throw new Error('Unable to select verified NSIS templates.'); }
  active = { ...prepared, original };
  process.once('exit', () => {
    if (nsis.nsisTemplatesDir === prepared.directory) nsis.nsisTemplatesDir = original;
    prepared.cleanup();
  });
  return active;
}
module.exports = { copyBoundNsisTemplates, activateBoundNsisTemplates };
