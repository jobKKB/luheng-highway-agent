// Synthetic identity checks only. No packager, download, payload or installer runs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const overlay = JSON.parse(fs.readFileSync(new URL('./helper-source-overlay.json', import.meta.url), 'utf8'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longpath-identity-'))
try {
  const source = path.join(root, 'source'), scripts = path.join(source, 'apps/desktop/scripts')
  fs.mkdirSync(scripts, { recursive: true })
  const required = [
    'package-lock.json', 'apps/desktop/package.json', 'apps/desktop/electron-builder.config.cjs', 'pm/lock.json',
    ...['prepare-packaging-tools.mjs', 'prepared-packaging.mjs', 'prepare-dmgbuild.mjs', 'prepare_dmgbuild.py',
        'windows-bundle-tools.mjs', 'run-electron-builder.mjs', 'prepared-prepackaged.mjs', 'backend-ready-artifact.mjs']
      .map(name => 'apps/desktop/scripts/' + name),
  ]
  for (const name of required) {
    const file = path.join(source, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'synthetic input; never executed\n')
  }
  for (const row of overlay.files) {
    const file = path.join(source, row.path)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(row.content_base64, 'base64'))
  }
  const { packagingIdentity, readPackagingInputs } = await import(pathToFileURL(path.join(scripts, 'prepared-packaging.mjs')).href)
  const original = packagingIdentity(source)
  const out = path.join(root, 'packager'); fs.mkdirSync(out)
  const prepared = path.join(out, 'prepared.json')
  fs.writeFileSync(prepared, JSON.stringify({ schema: 1, source: fs.realpathSync(source), out: fs.realpathSync(out),
    target: 'win32-x64', identity: original }))
  const runtimeHelpers = overlay.files.filter(row => !row.path.endsWith('.test.mjs'))
  assert.equal(runtimeHelpers.length, 5)
  assert.deepEqual(overlay.files.filter(row => row.path.endsWith('.test.mjs')).map(row => row.path),
    ['apps/desktop/scripts/prepared-prepackaged.test.mjs'])
  for (const row of runtimeHelpers) {
    const file = path.join(source, row.path), before = fs.readFileSync(file)
    fs.appendFileSync(file, '\nsynthetic mutation\n')
    assert.notEqual(packagingIdentity(source), original, `helper is not identity-bound: ${row.path}`)
    assert.throws(() => readPackagingInputs(prepared, source, 'win32-x64'), /Stale or foreign packaging inputs/)
    fs.writeFileSync(file, before)
    assert.equal(packagingIdentity(source), original)
  }
  console.log(JSON.stringify({ helper_files_identity_bound: runtimeHelpers.length,
    stale_preparations_rejected: runtimeHelpers.length, synthetic_only: true, native_execution: false }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
