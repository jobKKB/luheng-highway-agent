'use strict';
const path = require('node:path');
const fs = require('node:fs');
const bundleName = process.env.HIGHWAY_BUNDLE_DIR || 'bundle';
if (!['bundle', 'bundle-win32-x64'].includes(bundleName)) throw new Error('Unexpected bundle directory.');
module.exports = {
  appId: 'local.luheng.officeagent',
  productName: 'Luheng Office Agent',
  asar: true,
  directories: { output: 'dist' },
  files: ['main.cjs', 'security.cjs', 'backend-process.mjs', 'bridge.cjs', 'vault.cjs', 'lifecycle.cjs', 'window-state.cjs', 'update-policy.cjs', 'update-transport.cjs', 'update-files.cjs', 'update-manager.cjs', 'assets/**', 'package.json'],
  extraResources: [
    { from: `${bundleName}/backend`, to: 'backend', filter: ['**/*'] },
    // electron-builder excludes a matcher-root node_modules folder by default;
    // give production dependencies their own root so nested dependencies survive.
    { from: `${bundleName}/backend/node_modules`, to: 'backend/node_modules', filter: ['**/*'] },
    { from: `${bundleName}/browser-runtime`, to: 'browser-runtime', filter: ['**/*'] },
    { from: `${bundleName}/bundle-manifest.json`, to: 'bundle-manifest.json' },
  ],
  beforePack(context) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, bundleName, 'bundle-manifest.json'), 'utf8'));
    const arch = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch];
    if (manifest.target !== context.electronPlatformName || manifest.arch !== arch) {
      throw new Error('Staged browser target does not match the installer target. Run the matching staging command first.');
    }
  },
  npmRebuild: false,
  publish: null,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Luheng-Office-Agent-${version}-windows-${arch}.${ext}',
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    include: path.join(__dirname, 'current-user-install.nsh'),
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
  },
};
