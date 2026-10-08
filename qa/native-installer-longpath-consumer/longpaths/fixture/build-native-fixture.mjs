import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({ options: { source: { type: 'string' }, prepared: { type: 'string' }, work: { type: 'string' } } })
assert.equal(process.platform, 'win32', 'Native Windows required')
assert.equal(process.arch, 'x64', 'Native x64 required')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable hosted runner only')
for (const key of ['source', 'prepared', 'work']) assert(o[key], `--${key} required`)
const source = fs.realpathSync(o.source)
const work = path.resolve(o.work)
assert(work.toLowerCase().startsWith(path.resolve(process.env.RUNNER_TEMP).toLowerCase() + path.sep))
assert(!fs.existsSync(work), 'Fresh fixture work directory required')
const load = file => import(pathToFileURL(path.join(source, 'apps/desktop/scripts', file)).href)
const { readPackagingInputs, treeDigest } = await load('prepared-packaging.mjs')
const { pinnedPackageRoot } = await load('prepare-packaging-tools.mjs')
const { verifyNsisLongPathInputs } = await load('nsis-longpaths-inputs.mjs')
const inputs = readPackagingInputs(o.prepared, source, 'win32-x64')
const library = pinnedPackageRoot(source, 'app-builder-lib')
const supplier = verifyNsisLongPathInputs(library, inputs)
const cli = pinnedPackageRoot(source, 'electron-builder')
const project = path.join(work, 'fixture project 路衡')
const payload = path.join(project, 'payload')
const resources = path.join(project, 'build')
const output = path.join(project, 'out')
fs.mkdirSync(payload, { recursive: true })
fs.mkdirSync(resources, { recursive: true })
const toolsets = {}
for (const [name, original] of Object.entries(inputs.toolsets)) {
  const destination = path.join(resources, 'prepared-packaging-tools', name)
  fs.cpSync(original, destination, { recursive: true, verbatimSymlinks: true })
  assert.equal(treeDigest(destination), inputs.files.find(row => row.path === original)?.digest)
  toolsets[name] = { url: `file://${destination}` }
}
const hook = path.join(source, 'apps/desktop/build/nsis-longpaths.nsh')
fs.copyFileSync(hook, path.join(resources, 'nsis-longpaths.nsh'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const exeName = 'Nsis Long Path Fixture.exe'
fs.copyFileSync(path.join(inputs.toolsets.sevenZip, 'bin/7za.exe'), path.join(payload, exeName))
// Reproduce every omitted production relative path with synthetic contents.
const paths = JSON.parse(fs.readFileSync(new URL('./missing-paths.json', import.meta.url), 'utf8'))
paths.push('resources/short.txt', 'resources/空 格/Unicode 中文 model.py',
  'resources/' + ['深层 space ' + 'a'.repeat(53), 'b'.repeat(65), '模型 ' + 'c'.repeat(61), 'd'.repeat(66)].join('/') + '/长路径.txt')
for (const [i, relative] of paths.entries()) {
  const file = path.join(payload, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `Synthetic native long-path fixture ${i}: ${relative}\n`, 'utf8')
}
fs.mkdirSync(path.join(payload, 'resources/app'), { recursive: true })
fs.writeFileSync(path.join(payload, 'resources/app/package.json'), JSON.stringify({ name: 'nsis-long-path-fixture', version: '0.0.1', main: 'index.js' }))
fs.writeFileSync(path.join(payload, 'resources/app/index.js'), 'throw new Error("Fixture must never be launched")\n')
const nonce = `${process.pid}-${Date.now()}`
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: `nsis-long-path-fixture-${nonce}`, version: '0.0.1', description: 'Disposable installer regression', author: 'Fixture', main: 'index.js' }))
fs.writeFileSync(path.join(project, 'index.js'), 'throw new Error("Fixture must never be launched")\n')
const require = createRequire(path.join(source, 'apps/desktop/package.json'))
const manual = require(path.join(source, 'apps/desktop/electron-builder.nsis-prepackaged-test.cjs'))
const config = {
  appId: `com.luheng.nsis-long-path-fixture.${nonce}`, productName: 'Nsis Long Path Fixture',
  executableName: 'Nsis Long Path Fixture', electronVersion: manual.electronVersion,
  artifactName: 'fixture-setup.exe', publish: null, forceCodeSigning: false,
  directories: { buildResources: resources, output }, toolsets,
  win: { target: ['nsis'], executableName: 'Nsis Long Path Fixture', sign: false, requestedExecutionLevel: 'asInvoker' },
  nsis: { ...manual.nsis, include: path.join(resources, 'nsis-longpaths.nsh'), createStartMenuShortcut: false, createDesktopShortcut: false },
}
fs.writeFileSync(path.join(project, 'fixture.config.cjs'), `module.exports = ${JSON.stringify(config, null, 2)}\n`)
const inventory = root => {
  const result = []
  const visit = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file)
      assert(!stat.isSymbolicLink(), 'No fixture links')
      if (stat.isDirectory()) visit(file)
      else result.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size, sha256: hash(file) })
    }
  }
  visit(root); return result
}
const before = inventory(payload)
const bin = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8')).bin['electron-builder']
const log = fs.openSync(path.join(work, 'fixture-build.log'), 'w')
const built = spawnSync(process.execPath, [path.join(cli, bin), '--win', 'nsis', '--x64', '--prepackaged', payload,
  '--config', 'fixture.config.cjs', '--publish', 'never', `-c.electronDist=${inputs.electron}`],
  { cwd: project, stdio: ['ignore', log, log], env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
fs.closeSync(log)
assert(!built.error, built.error?.message)
assert.equal(built.status, 0, 'Fixture compilation failed; inspect fixture-build.log')
assert.deepEqual(inventory(payload), before, 'Fixture payload was changed by wrapping')
const installer = path.join(output, 'fixture-setup.exe')
const install = path.join(work, 'representative install prefix with spaces 路衡', 'long path test location ' + 'x'.repeat(30))
assert(install.length < 200, 'Fixture runner scratch prefix is unexpectedly long')
assert(Math.max(...before.map(row => path.join(install, row.path).length)) > 350)
const receipt = { schema: 1, fixture_only: true, acceptance_claim: false, installer, install,
  installer_sha256: hash(installer), hook_sha256: hash(hook), payload_unchanged: true,
  expected: before, supplier, expected_additions: [`Uninstall Nsis Long Path Fixture.exe`, 'resources/package-type'],
  max_installed_path_characters: Math.max(...before.map(row => path.join(install, row.path).length)) }
fs.writeFileSync(path.join(work, 'fixture-build.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ work, installer, files: before.length, max_path: receipt.max_installed_path_characters }))
