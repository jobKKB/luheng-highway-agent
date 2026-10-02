'use strict';
const fs = require('node:fs');
const path = require('node:path');
// npm's command-line shims are build tools, not runtime dependencies. Some
// installers rewrite these links to absolute checkout paths; never ship them.
function stripBuildOnlyShims(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.name === '.bin') { fs.rmSync(file, { recursive: true, force: true }); continue; }
    if (entry.isSymbolicLink()) throw new Error('Production dependency copy contains an unresolved symbolic link: ' + path.relative(root, file));
    if (entry.isDirectory()) stripBuildOnlyShims(file);
  }
}
function stagingPlan({ target, hostPlatform = process.platform, arch = process.arch, offlineDebian = false }) {
  if (!['linux', 'win32', 'darwin'].includes(target)) throw new Error('Unsupported staging target.');
  if (target !== hostPlatform && !(hostPlatform === 'linux' && target === 'win32' && arch === 'x64')) {
    throw new Error('Only Linux x64 to Windows x64 cross-staging is supported.');
  }
  if (target === 'win32' && arch !== 'x64') throw new Error('The Windows installer currently targets x64 only.');
  if (offlineDebian && (target !== 'linux' || arch !== 'x64')) throw new Error('Installed Debian Chromium is Linux x64 only.');
  return {
    bundleName: target === 'win32' ? 'bundle-win32-x64' : 'bundle',
    playwrightPlatform: target === 'win32' ? 'win64' : null,
  };
}
function assertWindowsX64Executable(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Windows browser is not a PE executable.');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) {
    throw new Error('Windows browser must contain an x64 PE header.');
  }
}
module.exports = { stripBuildOnlyShims, stagingPlan, assertWindowsX64Executable };
