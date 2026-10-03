// CI-only acceptance helper for the LOCKED 0.4.0 -> 0.5.0 Windows upgrade.
// No production code is changed. Pure helpers are exported for cross-platform
// tests; native modes refuse to run unless they execute under the INSTALLED app
// EXE (ELECTRON_RUN_AS_NODE=1) on a disposable GitHub-hosted Windows runner.
// Results always carry the locked versions; nothing here relabels 0.5.0.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { inventory, within } from './verify-windows-native.mjs';

export const LOCK_SCHEMA = 'luheng-windows-upgrade-lock/v1';
export const PINNED = Object.freeze({ from: '0.4.0', to: '0.5.0' });
export const ARTIFACT_NAME = 'luheng-windows-unsigned-prototype';
export const APP_EXE = 'Luheng Office Agent.exe';
export const DEMO_PROMPT = '汇总演示养护待办并生成周报';
export const BASE_PERMISSIONS = Object.freeze(['knowledge.read', 'workspace.write', 'browser.read', 'browser.write',
  'mail.draft', 'agent.delegate', 'reminder.create', 'mail.read', 'mail.send']);
// Built-in role permissions exactly as 0.4.0 shipped them (after migrations 1-3).
export const V04_BUILTIN_DEFAULTS = Object.freeze({
  coordinator: BASE_PERMISSIONS,
  researcher: Object.freeze(['knowledge.read', 'browser.read']),
  writer: Object.freeze(['knowledge.read', 'workspace.write', 'mail.draft']),
});
export const V05_LOCAL_ADDITIONS = Object.freeze({
  coordinator: Object.freeze(['files.read', 'files.write', 'commands.run']),
  researcher: Object.freeze(['files.read']),
  writer: Object.freeze(['files.read', 'files.write']),
});
const HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/, ISO_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- lock binding
function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unexpected keys`);
}
const positiveInteger = (value, label) => assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
export function validateLock(lock, { now = Date.now() } = {}) {
  exactKeys(lock, ['schema', 'repository', 'from', 'to'], 'lock');
  assert.equal(lock.schema, LOCK_SCHEMA, 'Unknown lock schema');
  assert.match(lock.repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Lock repository is invalid');
  for (const role of ['from', 'to']) {
    const entry = lock[role], version = PINNED[role];
    exactKeys(entry, ['version', 'runNumber', 'runId', 'commit', 'artifact', 'installer'], `lock.${role}`);
    assert.equal(entry.version, version, `lock.${role}.version must stay pinned to ${version}`);
    positiveInteger(entry.runNumber, `lock.${role}.runNumber`); positiveInteger(entry.runId, `lock.${role}.runId`);
    assert.match(entry.commit, HEX40, `lock.${role}.commit must be a full lowercase SHA`);
    exactKeys(entry.artifact, ['id', 'name', 'zipBytes', 'zipSha256', 'expiresAt'], `lock.${role}.artifact`);
    positiveInteger(entry.artifact.id, `lock.${role}.artifact.id`); positiveInteger(entry.artifact.zipBytes, `lock.${role}.artifact.zipBytes`);
    assert.equal(entry.artifact.name, ARTIFACT_NAME, `lock.${role}.artifact.name is not the locked artifact name`);
    assert.match(entry.artifact.zipSha256, HEX64, `lock.${role}.artifact.zipSha256 is invalid`);
    assert.match(entry.artifact.expiresAt, ISO_Z, `lock.${role}.artifact.expiresAt is invalid`);
    assert.ok(Date.parse(entry.artifact.expiresAt) > now, `lock.${role} artifact expired at ${entry.artifact.expiresAt}; refusing (no "latest" fallback)`);
    exactKeys(entry.installer, ['name', 'bytes', 'sha256'], `lock.${role}.installer`);
    assert.equal(entry.installer.name, `Luheng-Office-Agent-${version}-windows-x64.exe`, `lock.${role}.installer.name does not match ${version}`);
    positiveInteger(entry.installer.bytes, `lock.${role}.installer.bytes`);
    assert.match(entry.installer.sha256, HEX64, `lock.${role}.installer.sha256 is invalid`);
  }
  for (const [label, pick] of [['runId', e => e.runId], ['commit', e => e.commit], ['artifact id', e => e.artifact.id],
    ['ZIP SHA-256', e => e.artifact.zipSha256], ['installer SHA-256', e => e.installer.sha256]])
    assert.notEqual(pick(lock.from), pick(lock.to), `from/to ${label} must differ`);
  return lock;
}
export function verifyArtifactMetadata(entry, meta, { repository, now = Date.now() } = {}) {
  assert.ok(meta && typeof meta === 'object', 'Artifact metadata missing');
  assert.equal(meta.id, entry.artifact.id, 'Artifact id differs from lock');
  assert.equal(meta.name, entry.artifact.name, 'Artifact name differs from lock');
  assert.equal(meta.size_in_bytes, entry.artifact.zipBytes, 'Artifact ZIP size differs from lock');
  assert.equal(meta.expired, false, 'Artifact is expired; refusing');
  assert.equal(Date.parse(meta.expires_at), Date.parse(entry.artifact.expiresAt), 'Artifact expiry differs from lock');
  assert.ok(Date.parse(meta.expires_at) > now, 'Artifact expired; refusing');
  assert.equal(meta.workflow_run?.id, entry.runId, 'Artifact was not produced by the locked workflow run');
  assert.equal(meta.workflow_run?.head_sha, entry.commit, 'Artifact head SHA differs from the locked commit');
  if (repository) assert.equal(meta.archive_download_url, `https://api.github.com/repos/${repository}/actions/artifacts/${entry.artifact.id}/zip`, 'Unexpected artifact download URL');
  if (meta.digest !== undefined && meta.digest !== null)
    assert.equal(meta.digest, `sha256:${entry.artifact.zipSha256}`, 'Artifact digest differs from lock');
  return { digest: meta.digest ? 'matched' : 'not-provided (local ZIP SHA-256 still enforced)' };
}

// ------------------------------------------------------------------ ZIP reader
let crcTable;
export function crc32Update(crc, buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer, crc);
  crcTable ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const n = readSync(fd, buffer, offset, length - offset, position + offset); assert.ok(n > 0, 'Unexpected end of ZIP'); offset += n; }
  return buffer;
}
const u64 = (buffer, offset) => { const value = buffer.readBigUInt64LE(offset); assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), 'ZIP64 value too large'); return Number(value); };
export function readZipDirectory(fd, size) {
  assert.ok(size >= 22, 'ZIP is too small');
  const tailLength = Math.min(size, 22 + 0xFFFF), tail = readAt(fd, size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { at = i; break; }
  assert.ok(at >= 0, 'ZIP end of central directory not found');
  const eocdOffset = size - tailLength + at;
  let disk = tail.readUInt16LE(at + 4), cdDisk = tail.readUInt16LE(at + 6), count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12), cdOffset = tail.readUInt32LE(at + 16), cdEnd = eocdOffset;
  assert.equal(tail.readUInt16LE(at + 8), count, 'Multi-disk ZIP is not supported');
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    assert.ok(eocdOffset >= 20, 'ZIP64 locator missing');
    const locator = readAt(fd, eocdOffset - 20, 20);
    assert.equal(locator.readUInt32LE(0), 0x07064b50, 'ZIP64 locator missing');
    const z64 = u64(locator, 8); assert.ok(z64 + 56 <= eocdOffset - 20, 'ZIP64 end record out of range');
    const record = readAt(fd, z64, 56);
    assert.equal(record.readUInt32LE(0), 0x06064b50, 'ZIP64 end record missing');
    disk = record.readUInt32LE(16); cdDisk = record.readUInt32LE(20);
    count = u64(record, 32); assert.equal(u64(record, 24), count, 'Multi-disk ZIP is not supported');
    cdSize = u64(record, 40); cdOffset = u64(record, 48); cdEnd = z64;
  }
  assert.equal(disk, 0, 'Multi-disk ZIP is not supported'); assert.equal(cdDisk, 0, 'Multi-disk ZIP is not supported');
  assert.equal(cdOffset + cdSize, cdEnd, 'ZIP central directory is not contiguous with its end record');
  const cd = readAt(fd, cdOffset, cdSize), entries = [];
  let p = 0;
  while (p < cd.length) {
    assert.ok(p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50, 'Malformed ZIP central directory');
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20), uncompressedSize = cd.readUInt32LE(p + 24), localHeaderOffset = cd.readUInt32LE(p + 42);
    const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32), diskStart = cd.readUInt16LE(p + 34);
    assert.ok(p + 46 + n + x + c <= cd.length, 'Malformed ZIP central directory entry');
    const extra = cd.subarray(p + 46 + n, p + 46 + n + x);
    if (uncompressedSize === 0xFFFFFFFF || compressedSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
      let q = 0, found = false;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q), length = extra.readUInt16LE(q + 2); assert.ok(q + 4 + length <= extra.length, 'Malformed ZIP extra field');
        if (id === 1) {
          let r = q + 4;
          if (uncompressedSize === 0xFFFFFFFF) { uncompressedSize = u64(extra, r); r += 8; }
          if (compressedSize === 0xFFFFFFFF) { compressedSize = u64(extra, r); r += 8; }
          if (localHeaderOffset === 0xFFFFFFFF) { localHeaderOffset = u64(extra, r); r += 8; }
          assert.ok(r <= q + 4 + length, 'Malformed ZIP64 extra field'); found = true; break;
        }
        q += 4 + length;
      }
      assert.ok(found, 'ZIP64 extra field missing');
    }
    entries.push({ name: cd.subarray(p + 46, p + 46 + n).toString('utf8'), flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset, diskStart });
    p += 46 + n + x + c;
  }
  assert.equal(entries.length, count, 'ZIP entry count mismatch');
  return { entries, cdOffset };
}
// Streams the ONE locked installer out of the artifact ZIP; size, CRC-32 and
// SHA-256 must all match before the file is accepted. Never extracts other paths.
export async function extractLockedInstaller(zipPath, entryLock, outFile) {
  const expected = entryLock.installer;
  assert.match(expected.name, /^Luheng-Office-Agent-\d+\.\d+\.\d+-windows-x64\.exe$/, 'Unsafe installer name');
  assert.ok(!existsSync(outFile), 'Installer output already exists; refusing to overwrite');
  const fd = openSync(zipPath, 'r'); let entry, start, cdOffset;
  try {
    const directory = readZipDirectory(fd, fstatSync(fd).size); cdOffset = directory.cdOffset;
    assert.equal(directory.entries.length, 1, `Locked artifact must contain exactly one file, found ${directory.entries.length}`);
    entry = directory.entries[0];
    assert.equal(entry.name, expected.name, 'Artifact entry name differs from lock');
    assert.equal(entry.flags & 1, 0, 'Encrypted ZIP entries are not allowed');
    assert.ok([0, 8].includes(entry.method), 'Unsupported ZIP compression method');
    assert.equal(entry.diskStart, 0, 'Multi-disk ZIP is not supported');
    assert.equal(entry.uncompressedSize, expected.bytes, 'ZIP entry size differs from lock');
    if (entry.method === 0) assert.equal(entry.compressedSize, entry.uncompressedSize, 'Stored ZIP entry size mismatch');
    const local = readAt(fd, entry.localHeaderOffset, 30);
    assert.equal(local.readUInt32LE(0), 0x04034b50, 'ZIP local header missing');
    assert.equal(local.readUInt16LE(8), entry.method, 'ZIP local/central method differs');
    const n = local.readUInt16LE(26), x = local.readUInt16LE(28);
    assert.equal(readAt(fd, entry.localHeaderOffset + 30, n).toString('utf8'), entry.name, 'ZIP local/central name differs');
    start = entry.localHeaderOffset + 30 + n + x;
    assert.ok(start + entry.compressedSize <= cdOffset, 'ZIP entry data overlaps the central directory');
  } finally { closeSync(fd); }
  const hash = createHash('sha256'); let bytes = 0, crc = 0, created = false;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length; if (bytes > expected.bytes) return done(new Error('Installer exceeds the locked size'));
    hash.update(chunk); crc = crc32Update(crc, chunk); done(null, chunk);
  } });
  const output = createWriteStream(outFile, { flags: 'wx', mode: 0o600 }); output.once('open', () => { created = true; });
  const source = entry.compressedSize ? createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 }) : Readable.from([]);
  try {
    await pipeline(source, ...(entry.method === 8 ? [zlib.createInflateRaw()] : []), meter, output);
    assert.equal(bytes, expected.bytes, 'Installer size differs from lock');
    assert.equal(crc >>> 0, entry.crc >>> 0, 'ZIP CRC-32 mismatch');
    const sha256 = hash.digest('hex'); assert.equal(sha256, expected.sha256, 'Installer SHA-256 differs from lock');
    return { name: entry.name, bytes, sha256, crc32: (crc >>> 0).toString(16).padStart(8, '0'), method: entry.method };
  } catch (error) { if (created) rmSync(outFile, { force: true }); throw error; }
}
export async function sha256File(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}
export async function checkInstallerFile(entry, file) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Installer must be a regular file');
  assert.equal(stat.size, entry.installer.bytes, 'Installer size differs from lock');
  const actual = await sha256File(file);
  assert.equal(actual.sha256, entry.installer.sha256, 'Installer SHA-256 differs from lock');
  return { name: entry.installer.name, ...actual };
}

