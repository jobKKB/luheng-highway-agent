// Static two-artifact online-update eligibility preflight, never launches either
// executable. This cannot prove interactive Shell/MOTW/NSIS/update completion.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verifyWindowsRelease } from './verify-windows-release.mjs';
const require = createRequire(import.meta.url);
const { compareVersions } = require('../desktop/update-policy.cjs');
const asar = createRequire(new URL('../desktop/package.json', import.meta.url))('@electron/asar');
export function verifyOnlineUpdatePair({ baseline, target }) {
  const read = input => {
    if (!input || Object.keys(input).sort().join(',') !== 'installer,release,sourceRoot') throw new Error('Each artifact requires exactly release, installer and sourceRoot');
    const result = verifyWindowsRelease(input);
    const archive = resolve(input.release, 'resources/app.asar');
    // An older installer without updater files must not masquerade as the
    // baseline even when its historical source verifier accepted it.
    for (const name of ['update-policy.cjs', 'update-transport.cjs', 'update-files.cjs', 'update-manager.cjs']) if (!asar.statFile(archive, name).size) throw new Error('Baseline and target must both contain updater code');
    const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
    return { result, version: pkg.version };
  };
  const a = read(baseline), b = read(target);
  if (compareVersions(b.version, a.version) <= 0) throw new Error('Target must be strictly newer than baseline');
  return { status: 'static-two-updater-artifact-preflight-passed', baselineVersion: a.version, targetVersion: b.version,
    baselineInstaller: a.result.installer, targetInstaller: b.result.installer,
    nativeOnlineUpdateVerified: false, interactiveWindowsSecurityPromptsVerified: false,
    note: 'Follow docs/UPDATE-SECURITY.md interactive acceptance on isolated Windows; this script executes no installer.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); if (args.length !== 1) throw new Error('Usage: node scripts/verify-windows-online-update.mjs pair.json');
  console.log(JSON.stringify(verifyOnlineUpdatePair(JSON.parse(readFileSync(args[0], 'utf8'))), null, 2));
}
