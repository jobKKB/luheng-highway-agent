'use strict';
// Crossbuild orchestration only. Never installs software on the user's computer.
const { spawnSync } = require('node:child_process');
const env = { ...process.env, HIGHWAY_BUNDLE_DIR: 'bundle-win32-x64', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: __dirname, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
run(['stage-bundle.cjs', 'win32']);
run([require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.cjs', '--win', 'nsis', '--x64', '--publish', 'never',
  '--config.win.signExecutable=false', '--config.toolsets.wine=1.0.1', '--config.toolsets.nsis=1.2.1']);
