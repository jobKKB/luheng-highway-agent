// Cross-platform helper checks ONLY: these do not execute an installer or Windows runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindPayload, inventory, unpackOOXML, within } from '../scripts/verify-windows-native.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'windows-smoke-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unpacked = join(root, 'unpacked'), installed = join(root, 'installed');
  for (const dir of [unpacked, installed]) {
    mkdirSync(join(dir, 'resources'), { recursive: true });
    writeFileSync(join(dir, 'Luheng Office Agent.exe'), 'synthetic PE placeholder');
    writeFileSync(join(dir, 'resources', 'app.asar'), 'synthetic archive');
  }
  writeFileSync(join(installed, 'Uninstall Luheng Office Agent.exe'), 'synthetic uninstaller');
  return { root, unpacked, installed };
}
test('all payload bytes and inventory are bound with only NSIS support additions', async t => {
  const { unpacked, installed } = fixture(t), result = await bindPayload(unpacked, installed);
  assert.equal(result.status, 'installed-payload-bound'); assert.equal(result.filesChecked, 2);
  assert.equal(Object.keys(result.installedSupportFiles).length, 1);
  assert.match(result.files['resources/app.asar'].sha256, /^[a-f0-9]{64}$/);
});
test('same-length payload tamper is rejected', async t => {
  const { unpacked, installed } = fixture(t);
  writeFileSync(join(installed, 'resources', 'app.asar'), 'Synthetic archive');
  await assert.rejects(bindPayload(unpacked, installed), /Installed payload differs/);
});
test('missing payload is rejected', async t => {
  const { unpacked, installed } = fixture(t); rmSync(join(installed, 'resources', 'app.asar'));
  await assert.rejects(bindPayload(unpacked, installed), /Installed payload differs/);
});
test('unexpected installed files are rejected', async t => {
  const { unpacked, installed } = fixture(t); writeFileSync(join(installed, 'extra.exe'), 'unexpected');
  await assert.rejects(bindPayload(unpacked, installed), /Unexpected installed files/);
});
test('missing generated uninstaller is rejected', async t => {
  const { unpacked, installed } = fixture(t); rmSync(join(installed, 'Uninstall Luheng Office Agent.exe'));
  await assert.rejects(bindPayload(unpacked, installed), /uninstaller missing/);
});
test('directory links/junctions are rejected', async t => {
  const { root, installed } = fixture(t); mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(installed, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inventory(installed), /Links are not allowed/);
});
test('containment rejects parent and sibling prefixes', () => {
  const base = join(tmpdir(), 'test-root');
  assert.equal(within(base, join(base, 'file')), true);
  assert.equal(within(base, base + '-sibling'), false);
  assert.equal(within(base, join(base, '..', 'file')), false);
});
function zip(parts) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text), packed = deflateRawSync(raw), filename = Buffer.from(name); let crc = 0xffffffff;
    for (const b of raw) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(packed.length, 20); header.writeUInt32LE(raw.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, filename, packed); central.push(header, filename); offset += local.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
test('OOXML helper inflates content and validates CRC', () => {
  const parts = unpackOOXML(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document>中文</document>' }));
  assert.equal(parts.get('word/document.xml'), '<document>中文</document>');
});
test('OOXML helper rejects CRC tamper', () => {
  const data = zip({ 'word/document.xml': '<document/>' }), end = data.length - 22, central = data.readUInt32LE(end + 16);
  data.writeUInt32LE(0, central + 16); assert.throws(() => unpackOOXML(data), /ZIP CRC mismatch/);
});
test('native probe refuses Linux rather than claiming a native pass', { skip: process.platform === 'win32' }, t => {
  const { root } = fixture(t), script = fileURLToPath(new URL('../scripts/verify-windows-native.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, 'probe', root, join(root, 'data'), join(root, 'report.json')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 1); assert.match(run.stderr, /Native probe requires Windows/);
});
test('PowerShell recipe never opts out of sandbox or treats static exit 2 as full readiness', () => {
  const text = readFileSync(new URL('../scripts/verify-windows-native.ps1', import.meta.url), 'utf8');
  assert.match(text, /Wait-OwnedProcess \$p 180 2/);
  assert.match(text, /deliverableReady = \$false/);
  assert.match(text, /RUNNER_ENVIRONMENT -ne 'github-hosted'/);
  assert.match(text, /RUNNER_TOOL_CACHE 'node\/24\.21\.0\/x64\/node\.exe'/);
  assert.match(text, /\$nodeVersion -ne 'v24\.21\.0'/);
  assert.ok(!text.includes('Get-Command node'));
  assert.ok(!text.includes('--no-sandbox'));
});

test('generic native gate is pinned to candidate version and refuses old or suffixed window titles',()=>{
  const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
  const ps=readFileSync(new URL('../scripts/verify-windows-native.ps1',import.meta.url),'utf8');
  const js=readFileSync(new URL('../scripts/verify-windows-native.mjs',import.meta.url),'utf8');
  assert.equal(version,'0.6.0-beta.3');
  assert.ok(ps.includes("$version -ne '"+version+"'"));
  assert.ok(js.includes("assert.equal(expected.version, '"+version+"'"));
  const pattern=ps.match(/MainWindowTitle -notmatch '([^']+)'/)[1], title=new RegExp(pattern);
  assert.equal(title.test('路衡 · 办公智能体 v'+version),true);
  assert.equal(title.test('路衡 · 办公智能体 v0.5.2'),false);
  assert.equal(title.test('路衡 · 办公智能体 v'+version+'-wrong'),false);
  assert.ok(!js.includes('app.broker.create'));
  assert.ok(js.includes('chromiumSandbox:true'));
  assert.ok(js.includes("call('workspace_save'"));
});