// ------------------------------------------------------- download (CI node only)
const API = 'https://api.github.com';
const apiHeaders = token => ({ accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'luheng-windows-upgrade-acceptance' });
async function downloadArtifactZip(lock, entry, token, zipPath) {
  const response = await fetch(`${API}/repos/${lock.repository}/actions/artifacts/${entry.artifact.id}/zip`, { headers: apiHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  await response.body?.cancel();
  assert.equal(response.status, 302, `Artifact ZIP request returned HTTP ${response.status}; failing closed (missing, expired or no permission)`);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.protocol, 'https:', 'Artifact redirect must be HTTPS');
  // The token is never forwarded to the storage redirect.
  const download = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(900000) });
  assert.equal(download.status, 200, `Artifact storage returned HTTP ${download.status}`);
  const hash = createHash('sha256'); let bytes = 0, created = false;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length; if (bytes > entry.artifact.zipBytes) return done(new Error('Artifact ZIP exceeds the locked size'));
    hash.update(chunk); done(null, chunk);
  } });
  const output = createWriteStream(zipPath, { flags: 'wx', mode: 0o600 }); output.once('open', () => { created = true; });
  try {
    await pipeline(Readable.fromWeb(download.body), meter, output);
    assert.equal(bytes, entry.artifact.zipBytes, 'Artifact ZIP size differs from lock');
    const sha256 = hash.digest('hex'); assert.equal(sha256, entry.artifact.zipSha256, 'Artifact ZIP SHA-256 differs from lock');
    return { bytes, sha256 };
  } catch (error) { if (created) rmSync(zipPath, { force: true }); throw error; }
}
export async function fetchLockedInstallers({ lockPath, outDir, token, now = Date.now() }) {
  const lock = validateLock(JSON.parse(readFileSync(lockPath, 'utf8')), { now });
  assert.ok(typeof token === 'string' && token.length > 0, 'GH_TOKEN (workflow github.token) is required');
  mkdirSync(outDir); // fails if it already exists: never reuse stale inputs
  const result = { status: 'locked-inputs-failed', repository: lock.repository, inputs: {} };
  for (const role of ['from', 'to']) {
    const entry = lock[role];
    const response = await fetch(`${API}/repos/${lock.repository}/actions/artifacts/${entry.artifact.id}`, { headers: apiHeaders(token), redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `Artifact metadata returned HTTP ${response.status}; failing closed`);
    const meta = await response.json();
    const metadata = verifyArtifactMetadata(entry, meta, { repository: lock.repository, now });
    const zipPath = join(outDir, `${role}-artifact-${entry.artifact.id}.zip`);
    const zip = await downloadArtifactZip(lock, entry, token, zipPath);
    const installer = await extractLockedInstaller(zipPath, entry, join(outDir, entry.installer.name));
    rmSync(zipPath);
    result.inputs[role] = { version: entry.version, runId: entry.runId, runNumber: entry.runNumber, commit: entry.commit,
      artifact: { id: entry.artifact.id, name: meta.name, expiresAt: meta.expires_at, zip, digest: metadata.digest }, installer };
  }
  result.status = 'locked-inputs-verified';
  return result;
}

// ------------------------------------------------------------ SQLite snapshots
export function readSnapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const migrations = db.prepare('SELECT version, applied_at FROM migrations ORDER BY version').all().map(r => ({ version: Number(r.version), applied_at: r.applied_at }));
  const records = {};
  for (const r of db.prepare('SELECT kind, id, payload FROM records ORDER BY kind, id').all()) (records[r.kind] ??= {})[r.id] = JSON.parse(r.payload);
  return { tables, migrations, records };
}
// Reads a COPY of agent.sqlite(+WAL/SHM) so the inspected profile is never opened or checkpointed;
// PRAGMA integrity_check must report exactly 'ok' on the copy.
export async function snapshotDatabase(dataDir) {
  const source = join(dataDir, 'agent.sqlite');
  const temp = mkdtempSync(join(tmpdir(), 'luheng-upgrade-db-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!existsSync(source + suffix)) { assert.ok(suffix, 'agent.sqlite is missing'); continue; }
      const stat = lstatSync(source + suffix); assert.ok(stat.isFile() && !stat.isSymbolicLink(), `agent.sqlite${suffix} must be a regular file`);
      copyFileSync(source + suffix, join(temp, 'agent.sqlite' + suffix));
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(temp, 'agent.sqlite'));
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
      assert.deepEqual(integrity, ['ok'], `Snapshot integrity_check failed: ${integrity.join('; ')}`);
      return clone(readSnapshot(db));
    } finally { db.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export const liveSnapshot = store => clone(readSnapshot(store.db));

// --------------------------------------------------- migration 4 + diff oracles
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && b.every(p => a.includes(p));
// Independent oracle: only ENABLED built-in roles whose permissions are exactly the
// 0.4 defaults (order-insensitive) gain local permissions; everything else is untouched.
export function expectedMigration4(agents) {
  const result = clone(agents || {});
  for (const [id, defaults] of Object.entries(V04_BUILTIN_DEFAULTS)) {
    const agent = result[id];
    if (agent?.enabled === true && sameSet(agent.permissions, defaults)) agent.permissions = [...agent.permissions, ...V05_LOCAL_ADDITIONS[id]];
  }
  return result;
}
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
const onlyChanged = (before, after, keys) => isDeepStrictEqual(without(before, keys), without(after, keys));
function recordDiff(before, after, { allowAdd, allowChange }) {
  const violations = [], added = [], changed = [];
  for (const kind of [...new Set([...Object.keys(before.records), ...Object.keys(after.records)])].sort()) {
    const b = before.records[kind] || {}, a = after.records[kind] || {};
    for (const id of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (!Object.hasOwn(a, id)) { violations.push(`removed ${kind}/${id}`); continue; }
      if (!Object.hasOwn(b, id)) { added.push(`${kind}/${id}`); if (!allowAdd(kind, id, a[id])) violations.push(`unexpected new ${kind}/${id}`); continue; }
      if (isDeepStrictEqual(b[id], a[id])) continue;
      changed.push(`${kind}/${id}`); if (!allowChange(kind, id, b[id], a[id])) violations.push(`unexpected change ${kind}/${id}`);
    }
  }
  return { violations, added, changed };
}
const sessionChange = (kind, b, a) => kind === 'sessions' && onlyChanged(b, a, ['writeLease', 'status']);
const policyRevisionOnly = (kind, id, b, a) => kind === 'local_access' && id === 'policy' && onlyChanged(b, a, ['revision']) && a.revision > b.revision;
// Restart/reinstall of the same version: nothing but audit lines, the documented
// per-start local-access revision bump and browser-session lease reset may change.
export function steadyStateDiff(before, after) {
  const diff = recordDiff(before, after, {
    allowAdd: kind => kind === 'audit',
    allowChange: (kind, id, b, a) => policyRevisionOnly(kind, id, b, a) || sessionChange(kind, b, a),
  });
  if (!isDeepStrictEqual(before.migrations, after.migrations)) diff.violations.push('migrations changed');
  if (!isDeepStrictEqual(before.tables, after.tables)) diff.violations.push('tables changed');
  return diff;
}
export function upgradeDiff(before, after, seed) {
  const expectedAgents = expectedMigration4(before.records.agents);
  const catchUpReminder = seed.reminders.catchUp, catchUpSchedule = seed.schedules.catchUp;
  const newOccurrences = Object.values(after.records.schedule_occurrences || {}).filter(o => !before.records.schedule_occurrences?.[o.id]);
  const occurrence = newOccurrences.length === 1 && newOccurrences[0].scheduleId === catchUpSchedule ? newOccurrences[0] : null;
  const diff = recordDiff(before, after, {
    allowAdd: (kind, id, value) => kind === 'audit'
      || kind === 'local_access' && id === 'policy' && value.mode === 'disabled' && isDeepStrictEqual(value.roots, []) && value.allFiles === false && value.configured === false
      || kind === 'notifications' && id === `reminder-${catchUpReminder}` && value.reminderId === catchUpReminder
      || kind === 'schedule_occurrences' && occurrence?.id === id && value.scheduledFor === seed.catchUpAt && value.status === 'created' && !!value.taskId && value.coalesced === false
      || kind === 'tasks' && !!occurrence && value.scheduleOccurrenceId === occurrence.id && value.id === occurrence.taskId && value.status === 'completed',
    allowChange: (kind, id, b, a) => kind === 'agents' && isDeepStrictEqual(a, expectedAgents[id])
      || kind === 'reminders' && id === catchUpReminder && b.status === 'scheduled' && a.status === 'fired' && onlyChanged(b, a, ['status', 'firedAt'])
      || kind === 'schedules' && id === catchUpSchedule && !!occurrence && a.lastOccurrenceId === occurrence.id && a.lastTaskId === occurrence.taskId
        && Date.parse(a.nextRunAt) > Date.parse(seed.catchUpAt) && onlyChanged(b, a, ['nextRunAt', 'updatedAt', 'lastRunAt', 'lastTaskId', 'lastOccurrenceId', 'runCount', 'lastError'])
      || sessionChange(kind, b, a),
  });
  for (const [id, agent] of Object.entries(expectedAgents))
    if (!isDeepStrictEqual(after.records.agents?.[id], agent)) diff.violations.push(`agent ${id} does not match the migration-4 rule`);
  if (!occurrence) diff.violations.push(`expected exactly one catch-up occurrence, found ${newOccurrences.length}`);
  if (!after.records.notifications?.[`reminder-${catchUpReminder}`]) diff.violations.push('catch-up reminder did not fire exactly once');
  if (!after.records.local_access?.policy) diff.violations.push('0.5 local-access policy missing');
  return { ...diff, occurrence };
}

// ------------------------------------------------------------- raw scan helpers
export const rawHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plainHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
// Distinctive synthetic markers plus the unkeyed digests anyone could recompute
// from a guessed payload (sha256(JSON) like the repository tests, sha256(raw)).
export function scanNeedles({ markers = [], digestInputs = [] } = {}) {
  const needles = new Set();
  for (const marker of markers) {
    assert.ok(typeof marker === 'string' && marker.length >= 16, 'Scan markers must be distinctive strings');
    needles.add(marker); needles.add(Buffer.from(marker, 'utf8').toString('base64'));
  }
  for (const value of digestInputs) for (const digest of [rawHash(value), plainHash(value)]) { needles.add(digest); needles.add(digest.toUpperCase()); }
  return [...needles];
}
export const seedNeedles = seed => scanNeedles({ markers: Object.values(seed.sentinels || {}), digestInputs: seed.digestInputs || [] });
// Raw byte scan (UTF-8 and UTF-16LE) of every file below root; links are refused.
export function scanForSentinels(root, sentinels) {
  const needles = sentinels.flatMap(s => [Buffer.from(s, 'utf8'), Buffer.from(s, 'utf16le')]), hits = [];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), `Links are not allowed in owned profiles: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) { const data = readFileSync(path); if (needles.some(n => data.includes(n))) hits.push(path); }
    }
  };
  walk(root); return hits;
}
// Number of needles present in an API JSON payload (the needles themselves are never echoed).
export const jsonHits = (value, needles) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return needles.filter(n => text.includes(n)).length; };

// ------------------------------------------------------------ backend harness
export const createEffectCounters = () => ({ completion: 0, smtp: 0, imap: 0, browserLaunch: 0 });
function guardPlaywright(backendDir, counters) {
  let playwright;
  try { playwright = createRequire(join(backendDir, 'package.json'))('playwright'); } catch { return 'playwright-not-installed (no launch possible)'; }
  for (const type of ['chromium', 'firefox', 'webkit']) for (const method of ['launch', 'launchPersistentContext', 'launchServer', 'connect', 'connectOverCDP'])
    if (typeof playwright[type]?.[method] === 'function') playwright[type][method] = async () => { counters.browserLaunch++; throw new Error('Browser launch blocked during upgrade acceptance'); };
  return 'playwright-launch-counted-and-blocked';
}
export const MAIL_FIXTURE = Object.freeze({ accountId: 'main', from: 'upgrade-ci@example.com', to: 'upgrade-recipient@example.com', user: 'upgrade-ci@example.com', host: '127.0.0.1', port: 46525 });
// 127.0.0.1 + allowTestLocal: the real MailService skips DNS; the connection itself is the synthetic boundary below.
export const mailConfig = password => ({ accountId: MAIL_FIXTURE.accountId, from: MAIL_FIXTURE.from,
  smtp: { host: MAIL_FIXTURE.host, port: MAIL_FIXTURE.port, secure: true, user: MAIL_FIXTURE.user, password } });
export const smtpAuthMarker = password => Buffer.from(`\0${MAIL_FIXTURE.user}\0${password}`).toString('base64');
// Synthetic SMTP connection injected as MailService.smtpFactory, i.e. at the real
// transport boundary after approval, account, credential and retry checks. Every
// connection attempt is counted. Without a scripted reply it is refused (counted,
// nothing delivered). 'accept' = 250 after DATA; 'hang' = DATA consumed, no reply.
export function createSmtpBoundary(counters, plan = null) {
  const accepted = [];
  const factory = () => {
    counters.smtp++;
    const behavior = plan?.shift();
    if (!['accept', 'hang'].includes(behavior)) throw new Error('SMTP connection blocked during upgrade acceptance');
    const connection = new EventEmitter();
    Object.assign(connection, {
      secure: true, lastServerResponse: '220 synthetic.invalid ESMTP',
      connect(callback) { setImmediate(callback); },
      login(_auth, callback) { connection.lastServerResponse = '235 2.7.0 Authentication successful'; setImmediate(() => callback(null)); },
      send(envelope, stream, callback) {
        connection.lastServerResponse = '354 End data with <CR><LF>.<CR><LF>';
        let bytes = 0;
        stream.on('data', chunk => { bytes += chunk.length; });
        stream.on('error', error => callback(error));
        stream.on('end', () => {
          if (behavior !== 'accept') return;
          connection.lastServerResponse = '250 2.0.0 queued';
          accepted.push({ to: [...envelope.to], bytes });
          setImmediate(() => callback(null, { accepted: [...envelope.to], rejected: [], response: '250 2.0.0 queued' }));
        });
      },
      close() { connection.closed = true; },
    });
    return connection;
  };
  return { factory, accepted };
}
async function connect(app) {
  const root = await fetch(app.url + '/', { signal: AbortSignal.timeout(10000) });
  const html = await root.text(), cookie = root.headers.get('set-cookie')?.split(';')[0];
  assert.ok(root.ok && cookie?.startsWith('luheng_session='), 'UI page did not issue a session cookie');
  const headers = method => method === 'GET' ? { cookie } : { cookie, origin: app.url, 'content-type': 'application/json' };
  const call = async (method, path, body, { ok = true } = {}) => {
    const response = await fetch(app.url + path, { method, headers: headers(method), body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20000) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (ok) assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return { status: response.status, ok: response.ok, data };
  };
  return {
    html, cookie,
    get: (path, options) => call('GET', path, undefined, options), post: (path, body, options) => call('POST', path, body, options),
    put: (path, body, options) => call('PUT', path, body, options),
    // Requests whose handler intentionally never finishes before the crash (in-flight work).
    detach: (path, body) => { fetch(app.url + path, { method: 'POST', headers: headers('POST'), body: JSON.stringify(body ?? {}) }).then(r => r.arrayBuffer()).catch(() => {}); },
    bytes: async path => { const r = await fetch(app.url + path, { headers: { cookie }, signal: AbortSignal.timeout(20000) }); assert.ok(r.ok, `GET ${path}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
  };
}
export async function startBackend(backendDir, dataDir, { expectVersion, counters = createEffectCounters(), completion, smtpPlan = null, mailTimeoutMs = 15000, extra = {} } = {}) {
  const pkg = JSON.parse(readFileSync(join(backendDir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, expectVersion, `Backend version ${pkg.version} differs from expected ${expectVersion}`);
  const browserGuard = guardPlaywright(backendDir, counters);
  const smtp = createSmtpBoundary(counters, smtpPlan);
  const { startServer } = await import(pathToFileURL(join(backendDir, 'server.mjs')).href);
  const app = await startServer({ port: 0, dataDir, stepDelay: 1,
    completion: completion || (async () => { counters.completion++; throw new Error('Model calls are blocked during upgrade acceptance'); }),
    mailOptions: { allowTestLocal: true, timeoutMs: mailTimeoutMs, smtpFactory: smtp.factory,
      imapFactory: () => { counters.imap++; throw new Error('IMAP blocked during upgrade acceptance'); } }, ...extra });
  try { return { app, counters, smtp, browserGuard, http: await connect(app) }; } catch (error) { await app.close(); throw error; }
}
// Scripted model at the completion boundary: routed by a prompt marker, one step per assistant round.
const MARKER = /\[UPGRADE-CI:([a-z0-9-]+)\]/;
function scriptedCompletion(counters, script) {
  const calls = {}, hung = new Set();
  const completion = async ({ messages, signal }) => {
    counters.completion++;
    const marker = messages.filter(m => m.role === 'user').map(m => String(m.content ?? '')).join('\n').match(MARKER)?.[1] ?? 'unmarked';
    const round = messages.filter(m => m.role === 'assistant').length + 1;
    calls[marker] = (calls[marker] || 0) + 1;
    const tool = [...messages].reverse().find(m => m.role === 'tool');
    let toolResult = null; try { toolResult = tool ? JSON.parse(tool.content) : null; } catch {}
    const step = script(marker, round, toolResult);
    if (step === 'hang') {
      hung.add(marker);
      return new Promise((_, reject) => { const stop = () => reject(new Error('synthetic model request aborted')); if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true }); });
    }
    if (!step) throw new Error(`Synthetic model has no step for ${marker} round ${round}`);
    return { message: { role: 'assistant', content: step.content ?? '', ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) }, usage: null };
  };
  return { completion, calls, hung };
}
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
// Task-bound mail through the real engine tools: draft -> approval request -> (after SMTP) next round hangs.
function mailSteps(marker, round, toolResult) {
  if (round === 1) return { tool_calls: [toolCall(`call_${marker}_draft`, 'mail_create_draft', { accountId: MAIL_FIXTURE.accountId, to: MAIL_FIXTURE.to,
    subject: `升级验收合成邮件 ${marker}`, text: '合成测试邮件正文：收件人为保留域名，不包含真实业务数据。' })] };
  if (round === 2 && typeof toolResult?.id === 'string' && toolResult.sent === false) return { tool_calls: [toolCall(`call_${marker}_send`, 'mail_request_send', { draftId: toolResult.id })] };
  if (round === 3 && toolResult?.status === 'sent') return 'hang';
  return null;
}
async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await check(); if (value) return value; assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`); await sleep(50); }
}
const waitTask = (http, id, status, timeoutMs) => waitFor(async () => { const t = (await http.get(`/api/tasks/${id}`)).data; assert.ok(!['failed', 'cancelled', 'rejected'].includes(t.status) || t.status === status, `task ${id} ended ${t.status}: ${t.error}`); return t.status === status && t; }, `task ${id} ${status}`, timeoutMs);
const titleOf = html => html.match(/<title>([^<]*)<\/title>/)?.[1] || '';
const versionTag = version => `v${version.split('.').slice(0, 2).join('.')}`;
const assertZero = counters => assert.deepEqual(counters, createEffectCounters(), `Unexpected side effects: ${JSON.stringify(counters)}`);
const integrityOf = db => db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
export const liveIntegrity = store => { const result = integrityOf(store.db); assert.deepEqual(result, ['ok'], `Live database integrity_check failed: ${result.join('; ')}`); return 'ok'; };
async function downloadArtifacts(http, tasks) {
  const out = [];
  for (const task of tasks) for (const artifact of [task.artifact, ...(task.artifacts || []), ...(task.exports || [])].filter(Boolean)) {
    const data = await http.bytes(artifact.url);
    out.push({ taskId: task.id, filename: artifact.filename, url: artifact.url, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}
async function healthAndUi(http, version) {
  const health = (await http.get('/health')).data;
  assert.equal(health.ok, true); assert.equal(health.localOnly, true); assert.equal(health.version, version);
  const title = titleOf(http.html);
  assert.ok(title.includes(versionTag(version)), `Served UI title "${title}" is not ${versionTag(version)}`);
  const state = (await http.get('/api/state')).data; assert.equal(state.system.version, version);
  return { health, title, state };
}
async function apiHits(http, needles, extraPaths = []) {
  const state = (await http.get('/api/state')).data, hits = [];
  for (const path of ['/api/state', '/api/local-access/state', ...state.tasks.map(t => `/api/tasks/${t.id}`), ...extraPaths]) {
    const response = await http.get(path, { ok: false });
    if (response.status !== 404 && jsonHits(response.data, needles)) hits.push(path);
  }
  return hits;
}
// Facts read straight from the live store: [task status], [draft status, SMTP attempts], approval statuses.
function mailFacts(store, { tasks = {}, drafts = {}, serviceApprovals = {}, centralApprovals = {} }) {
  const map = (ids, read) => Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, read(id)]));
  return {
    tasks: map(tasks, id => store.get('tasks', id)?.status ?? null),
    drafts: map(drafts, id => { const d = store.get('mail_outbox', id); return d ? [d.status, d.attempts] : null; }),
    service: map(serviceApprovals, id => store.get('mail_approvals', id)?.status ?? null),
    central: map(centralApprovals, id => store.get('approvals', id)?.status ?? null),
  };
}
function mailIdsFor(store, taskId) {
  const task = store.get('tasks', taskId), central = store.all('approvals').filter(a => a.taskId === taskId && a.type === 'mail.send');
  assert.equal(central.length, 1, `task ${taskId} must have exactly one mail approval`); assert.equal(central[0].status, 'pending');
  assert.ok(task.mailDraftId && central[0].serviceApprovalId, `task ${taskId} mail binding missing`);
  return { draft: task.mailDraftId, service: central[0].serviceApprovalId, central: central[0].id };
}
async function configureMail(http, password) {
  const account = (await http.post('/api/mail/config', mailConfig(password))).data;
  assert.equal(account.hasCredentials?.smtp, true, 'Synthetic SMTP credentials were not accepted');
  assert.equal(jsonHits(account, [password]), 0, 'Mail config response echoed the password');
  return account;
}
const MAIL_SENT_MESSAGE = '邮件已被SMTP服务器接受，但后续任务中断；不要重复发送';
const MAIL_UNKNOWN_MESSAGE = '上次邮件发送结果不确定，请人工核实，禁止重新创建相同发送任务或自动重发';
const RECOVERY_WARNINGS = Object.freeze({
  LOCAL_CONTEXT_INTERRUPTED: '本地任务在上次运行中断，正文及旧审批已失效；不会自动继续或重放，请先核实已有结果',
  MAIL_DELIVERY_UNKNOWN: '上次邮件投递结果未知，请人工核实收件情况；禁止重复发送',
  MAIL_ACCEPTED_BY_SMTP: '邮件已被SMTP服务器接受；不要重复发送，SMTP接受不代表收件人已读',
  BROWSER_INPUT_UNKNOWN: '上次网页输入结果未知，请人工核实；禁止重放相同动作',
  BROWSER_INPUT_COMPLETED: '网页输入已经执行；不要重复执行相同动作，请人工核实页面结果',
});
function crashNow(seed, onSeeded) {
  // Called synchronously right after the facts were asserted: persist the seed
  // description, then die without any graceful close (WAL kept).
  onSeeded(seed);
  process.kill(process.pid, 'SIGKILL');
}

// --------------------------------------------------------- 1. 0.4.0 seed data
export async function seedV04({ backendDir, dataDir, expectVersion = PINNED.from, catchUpDelayMs = 240000 }) {
  const { app, http, counters, browserGuard } = await startBackend(backendDir, dataDir, { expectVersion });
  try {
    const { title } = await healthAndUi(http, expectVersion);
    const settings = (await http.post('/api/settings', { mode: 'demo', endpoint: 'https://api.openai.com/v1', model: 'upgrade-fixture-model', budget: 23 })).data;
    const agents = Object.fromEntries((await http.get('/api/state')).data.agents.map(a => [a.id, a]));
    for (const id of Object.keys(V04_BUILTIN_DEFAULTS)) assert.ok(sameSet(agents[id]?.permissions, V04_BUILTIN_DEFAULTS[id]) && agents[id].enabled === true, `Fresh ${id} is not the 0.4 default`);
    const edit = (agent, patch) => http.put(`/api/agents/${agent.id}`, { name: agent.name, role: agent.role, personality: agent.personality, permissions: agent.permissions, enabled: agent.enabled, ...patch });
    await edit(agents.researcher, { permissions: ['knowledge.read'] }); // narrowed by owner: must not expand
    await edit(agents.writer, { enabled: false }); // disabled default: must not expand
    const custom = (await http.post('/api/agents', { name: '升级验收自定义角色', role: '合成文稿角色', personality: '仅用于升级验收的合成角色', permissions: [...V04_BUILTIN_DEFAULTS.writer], enabled: true })).data;
    const memories = [
      (await http.post('/api/memories', { title: '升级验收工作区知识', content: '合成数据：升级前后必须保持不变。', source: '升级验收 · SYNTHETIC-001' })).data.id,
      (await http.post('/api/memories', { title: '升级验收角色私有知识', content: '合成数据：研究员私有知识。', source: '升级验收 · SYNTHETIC-002', scope: 'agent', ownerAgentId: 'researcher' })).data.id,
    ];
    const at = ms => new Date(Math.ceil(ms / 1000) * 1000).toISOString();
    const catchUpAt = at(Date.now() + catchUpDelayMs);
    const reminders = {
      past: (await http.post('/api/reminders', { title: '升级验收已到期提醒', dueAt: new Date(Date.now() - 60000).toISOString() })).data.id,
      future: (await http.post('/api/reminders', { title: '升级验收未来提醒', dueAt: at(Date.now() + 30 * 86400000) })).data.id,
      catchUp: (await http.post('/api/reminders', { title: '升级验收停机期间到期提醒', dueAt: catchUpAt })).data.id,
    };
    const schedule = async (title, recurrence, startAt, status = 'active') => (await http.post('/api/schedules', { title, prompt: DEMO_PROMPT, agentId: 'coordinator', budget: 6, timezone: 'Asia/Shanghai', recurrence, startAt, status })).data.id;
    const schedules = {
      once: await schedule('升级验收单次调度', { type: 'interval', intervalMinutes: 525600 }, at(Date.now() + 2000)),
      paused: await schedule('升级验收暂停调度', { type: 'daily', time: '09:30' }, at(Date.now() + 3600000), 'paused'),
      future: await schedule('升级验收远期调度', { type: 'weekly', time: '08:15', daysOfWeek: [1, 3] }, '2099-01-01T00:00:00Z'),
      catchUp: await schedule('升级验收停机期间到期调度', { type: 'interval', intervalMinutes: 525600 }, catchUpAt),
    };
    const manual = (await http.post('/api/tasks', { prompt: DEMO_PROMPT + '（升级前手动任务）', agentId: 'coordinator', budget: 8 })).data;
    await waitTask(http, manual.id, 'completed');
    const exports = [];
    for (const format of ['docx', 'xlsx']) exports.push((await http.post(`/api/tasks/${manual.id}/export`, { format })).data.filename);
    const occurrence = await waitFor(async () => (await http.get('/api/state')).data.scheduleOccurrences.find(o => o.scheduleId === schedules.once && o.taskId), 'one-shot schedule dispatch', 20000);
    await waitTask(http, occurrence.taskId, 'completed');
    await waitFor(async () => (await http.get('/api/state')).data.notifications.find(n => n.id === `reminder-${reminders.past}`), 'past reminder notification', 10000);
    await sleep(1500); // one more heartbeat/schedule tick: nothing else may fire
    const state = (await http.get('/api/state')).data;
    assert.equal(state.tasks.length, 2, 'Seed must contain exactly the manual and one-shot scheduled task');
    assert.equal(state.scheduleOccurrences.length, 1, 'Only the one-shot schedule may have run');
    assert.equal(state.notifications.length, 1, 'Only the past reminder may have fired');
    assert.ok(Date.now() < Date.parse(catchUpAt) - Math.min(30000, catchUpDelayMs / 4), 'Catch-up instant is too close; increase catchUpDelayMs');
    const artifacts = await downloadArtifacts(http, state.tasks);
    assert.equal(artifacts.length, 4, 'Expected two TXT reports plus DOCX/XLSX exports');
    liveIntegrity(app.store);
    assertZero(counters);
    return { status: 'seeded-v0.4.0', version: expectVersion, title, browserGuard, settings: { model: settings.model, budget: settings.budget, mode: settings.mode },
      agents: { custom: custom.id, narrowed: 'researcher', disabled: 'writer', untouched: 'coordinator' }, memories, reminders, schedules, catchUpAt,
      tasks: { manual: manual.id, scheduledOnce: occurrence.taskId }, occurrences: { once: occurrence.id }, exports, artifacts, counters };
  } finally { await app.close(); }
}

// ------------------------------------------------- 1. first 0.5.0 start on 0.4 data
export async function verifyUpgrade({ backendDir, dataDir, seed, before, expectVersion = PINNED.to, maxCatchUpWaitMs = 300000, quietMs = 3000 }) {
  assert.deepEqual(before.migrations.map(m => m.version), [1, 2, 3], '0.4 snapshot must contain migrations 1..3 only');
  assert.equal(before.records.reminders?.[seed.reminders.catchUp]?.status, 'scheduled', 'Timing precondition failed: catch-up reminder fired before the upgrade');
  assert.ok(!Object.values(before.records.schedule_occurrences || {}).some(o => o.scheduleId === seed.schedules.catchUp), 'Timing precondition failed: catch-up schedule ran before the upgrade');
  const wait = Date.parse(seed.catchUpAt) + 1500 - Date.now();
  assert.ok(wait <= maxCatchUpWaitMs, 'Catch-up instant is unexpectedly far in the future');
  if (wait > 0) await sleep(wait);
  assert.deepEqual(await snapshotDatabase(dataDir), before, 'Profile database changed between the 0.4 snapshot and the first 0.5 start');
  const { app, http, counters, browserGuard } = await startBackend(backendDir, dataDir, { expectVersion });
  try {
    const { health, title, state } = await healthAndUi(http, expectVersion);
    assert.ok(!title.includes(versionTag(PINNED.from)), 'Served UI still reports 0.4');
    const migrations = liveSnapshot(app.store).migrations;
    assert.deepEqual(migrations.map(m => m.version), [1, 2, 3, 4], 'Migrations after upgrade must be exactly 1..4');
    assert.deepEqual(migrations.slice(0, 3), before.migrations, 'Existing migration rows were rewritten');
    const expectedAgents = expectedMigration4(before.records.agents);
    for (const agent of state.agents) assert.deepEqual(agent.permissions, expectedAgents[agent.id].permissions, `HTTP agent ${agent.id} permissions differ from migration rule`);
    assert.deepEqual(expectedAgents.coordinator.permissions.slice(-3), V05_LOCAL_ADDITIONS.coordinator, 'Untouched coordinator should gain local permissions');
    for (const id of ['researcher', 'writer', seed.agents.custom]) assert.deepEqual(expectedAgents[id], before.records.agents[id], `${id} must not be expanded`);
    const local = (await http.get('/api/local-access/state')).data;
    assert.equal(local.mode, 'disabled'); assert.deepEqual(local.roots, []); assert.equal(local.allFiles, false); assert.deepEqual(local.pending, []);
    const probe = await http.post('/api/local-access/operations', { kind: 'list', path: dataDir }, { ok: false });
    assert.ok(!probe.ok && /尚未连接本机访问权限/.test(probe.data?.error), 'Host local access must start disabled after upgrade');
    const notification = await waitFor(async () => (await http.get('/api/state')).data.notifications.find(n => n.id === `reminder-${seed.reminders.catchUp}`), 'catch-up reminder', 10000);
    const occurrence = await waitFor(async () => (await http.get('/api/state')).data.scheduleOccurrences.find(o => o.scheduleId === seed.schedules.catchUp && o.taskId), 'catch-up schedule', 15000);
    await waitTask(http, occurrence.taskId, 'completed');
    await sleep(quietMs);
    const after = liveSnapshot(app.store), diff = upgradeDiff(before, after, seed);
    assert.deepEqual(diff.violations, [], `Upgrade changed data outside the documented migration: ${diff.violations.join('; ')}`);
    const finalState = (await http.get('/api/state')).data;
    const previous = await downloadArtifacts(http, finalState.tasks.filter(t => before.records.tasks[t.id]));
    assert.deepEqual(previous, seed.artifacts, '0.4 artifacts are not byte-identical or not downloadable via 0.5');
    // Full manifest (old + catch-up artifacts): verify-reinstall re-downloads and compares every byte digest.
    const artifactManifest = await downloadArtifacts(http, finalState.tasks);
    assert.equal(artifactManifest.length, seed.artifacts.length + 1, 'Expected the 0.4 artifacts plus one catch-up report');
    liveIntegrity(app.store);
    assertZero(counters);
    return { status: 'upgrade-verified', fromVersion: PINNED.from, toVersion: expectVersion, health, title, browserGuard, migrations,
      agents: Object.fromEntries(Object.entries(expectedAgents).map(([id, a]) => [id, { enabled: a.enabled, permissions: a.permissions }])),
      localAccess: { mode: local.mode, allFiles: local.allFiles, roots: local.roots, proposeRejected: probe.data.error },
      catchUp: { notification: notification.id, occurrence: occurrence.id, taskId: occurrence.taskId },
      diff: { added: diff.added, changed: diff.changed }, artifacts: previous, artifactManifest, integrity: 'ok', counters };
  } finally { await app.close(); }
}

// ---------------------------- 2a. interrupted 0.4.0 work recovered by 0.5.0 (seed)
const V04_MARKERS = Object.freeze({ awaiting: 'v04-mail-awaiting', unknown: 'v04-mail-unknown', sent: 'v04-mail-sent', running: 'v04-running', queued: 'v04-queued' });
const V04_AT_CRASH = Object.freeze({
  tasks: { awaiting: 'awaiting_approval', unknown: 'needs_attention', sent: 'running', running: 'running', queued: 'queued' },
  drafts: { awaiting: ['pending_approval', 0], unknown: ['unknown', 1], sent: ['sent', 1], workbench: ['sending', 1] },
  service: { awaiting: 'pending', unknown: 'approved', sent: 'approved', workbench: 'approved' },
  central: { awaiting: 'pending', unknown: 'approved', sent: 'approved' },
});
export const V04_AFTER_RECOVERY = Object.freeze({
  tasks: { awaiting: 'awaiting_approval', unknown: 'needs_attention', sent: 'needs_attention', running: 'failed', queued: 'failed' },
  drafts: { awaiting: ['pending_approval', 0], unknown: ['unknown', 1], sent: ['sent', 1], workbench: ['unknown', 1] },
  service: { awaiting: 'pending', unknown: 'approved', sent: 'approved', workbench: 'approved' },
  central: { awaiting: 'pending', unknown: 'approved', sent: 'approved' },
});
// Runs on the INSTALLED 0.4.0 backend: real engine + MailService flows, then SIGKILL.
export async function seedRecoveryV04({ backendDir, dataDir, expectVersion = PINNED.from, mailTimeoutMs = 4000, onSeeded }) {
  const counters = createEffectCounters(), smtpPlan = [], M = V04_MARKERS;
  const password = `synthetic-test-only-${randomBytes(16).toString('hex')}`;
  const model = scriptedCompletion(counters, (marker, round, toolResult) =>
    [M.awaiting, M.unknown, M.sent].includes(marker) ? mailSteps(marker, round, toolResult) : marker === M.running && round === 1 ? 'hang' : null);
  const { app, http, smtp } = await startBackend(backendDir, dataDir, { expectVersion, counters, completion: model.completion, smtpPlan, mailTimeoutMs });
  await healthAndUi(http, expectVersion);
  await configureMail(http, password);
  app.store.put('settings', 'main', { ...app.store.get('settings', 'main'), mode: 'api', model: 'recovery-fixture-model' });
  const create = async marker => (await http.post('/api/tasks', { prompt: `[UPGRADE-CI:${marker}] 合成升级恢复任务（不含真实业务数据）`, agentId: 'coordinator', budget: 8 })).data.id;
  const tasks = {}, drafts = {}, service = {}, central = {};
  for (const key of ['awaiting', 'unknown', 'sent']) tasks[key] = await create(M[key]);
  for (const key of ['awaiting', 'unknown', 'sent']) {
    await waitTask(http, tasks[key], 'awaiting_approval', 20000);
    ({ draft: drafts[key], service: service[key], central: central[key] } = mailIdsFor(app.store, tasks[key]));
  }
  // unknown: the server consumed DATA but never replied; the real service timeout persists `unknown`.
  smtpPlan.push('hang');
  await http.post(`/api/approvals/${central.unknown}`, { decision: 'approve' });
  await waitFor(() => app.store.get('mail_outbox', drafts.unknown)?.status === 'unknown', 'persisted unknown delivery', mailTimeoutMs + 5000);
  // sent: SMTP accepted (250); the model round that follows hangs, so the task is still running at the crash.
  smtpPlan.push('accept');
  http.detach(`/api/approvals/${central.sent}`, { decision: 'approve' });
  await waitFor(() => app.store.get('mail_outbox', drafts.sent)?.status === 'sent' && model.hung.has(M.sent), 'SMTP acceptance followed by a hung model round', 20000);
  // running: model request hangs (second engine slot). queued: both slots busy.
  tasks.running = await create(M.running);
  await waitFor(() => model.hung.has(M.running), 'hung model request', 20000);
  tasks.queued = await create(M.queued);
  await sleep(1500);
  // sending at crash: a mail-workbench draft (no task: the engine has no free slot) approved through the
  // mail service; DATA is consumed and the process dies before any reply or service timeout.
  const workbench = (await http.post('/api/mail/drafts', { accountId: MAIL_FIXTURE.accountId, to: [MAIL_FIXTURE.to], subject: '升级验收工作台合成邮件', text: '合成测试邮件正文（工作台）。' })).data;
  drafts.workbench = workbench.id;
  service.workbench = (await http.post(`/api/mail/drafts/${workbench.id}/request-send`, {})).data.id;
  smtpPlan.push('hang');
  http.detach(`/api/mail/approvals/${service.workbench}`, { decision: 'approve' });
  await waitFor(() => { const d = app.store.get('mail_outbox', drafts.workbench); return d?.status === 'sending' && d.dataStarted === true; }, 'in-flight SMTP DATA', Math.max(1000, mailTimeoutMs / 2));
  // Synchronous from here to the kill: the asserted facts cannot drift.
  const ids = { tasks, drafts, serviceApprovals: service, centralApprovals: central };
  const atCrash = mailFacts(app.store, ids);
  assert.deepEqual(atCrash, clone(V04_AT_CRASH), 'Seeded 0.4 facts differ from the plan');
  assert.equal(app.store.get('mail_outbox', drafts.unknown).dataStarted, true, 'unknown delivery must have started DATA');
  assert.equal(counters.smtp, 3, 'Exactly three SMTP connections expected in the 0.4 seed'); assert.equal(smtp.accepted.length, 1);
  assert.deepEqual(model.calls, { [M.awaiting]: 2, [M.unknown]: 2, [M.sent]: 3, [M.running]: 1 }, 'Unexpected model rounds');
  crashNow({ status: 'seeded-before-kill', variant: 'v04-cross-version', version: expectVersion, mail: { password, timeoutMs: mailTimeoutMs },
    sentinels: { smtpPassword: password, smtpAuth: smtpAuthMarker(password) }, digestInputs: [password], ...ids, atCrash,
    counters: { ...counters }, smtpAccepted: smtp.accepted.length, modelCalls: { ...model.calls } }, onSeeded);
  await sleep(60000);
  throw new Error('process survived SIGKILL');
}

// ----------------------- 2b. 0.4.0 crash state opened by 0.5.0 (independent processes)
export async function verifyRecoveryV04({ backendDir, dataDir, seed, run, expectVersion = PINNED.to, quietMs = 3000 }) {
  assert.equal(seed.variant, 'v04-cross-version'); assert.equal(seed.version, PINNED.from);
  const needles = seedNeedles(seed);
  assert.deepEqual(scanForSentinels(dataDir, needles), [], 'Raw 0.4 recovery profile contains private markers before restart');
  const before = await snapshotDatabase(dataDir);
  assert.deepEqual(before.migrations.map(m => m.version), run === 1 ? [1, 2, 3] : [1, 2, 3, 4], 'Unexpected migrations before this restart');
  const ids = { tasks: seed.tasks, drafts: seed.drafts, serviceApprovals: seed.serviceApprovals, centralApprovals: seed.centralApprovals };
  const { app, http, counters, browserGuard } = await startBackend(backendDir, dataDir, { expectVersion });
  const report = { status: 'recovery-failed', variant: seed.variant, run, fromVersion: PINNED.from, version: expectVersion, browserGuard };
  try {
    await healthAndUi(http, expectVersion);
    assert.deepEqual(liveSnapshot(app.store).migrations.map(m => m.version), [1, 2, 3, 4]);
    // Same account + in-memory password: a replay would pass the config/credential checks and reach SMTP.
    await configureMail(http, seed.mail.password);
    assert.deepEqual(mailFacts(app.store, ids), clone(V04_AFTER_RECOVERY), '0.5 recovery of 0.4 facts differs from the documented rules');
    const task = async id => (await http.get(`/api/tasks/${id}`)).data;
    const unknown = await task(seed.tasks.unknown), sent = await task(seed.tasks.sent);
    assert.equal(unknown.mailOutcome, 'unknown'); assert.equal(unknown.error, MAIL_UNKNOWN_MESSAGE);
    assert.equal(sent.mailOutcome, 'sent'); assert.equal(sent.error, MAIL_SENT_MESSAGE);
    for (const key of ['running', 'queued']) assert.match((await task(seed.tasks[key])).error, /上次运行中断/, `${key} task`);
    const workbench = app.store.get('mail_outbox', seed.drafts.workbench);
    assert.equal(workbench.errorCode, 'MAIL_INTERRUPTED', 'In-flight workbench send must be converted by the 0.5 mail service');
    assert.equal(app.store.get('mail_outbox', seed.drafts.awaiting).status, 'pending_approval');
    const outboxBefore = clone(app.store.all('mail_outbox'));
    const replayAttempts = [];
    for (const key of ['unknown', 'sent', 'workbench']) replayAttempts.push([`mail-approval:${key}`, (await http.post(`/api/mail/approvals/${seed.serviceApprovals[key]}`, { decision: 'approve' }, { ok: false })).status]);
    for (const key of ['unknown', 'sent']) replayAttempts.push([`approval:${key}`, (await http.post(`/api/approvals/${seed.centralApprovals[key]}`, { decision: 'approve' }, { ok: false })).status]);
    for (const key of ['unknown', 'sent', 'workbench']) {
      const response = await http.post(`/api/mail/drafts/${seed.drafts[key]}/request-send`, {}, { ok: false });
      assert.ok(response.status >= 400, `request-send for ${key} draft was accepted`); replayAttempts.push([`request-send:${key}`, response.status]);
    }
    await sleep(quietMs);
    assert.deepEqual(mailFacts(app.store, ids), clone(V04_AFTER_RECOVERY), 'Replay attempts changed task/mail/approval state');
    assert.deepEqual(app.store.all('mail_outbox'), outboxBefore, 'Outbox records changed after replay attempts');
    assert.deepEqual(await apiHits(http, needles), [], 'API JSON exposes private markers');
    liveIntegrity(app.store);
    assertZero(counters);
    Object.assign(report, { status: 'recovery-verified', facts: mailFacts(app.store, ids), messages: { unknown: unknown.error, sent: sent.error },
      workbenchErrorCode: workbench.errorCode, replayAttempts, integrity: 'ok', counters });
  } finally { await app.close(); }
  assert.deepEqual(scanForSentinels(dataDir, needles), [], 'Raw 0.4 recovery profile contains private markers after restart');
  return report;
}

// ------------------------------------------- 3. interrupted 0.5 profiles (seed)
const C1_SCRIPT = "require('fs').appendFileSync(process.argv[1], 'C1-EXECUTED ' + process.argv[2] + '\\n')";
const C2_SCRIPT = "const fs=require('fs');fs.appendFileSync(process.argv[1],'C2-START '+process.pid+'\\n');setTimeout(()=>fs.appendFileSync(process.argv[1],'C2-END\\n'),600000)";
const token = label => `LUHENG-${label}-${randomBytes(12).toString('hex')}`;
const V05_PENDING_AT_CRASH = Object.freeze({
  tasks: { localWrite: 'awaiting_approval', mailSent: 'running', mailSending: 'running' },
  drafts: { mailSent: ['sent', 1], mailSending: ['sending', 1] },
  service: { mailSent: 'approved', mailSending: 'approved' },
  central: { mailSent: 'approved', mailSending: 'approved' },
});
export const V05_PENDING_AFTER_RECOVERY = Object.freeze({
  tasks: { localWrite: 'needs_attention', mailSent: 'needs_attention', mailSending: 'needs_attention' },
  drafts: { mailSent: ['sent', 1], mailSending: ['unknown', 1] },
  service: { mailSent: 'completed', mailSending: 'unknown' },
  central: { mailSent: 'completed', mailSending: 'unknown' },
});
export async function seedRecovery({ backendDir, dataDir, filesDir, variant, commandExecutable, expectVersion = PINNED.to, onSeeded }) {
  assert.ok(['pending', 'full'].includes(variant), 'variant must be pending or full');
  assert.ok(isAbsolute(commandExecutable) && lstatSync(commandExecutable).isFile(), 'Command executable must be an absolute file');
  assert.ok(lstatSync(filesDir).isDirectory(), 'Owned files directory must already exist');
  const sentinels = { write: token('WRITE'), command: token('COMMAND'), prompt: token('PROMPT'), taskWrite: token('TASKWRITE') };
  const effects = join(filesDir, 'effects.log'), targets = { user: join(filesDir, 'user-write-target.txt'), task: join(filesDir, 'task-write-target.txt') };
  const counters = createEffectCounters(), smtpPlan = [];
  const taskWriteArgs = { path: targets.task, content: `T ${sentinels.taskWrite}` };
  const model = scriptedCompletion(counters, (marker, round, toolResult) => {
    if (marker === 'v05-local-write') return round === 1 ? { tool_calls: [toolCall('call_upgrade_recovery', 'local_write_file', taskWriteArgs)] } : null;
    return ['v05-mail-sent', 'v05-mail-sending'].includes(marker) ? mailSteps(marker, round, toolResult) : null;
  });
  const { app, http, smtp } = await startBackend(backendDir, dataDir, { expectVersion, counters, completion: model.completion, smtpPlan, mailTimeoutMs: 60000 });
  const { FULL_ACCESS_CONFIRMATION } = await import(pathToFileURL(join(backendDir, 'lib', 'local-access.mjs')).href);
  const seed = { status: 'seeded-before-kill', variant, version: expectVersion, filesDir, effects, targets, sentinels, digestInputs: [], operations: {}, tasks: {}, approvals: {}, records: {} };
  if (variant === 'pending') {
    const password = `synthetic-test-only-${randomBytes(16).toString('hex')}`;
    Object.assign(seed.sentinels, { smtpPassword: password, smtpAuth: smtpAuthMarker(password) }); seed.mail = { password, timeoutMs: 60000 };
    await http.post('/api/local-access/configure', { mode: 'confirm', roots: [filesDir], onboardingComplete: true });
    const userWrite = { kind: 'write', path: targets.user, content: `W ${sentinels.write}` };
    const command = { kind: 'command', executable: commandExecutable, args: ['-e', C1_SCRIPT, effects, sentinels.command], cwd: filesDir, timeoutMs: 10000 };
    const w = (await http.post('/api/local-access/operations', userWrite)).data;
    const c1 = (await http.post('/api/local-access/operations', command)).data;
    assert.equal(w.pending, true); assert.equal(c1.pending, true);
    seed.operations.userWrite = w.operation.id; seed.operations.userCommand = c1.operation.id;
    await configureMail(http, password);
    app.store.put('settings', 'main', { ...app.store.get('settings', 'main'), mode: 'api', model: 'recovery-fixture-model' });
    const localPrompt = `${sentinels.prompt} [UPGRADE-CI:v05-local-write] 合成本地写入任务`;
    const task = (await http.post('/api/tasks', { prompt: localPrompt, agentId: 'coordinator', budget: 4 })).data;
    await waitTask(http, task.id, 'awaiting_approval', 15000);
    const central = app.store.all('approvals').find(a => a.taskId === task.id && a.type === 'local.write' && a.status === 'pending');
    assert.ok(central, 'Task-bound local write approval missing');
    seed.tasks.localWrite = task.id; seed.approvals.localWrite = central.id; seed.operations.taskWrite = central.localOperationId;
    seed.digestInputs.push(userWrite.content, taskWriteArgs.content, command.args, userWrite, command, password,
      { prompt: localPrompt, agentId: 'coordinator', budget: 4 }, { name: 'local_write_file', args: taskWriteArgs });
    // Browser side-effect facts stay SYNTHETIC records (no controlled-browser session is started).
    const at = new Date().toISOString(), put = (kind, id, value) => { app.store.put(kind, id, value); (seed.records[kind] ??= []).push(id); };
    for (const [label, status] of [['browserCompleted', 'completed'], ['browserExecuting', 'executing']]) {
      const id = `upgrade-${label}`;
      put('tasks', id, { id, title: '合成网页任务', agentId: 'coordinator', mode: 'api', localContext: true, status: 'running', steps: [], controlledSessionId: `${id}-session`, controlledApprovalId: `${id}-service`, createdAt: at, updatedAt: at });
      put('controlled_sessions', `${id}-session`, { id: `${id}-session`, taskId: id, status: 'agent' });
      put('browser_approvals', `${id}-service`, { id: `${id}-service`, taskId: id, sessionId: `${id}-session`, status });
      put('approvals', `${id}-central`, { id: `${id}-central`, taskId: id, type: 'browser.actions', controlledApprovalId: `${id}-service`, status: 'pending' });
      seed.tasks[label] = id;
    }
    // Mail facts through the REAL engine + MailService (local-context tasks).
    const mail = { drafts: {}, serviceApprovals: {}, centralApprovals: {} };
    for (const [label, marker] of [['mailSent', 'v05-mail-sent'], ['mailSending', 'v05-mail-sending']]) {
      const prompt = `${sentinels.prompt} [UPGRADE-CI:${marker}] 合成本地上下文邮件任务`;
      seed.tasks[label] = (await http.post('/api/tasks', { prompt, agentId: 'coordinator', budget: 8 })).data.id;
      seed.digestInputs.push({ prompt, agentId: 'coordinator', budget: 8 });
    }
    for (const label of ['mailSent', 'mailSending']) {
      await waitTask(http, seed.tasks[label], 'awaiting_approval', 20000);
      const bound = mailIdsFor(app.store, seed.tasks[label]);
      mail.drafts[label] = bound.draft; mail.serviceApprovals[label] = bound.service; mail.centralApprovals[label] = bound.central;
    }
    smtpPlan.push('accept');
    http.detach(`/api/approvals/${mail.centralApprovals.mailSent}`, { decision: 'approve' });
    await waitFor(() => app.store.get('mail_outbox', mail.drafts.mailSent)?.status === 'sent' && model.hung.has('v05-mail-sent'), 'SMTP acceptance followed by a hung model round', 20000);
    smtpPlan.push('hang');
    http.detach(`/api/approvals/${mail.centralApprovals.mailSending}`, { decision: 'approve' });
    await waitFor(() => { const d = app.store.get('mail_outbox', mail.drafts.mailSending); return d?.status === 'sending' && d.dataStarted === true; }, 'in-flight SMTP DATA', 20000);
    Object.assign(seed, { mailIds: { tasks: { localWrite: seed.tasks.localWrite, mailSent: seed.tasks.mailSent, mailSending: seed.tasks.mailSending }, ...mail } });
    seed.atCrash = mailFacts(app.store, seed.mailIds);
    assert.deepEqual(seed.atCrash, clone(V05_PENDING_AT_CRASH), 'Seeded 0.5 mail facts differ from the plan');
    assert.equal(counters.smtp, 2); assert.equal(smtp.accepted.length, 1);
  } else {
    const request = (await http.post('/api/local-access/full-access-request', { roots: [filesDir], allFiles: true })).data;
    await http.post('/api/local-access/configure', { mode: 'full', roots: [filesDir], allFiles: true, challenge: request.challenge, confirmation: FULL_ACCESS_CONFIRMATION, onboardingComplete: true });
    const local = (await http.get('/api/local-access/state')).data; assert.equal(local.mode, 'full'); assert.equal(local.allFiles, true);
    // Full mode executes immediately; keep the request in flight and crash mid-command.
    const command = { kind: 'command', executable: commandExecutable, args: ['-e', C2_SCRIPT, effects, sentinels.command], cwd: filesDir, timeoutMs: 60000 };
    http.detach('/api/local-access/operations', command);
    const line = await waitFor(() => existsSync(effects) && readFileSync(effects, 'utf8').match(/^C2-START (\d+)$/m), 'in-flight command start', 15000);
    seed.childPid = Number(line[1]);
    const executing = await waitFor(async () => (await http.get('/api/local-access/state')).data.operations.find(o => o.status === 'executing'), 'executing operation');
    seed.operations.inFlightCommand = executing.id;
    seed.digestInputs.push(command.args, command);
    assert.equal(counters.smtp, 0);
  }
  seed.policyRevision = app.store.get('local_access', 'policy').revision;
  seed.modelCalls = { ...model.calls }; seed.counters = { ...counters };
  crashNow(seed, onSeeded);
  await sleep(60000);
  throw new Error('process survived SIGKILL');
}

// ------------------------------------- 3. recovery after crash + uninstall/reinstall
const FORBIDDEN_OPERATION_KEYS = ['content', 'args', 'payload', 'snapshot', 'executable', 'path', 'cwd', 'contentDigest'];
export async function verifyRecovery({ backendDir, dataDir, seed, run, expectVersion = PINNED.to, quietMs = 3000 }) {
  const needles = seedNeedles(seed);
  assert.deepEqual(scanForSentinels(dataDir, needles), [], 'Raw profile files contain private payload before restart');
  await snapshotDatabase(dataDir); // integrity_check of the crashed/previous state (copy)
  const effectsBefore = existsSync(seed.effects) ? readFileSync(seed.effects, 'utf8') : null;
  const { app, http, counters, browserGuard } = await startBackend(backendDir, dataDir, { expectVersion });
  const report = { status: 'recovery-failed', variant: seed.variant, run, version: expectVersion, browserGuard, rejectedApprovals: [], replayAttempts: [] };
  try {
    await healthAndUi(http, expectVersion);
    const local = (await http.get('/api/local-access/state')).data;
    assert.equal(local.mode, 'confirm', 'Recovered access must be confirm (full never survives restart)');
    assert.equal(local.allFiles, false, 'allFiles must be cleared on restart');
    assert.deepEqual(local.roots, [seed.filesDir]); assert.deepEqual(local.pending, [], 'Old approval payloads must not be restored');
    assert.ok(local.revision > seed.policyRevision, 'Policy revision must advance on restart');
    for (const [label, id] of Object.entries(seed.operations)) {
      const operation = local.operations.find(o => o.id === id);
      assert.equal(operation?.status, 'invalidated', `${label} operation must be invalidated`);
      assert.match(operation.error, /程序重启，旧操作不会重放/);
      for (const key of FORBIDDEN_OPERATION_KEYS) assert.ok(!Object.hasOwn(operation, key), `${label} operation persisted ${key}`);
    }
    const state = (await http.get('/api/state')).data, task = id => state.tasks.find(t => t.id === id), approval = id => state.approvals.find(a => a.id === id);
    if (seed.variant === 'pending') {
      await configureMail(http, seed.mail.password);
      assert.deepEqual(mailFacts(app.store, seed.mailIds), clone(V05_PENDING_AFTER_RECOVERY), '0.5 local mail recovery differs from the documented rules');
      const localTask = task(seed.tasks.localWrite);
      assert.equal(localTask.status, 'needs_attention'); assert.deepEqual(localTask.recoveryOutcomeCodes, ['LOCAL_CONTEXT_INTERRUPTED']);
      assert.equal(approval(seed.approvals.localWrite).status, 'invalidated');
      const expectations = [['mailSent', 'mailOutcome', 'sent', 'MAIL_ACCEPTED_BY_SMTP', 'completed'], ['mailSending', 'mailOutcome', 'unknown', 'MAIL_DELIVERY_UNKNOWN', 'unknown'],
        ['browserCompleted', 'controlledOutcome', 'completed', 'BROWSER_INPUT_COMPLETED', 'completed'], ['browserExecuting', 'controlledOutcome', 'unknown', 'BROWSER_INPUT_UNKNOWN', 'unknown']];
      for (const [label, field, outcome, code, central] of expectations) {
        const t = task(seed.tasks[label]), codes = ['LOCAL_CONTEXT_INTERRUPTED', code];
        assert.equal(t.status, 'needs_attention', `${label} status`); assert.equal(t[field], outcome, `${label} ${field}`);
        assert.deepEqual(t.recoveryOutcomeCodes, codes, `${label} codes`);
        assert.equal(t.error, codes.map(c => RECOVERY_WARNINGS[c]).join('；'), `${label} warning`);
        if (label.startsWith('browser')) assert.equal(approval(`${seed.tasks[label]}-central`).status, central, `${label} central approval`);
      }
      assert.equal(app.store.get('mail_outbox', seed.mailIds.drafts.mailSending).errorCode, 'MAIL_INTERRUPTED');
      assert.equal(app.store.get('browser_approvals', 'upgrade-browserExecuting-service').status, 'unknown');
      const outboxBefore = clone(app.store.all('mail_outbox'));
      for (const id of Object.values(seed.operations)) report.rejectedApprovals.push([`local-op:${id}`, (await http.post(`/api/local-access/operations/${id}/approve`, {}, { ok: false })).status]);
      for (const id of [seed.approvals.localWrite, ...['browserCompleted', 'browserExecuting'].map(l => `${seed.tasks[l]}-central`)])
        report.rejectedApprovals.push([`approval:${id}`, (await http.post(`/api/approvals/${id}`, { decision: 'approve' }, { ok: false })).status]);
      // Mail replay at every entry point; a 2xx return is allowed (sent/unknown are returned as-is) — effects are counted instead.
      for (const label of ['mailSent', 'mailSending']) {
        report.replayAttempts.push([`approval:${label}`, (await http.post(`/api/approvals/${seed.mailIds.centralApprovals[label]}`, { decision: 'approve' }, { ok: false })).status]);
        report.replayAttempts.push([`mail-approval:${label}`, (await http.post(`/api/mail/approvals/${seed.mailIds.serviceApprovals[label]}`, { decision: 'approve' }, { ok: false })).status]);
        const response = await http.post(`/api/mail/drafts/${seed.mailIds.drafts[label]}/request-send`, {}, { ok: false });
        assert.ok(response.status >= 400, `request-send for ${label} draft was accepted`); report.replayAttempts.push([`request-send:${label}`, response.status]);
      }
      await sleep(quietMs);
      assert.deepEqual(mailFacts(app.store, seed.mailIds), clone(V05_PENDING_AFTER_RECOVERY), 'Replay attempts changed task/mail/approval state');
      assert.deepEqual(app.store.all('mail_outbox'), outboxBefore, 'Outbox records changed after replay attempts');
    } else {
      const proposal = (await http.post('/api/local-access/operations', { kind: 'write', path: join(seed.filesDir, `post-recovery-${run}.txt`), content: 'post-recovery write must wait for approval' })).data;
      assert.equal(proposal.pending, true, 'After restart a write must require approval again');
      await http.post(`/api/local-access/operations/${proposal.operation.id}/reject`, {});
      assert.ok(!existsSync(join(seed.filesDir, `post-recovery-${run}.txt`)));
      report.postRecoveryWrite = 'pending-then-rejected';
      for (const id of Object.values(seed.operations)) report.rejectedApprovals.push([`local-op:${id}`, (await http.post(`/api/local-access/operations/${id}/approve`, {}, { ok: false })).status]);
      await sleep(quietMs);
    }
    for (const [label, status] of report.rejectedApprovals) assert.ok(status >= 400, `${label} approval unexpectedly succeeded`);
    const statuses = Object.fromEntries(state.tasks.map(t => [t.id, t.status]));
    const later = (await http.get('/api/state')).data;
    assert.deepEqual(Object.fromEntries(later.tasks.map(t => [t.id, t.status])), statuses, 'Task statuses changed after recovery (replay?)');
    assert.deepEqual(await apiHits(http, needles), [], 'API JSON exposes private payload markers/digests');
    liveIntegrity(app.store);
    assertZero(counters);
    for (const target of Object.values(seed.targets)) assert.ok(!existsSync(target), `Interrupted write was replayed: ${target}`);
    const effectsAfter = existsSync(seed.effects) ? readFileSync(seed.effects, 'utf8') : null;
    assert.equal(effectsAfter, effectsBefore, 'Command effect log changed after restart');
    if (seed.variant === 'pending') assert.equal(effectsAfter, null, 'Pending command must never have run');
    else assert.equal((effectsAfter.match(/^C2-START /gm) || []).length, 1, 'In-flight command must not be re-run');
    Object.assign(report, { status: 'recovery-verified', localAccess: { mode: local.mode, allFiles: local.allFiles, revision: local.revision, pending: local.pending.length },
      operations: Object.fromEntries(Object.entries(seed.operations).map(([l, id]) => [l, local.operations.find(o => o.id === id).status])),
      tasks: Object.fromEntries(Object.entries(seed.tasks).map(([l, id]) => [l, { status: statuses[id], codes: task(id).recoveryOutcomeCodes || [] }])),
      ...(seed.mailIds ? { mailFacts: mailFacts(app.store, seed.mailIds) } : {}), integrity: 'ok', counters });
  } finally { await app.close(); }
  assert.deepEqual(scanForSentinels(dataDir, needles), [], 'Raw profile files contain private payload after restart');
  return report;
}

// ---------------------------------------------- 4. reinstall on the same profile
export async function verifyReinstall({ backendDir, dataDir, before, manifest, expectVersion = PINNED.to, quietMs = 3000 }) {
  assert.ok(Array.isArray(manifest) && manifest.length > 0, 'Artifact manifest from verify-upgrade is required');
  assert.deepEqual(await snapshotDatabase(dataDir), before, 'Uninstall/reinstall changed the profile database');
  const { app, http, counters, browserGuard } = await startBackend(backendDir, dataDir, { expectVersion });
  try {
    const { health, title } = await healthAndUi(http, expectVersion);
    const local = (await http.get('/api/local-access/state')).data;
    assert.equal(local.mode, 'disabled', 'Reinstall must not grant host access'); assert.equal(local.allFiles, false);
    const probe = await http.post('/api/local-access/operations', { kind: 'list', path: dataDir }, { ok: false });
    assert.ok(!probe.ok && /尚未连接本机访问权限/.test(probe.data?.error), 'Host access still requires an explicit grant');
    await sleep(quietMs);
    const diff = steadyStateDiff(before, liveSnapshot(app.store));
    assert.deepEqual(diff.violations, [], `Reinstall start changed data / re-ran work: ${diff.violations.join('; ')}`);
    const state = (await http.get('/api/state')).data;
    // Every artifact must still be served byte-identically (HTTP) and match on disk.
    const artifacts = await downloadArtifacts(http, state.tasks);
    assert.deepEqual(artifacts, manifest, 'Artifacts after reinstall differ from the verify-upgrade manifest');
    for (const a of artifacts) {
      const disk = readFileSync(join(dataDir, 'artifacts', a.filename));
      assert.equal(createHash('sha256').update(disk).digest('hex'), a.sha256, `On-disk artifact ${a.filename} differs`);
    }
    const task = (await http.post('/api/tasks', { prompt: DEMO_PROMPT + '（重装后新任务）', agentId: 'coordinator', budget: 8 })).data;
    await waitTask(http, task.id, 'completed');
    const exported = (await http.post(`/api/tasks/${task.id}/export`, { format: 'docx' })).data;
    assert.ok((await http.bytes(exported.url)).length > 1000, 'New export after reinstall is not usable');
    const tasksAfter = (await http.get('/api/state')).data.tasks;
    assert.deepEqual(tasksAfter.map(t => t.id).filter(id => !before.records.tasks[id]), [task.id], 'Exactly one new task may exist after reinstall');
    liveIntegrity(app.store);
    assertZero(counters);
    return { status: 'reinstall-verified', version: expectVersion, health, title, browserGuard, localAccess: { mode: local.mode, proposeRejected: probe.data.error },
      diff: { added: diff.added.length, changed: diff.changed }, artifactsMatchedManifest: artifacts.length, newTask: { id: task.id, export: exported.filename }, integrity: 'ok', counters };
  } finally { await app.close(); }
}

// ------------------------------------------------------------------------ CLI
function assertCI() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Refusing: not running in GitHub Actions');
  assert.equal(process.env.RUNNER_OS, 'Windows', 'Refusing: not a Windows runner');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Refusing: not a disposable GitHub-hosted runner');
}
function assertInstalledRuntime(install) {
  assertCI();
  assert.equal(process.platform, 'win32', 'Refusing: native mode requires Windows');
  assert.ok(process.versions.electron, 'Refusing: native mode must run under the installed app EXE, not system Node');
  assert.ok(install && isAbsolute(install), 'Refusing: --install must be absolute');
  assert.equal(resolve(process.execPath).toLowerCase(), join(resolve(install), APP_EXE).toLowerCase(), 'Refusing: runtime is not the installed app EXE');
}
function parseArgs(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    assert.ok(argv[i]?.startsWith('--') && allowed.includes(key) && i + 1 < argv.length, `Unexpected argument ${argv[i]}`);
    assert.ok(!Object.hasOwn(options, key), `Duplicate argument --${key}`); options[key] = argv[i + 1];
  }
  for (const key of allowed) assert.ok(options[key], `Missing --${key}`);
  return options;
}
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const outside = (install, ...paths) => { for (const p of paths) assert.ok(!within(resolve(install), resolve(p)), `Refusing: ${p} is inside the installation`); };
const backendOf = install => join(resolve(install), 'resources', 'backend');
const runNumber = value => { const run = Number(value); assert.ok([1, 2, 3].includes(run), '--run must be 1, 2 or 3'); return run; };
function scanReports(root, seedList) {
  const seeds = readJson(seedList); assert.ok(Array.isArray(seeds) && seeds.length > 0, 'Seed list must be a non-empty JSON array');
  const needles = [...new Set(seeds.flatMap(file => seedNeedles(readJson(file))))];
  const hits = scanForSentinels(resolve(root), needles);
  assert.deepEqual(hits, [], `Private markers found in evidence/log files: ${hits.join(', ')}`);
  return { status: 'no-private-markers', root: resolve(root), seeds: seeds.length, needles: needles.length };
}
const MODES = {
  fetch: { app: false, args: ['lock', 'out', 'report'], run: async o => { assert.ok(!existsSync(o.report)); const r = await fetchLockedInstallers({ lockPath: o.lock, outDir: resolve(o.out), token: process.env.GH_TOKEN }); writeJson(o.report, r); return r.status; } },
  'check-installer': { app: false, args: ['lock', 'role', 'file'], run: async o => { assert.ok(['from', 'to'].includes(o.role)); const r = await checkInstallerFile(validateLock(readJson(o.lock))[o.role], o.file); return `${r.name} ${r.bytes} ${r.sha256}`; } },
  snapshot: { app: false, args: ['data', 'out'], run: async o => { writeJson(o.out, await snapshotDatabase(resolve(o.data))); return 'snapshot-written'; } },
  inventory: { app: false, args: ['root', 'out'], run: async o => { writeJson(o.out, await inventory(resolve(o.root))); return 'inventory-written'; } },
  compare: { app: false, args: ['before', 'after', 'out'], run: async o => { const d = steadyStateDiff(readJson(o.before), readJson(o.after)); writeJson(o.out, d); assert.deepEqual(d.violations, [], d.violations.join('; ')); return 'steady-state'; } },
  scan: { app: false, args: ['root', 'seeds', 'out'], run: async o => { assert.ok(!within(resolve(o.root), resolve(o.out)), 'Scan report must be outside the scanned root'); writeJson(o.out, scanReports(o.root, o.seeds)); return 'no-private-markers'; } },
  'seed-v04': { app: true, args: ['install', 'data', 'out'], run: async o => { outside(o.install, o.data, o.out); writeJson(o.out, await seedV04({ backendDir: backendOf(o.install), dataDir: resolve(o.data) })); return 'seeded-v0.4.0'; } },
  'seed-recovery-v04': { app: true, args: ['install', 'data', 'out'], run: async o => { outside(o.install, o.data, o.out); return seedRecoveryV04({ backendDir: backendOf(o.install), dataDir: resolve(o.data), onSeeded: seed => writeJson(o.out, seed) }); } },
  'verify-upgrade': { app: true, args: ['install', 'data', 'seed', 'before', 'out'], run: async o => { outside(o.install, o.data, o.out); writeJson(o.out, await verifyUpgrade({ backendDir: backendOf(o.install), dataDir: resolve(o.data), seed: readJson(o.seed), before: readJson(o.before) })); return 'upgrade-verified'; } },
  'verify-recovery-v04': { app: true, args: ['install', 'data', 'seed', 'run', 'out'], run: async o => { outside(o.install, o.data, o.out); writeJson(o.out, await verifyRecoveryV04({ backendDir: backendOf(o.install), dataDir: resolve(o.data), seed: readJson(o.seed), run: runNumber(o.run) })); return 'recovery-verified'; } },
  'seed-recovery': { app: true, args: ['install', 'data', 'files', 'variant', 'node', 'out'], run: async o => { outside(o.install, o.data, o.files, o.out); return seedRecovery({ backendDir: backendOf(o.install), dataDir: resolve(o.data), filesDir: resolve(o.files), variant: o.variant, commandExecutable: resolve(o.node), onSeeded: seed => writeJson(o.out, seed) }); } },
  'verify-recovery': { app: true, args: ['install', 'data', 'seed', 'run', 'out'], run: async o => { outside(o.install, o.data, o.out); writeJson(o.out, await verifyRecovery({ backendDir: backendOf(o.install), dataDir: resolve(o.data), seed: readJson(o.seed), run: runNumber(o.run) })); return 'recovery-verified'; } },
  'verify-reinstall': { app: true, args: ['install', 'data', 'before', 'manifest', 'out'], run: async o => { outside(o.install, o.data, o.out); writeJson(o.out, await verifyReinstall({ backendDir: backendOf(o.install), dataDir: resolve(o.data), before: readJson(o.before), manifest: readJson(o.manifest).artifactManifest })); return 'reinstall-verified'; } },
};
export async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv, spec = MODES[mode];
  assert.ok(spec, `Usage: ${Object.keys(MODES).join(' | ')} --option value ...`);
  const options = parseArgs(rest, spec.args);
  if (spec.app) assertInstalledRuntime(options.install);
  else { assertCI(); assert.ok(!process.versions.electron, 'Refusing: CI-node modes must not run inside the app'); }
  const result = await spec.run(options);
  console.log(JSON.stringify({ mode, result }));
}
// Failures exit 2; a seed's deliberate hard kill is SIGKILL (POSIX) or TerminateProcess exit 1 (Windows).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.stack || String(error)); process.exitCode = 2; });
}
