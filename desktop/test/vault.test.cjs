'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync, chmodSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SecretVault, validateBundle } = require('../vault.cjs');

// All secrets in this suite are synthetic. This fixture exercises authenticated
// encryption and the vault contract; it is not a substitute for OS-keyring tests.
const SYNTHETIC_SECRET = 'synthetic-vault-fixture-never-a-real-credential-7f840c';
const DIGEST = 'a'.repeat(64);
const MAGIC = Buffer.from('LUHENG-VAULT-v1\n');

function bundle(entries = [
  { kind: 'global', id: 'main', configDigest: DIGEST, secret: SYNTHETIC_SECRET },
  { kind: 'role', id: 'fixture-agent', configDigest: 'b'.repeat(64), secret: 'synthetic-role-secret' },
  { kind: 'mail', id: 'fixture-account:imap', configDigest: 'c'.repeat(64), secret: 'synthetic-imap-secret' },
]) {
  return { version: 1, entries };
}

function entry(overrides = {}) {
  return { kind: 'role', id: 'fixture-agent', configDigest: DIGEST, secret: SYNTHETIC_SECRET, ...overrides };
}

function safeStorageFixture({ available = true, backend = 'gnome_libsecret' } = {}) {
  const key = randomBytes(32);
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      calls.encrypt++;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      calls.decrypt++;
      const bytes = Buffer.from(value);
      if (bytes.length < 28) throw new Error('Fixture ciphertext is truncated');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function fixture(t, options = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'highway-vault-test-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const safeStorage = options.safeStorage || safeStorageFixture(options);
  const vault = new SecretVault({ safeStorage, stateRoot, platform: 'linux' });
  return { vault, safeStorage, stateRoot, file: join(stateRoot, 'credentials.vault') };
}

function assertPublicStatus(status, secrets = [SYNTHETIC_SECRET]) {
  assert.equal(typeof status.available, 'boolean');
  assert.equal(typeof status.stored, 'boolean');
  assert.equal(typeof status.backend, 'string');
  assert.ok(Object.keys(status).every(key => ['available', 'backend', 'stored', 'reason'].includes(key)));
  const serialized = JSON.stringify(status);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), 'public status must not contain a secret');
}

async function assertRejectedWithoutSecret(action, secrets = [SYNTHETIC_SECRET]) {
  await assert.rejects(async () => action(), error => {
    const exposed = `${String(error)}\n${error.stack || ''}\n${JSON.stringify(error)}`;
    for (const secret of secrets) assert.ok(!exposed.includes(secret), 'failure must not expose a secret');
    return true;
  });
}

async function assertClosedLoad(vault, secrets = [SYNTHETIC_SECRET]) {
  let result;
  try {
    result = await vault.load();
  } catch (error) {
    const exposed = `${String(error)}\n${error.stack || ''}\n${JSON.stringify(error)}`;
    for (const secret of secrets) assert.ok(!exposed.includes(secret), 'load failure must not expose a secret');
    return;
  }
  assert.equal(result, null, 'a failed load must not return malformed or partial credentials');
}

test('vault securely round-trips all credential kinds, including after reconstruction', async t => {
  const { vault, safeStorage, stateRoot, file } = fixture(t);
  const original = bundle();
  const initial = await vault.status();
  assertPublicStatus(initial);
  assert.equal(initial.available, true);
  assert.equal(initial.stored, false);
  assert.equal(await vault.load(), null);

  const saved = await vault.save(original);
  assertPublicStatus(saved, original.entries.map(item => item.secret));
  assert.equal(saved.available, true);
  assert.equal(saved.stored, true);
  assert.ok(safeStorage.calls.encrypt > 0);
  assert.deepEqual(await vault.load(), original);

  const reopened = new SecretVault({ safeStorage, stateRoot, platform: 'linux' });
  assert.deepEqual(await reopened.load(), original);
  assertPublicStatus(await reopened.status(), original.entries.map(item => item.secret));

  const raw = readFileSync(file);
  for (const item of original.entries) {
    assert.equal(raw.includes(Buffer.from(item.secret)), false, 'ciphertext must not contain raw credentials');
  }
  assert.notEqual(raw.toString('utf8'), JSON.stringify(original));
  assert.deepEqual(readdirSync(stateRoot), ['credentials.vault'], 'successful save must leave no plaintext or temporary files');
});

test('vault writes owner-only credentials on Linux', { skip: process.platform === 'win32' }, async t => {
  const { vault, file } = fixture(t);
  await vault.save(bundle());
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  await vault.save(bundle([entry({ secret: 'synthetic-replacement-secret' })]));
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
});

for (const [label, options] of [
  ['plaintext basic_text backend', { backend: 'basic_text' }],
  ['unknown backend', { backend: 'unknown' }],
  ['unrecognized backend', { backend: 'fixture-untrusted-backend' }],
  ['unavailable OS encryption', { available: false }],
]) {
  test(`vault refuses ${label}`, async t => {
    const { vault, safeStorage, file } = fixture(t, options);
    const status = await vault.status();
    assertPublicStatus(status);
    assert.equal(status.available, false);
    assert.equal(status.stored, false);
    await assertRejectedWithoutSecret(() => vault.save(bundle()));
    assert.equal(existsSync(file), false);
    assert.equal(safeStorage.calls.encrypt, 0);
    await assertClosedLoad(vault);
    assert.equal(safeStorage.calls.decrypt, 0);
  });

  test(`vault will not decrypt existing credentials with ${label}`, async t => {
    const { vault, safeStorage, file } = fixture(t, options);
    const ciphertext = safeStorageFixture().encryptString(JSON.stringify(bundle()));
    writeFileSync(file, ciphertext, { mode: 0o600 });
    await assertRejectedWithoutSecret(() => vault.load());
    assert.equal(safeStorage.calls.decrypt, 0);
    assert.deepEqual(readFileSync(file), ciphertext, 'unavailable keyring must not damage existing encrypted credentials');
    assertPublicStatus(await vault.status());
  });
}

test('vault fails closed when an existing ciphertext is modified', async t => {
  const { vault, file } = fixture(t);
  await vault.save(bundle());
  const ciphertext = readFileSync(file);
  ciphertext[ciphertext.length - 1] ^= 0x01;
  writeFileSync(file, ciphertext, { mode: 0o600 });
  await assertClosedLoad(vault);
  assertPublicStatus(await vault.status());
});

test('vault fails closed for truncated and empty ciphertext', async t => {
  const { vault, file } = fixture(t);
  for (const ciphertext of [Buffer.from('fixture-truncated'), Buffer.alloc(0)]) {
    writeFileSync(file, ciphertext, { mode: 0o600 });
    await assertClosedLoad(vault);
    assertPublicStatus(await vault.status());
  }
});

test('vault validates authenticated plaintext before returning credentials', async t => {
  const { vault, safeStorage, file } = fixture(t);
  for (const plaintext of [
    `not-json-${SYNTHETIC_SECRET}`,
    JSON.stringify({ ...bundle(), unexpected: SYNTHETIC_SECRET }),
    JSON.stringify(bundle([entry({ configDigest: 'invalid-digest' })])),
  ]) {
    writeFileSync(file, Buffer.concat([MAGIC, safeStorage.encryptString(plaintext)]), { mode: 0o600 });
    await assertClosedLoad(vault);
    assertPublicStatus(await vault.status());
  }
  assert.equal(safeStorage.calls.decrypt, 3, 'authenticated plaintext cases must reach the schema validator');
});

test('vault refuses a ciphertext encrypted with a different key', async t => {
  const { vault, file, safeStorage } = fixture(t);
  writeFileSync(file, Buffer.concat([MAGIC, safeStorageFixture().encryptString(JSON.stringify(bundle()))]), { mode: 0o600 });
  await assertClosedLoad(vault);
  assert.equal(safeStorage.calls.decrypt, 1);
  assertPublicStatus(await vault.status());
});

test('forget removes saved credentials and is safe to repeat', async t => {
  const { vault, file } = fixture(t);
  await vault.save(bundle());
  const result = await vault.forget();
  assertPublicStatus(result);
  assert.equal(result.stored, false);
  assert.equal(existsSync(file), false);
  assert.equal(await vault.load(), null);
  const repeated = await vault.forget();
  assertPublicStatus(repeated);
  assert.equal(repeated.stored, false);
});

test('validateBundle accepts the complete schema and empty entry list', () => {
  assert.doesNotThrow(() => validateBundle(bundle()));
  assert.doesNotThrow(() => validateBundle(bundle([])));
  assert.doesNotThrow(() => validateBundle(bundle([
    entry({ kind: 'global', id: 'main' }),
    entry({ kind: 'role', id: 'main' }),
    entry({ kind: 'role', id: 'fixture_agent_01' }),
  ])));
});

test('validateBundle rejects malformed records and any extra record keys', () => {
  const malformed = [
    null, undefined, [], 'fixture', 1,
    {}, { version: 2, entries: [] }, { version: '1', entries: [] },
    { version: 1 }, { version: 1, entries: null }, { version: 1, entries: {} },
    { ...bundle(), extra: true },
    bundle([null]), bundle([[]]), bundle(['fixture']),
    bundle([entry({ extra: true })]),
    bundle([entry({ kind: 'other' })]),
    bundle([entry({ id: '' })]), bundle([entry({ id: 123 })]),
    bundle([entry({ configDigest: 'a'.repeat(63) })]),
    bundle([entry({ configDigest: 'a'.repeat(65) })]),
    bundle([entry({ configDigest: 'A'.repeat(64) })]),
    bundle([entry({ configDigest: 'g'.repeat(64) })]),
    bundle([entry({ configDigest: 123 })]),
    bundle([entry({ secret: 123 })]), bundle([entry({ secret: null })]),
  ];
  for (const key of ['kind', 'id', 'configDigest', 'secret']) {
    const missing = entry();
    delete missing[key];
    malformed.push(bundle([missing]));
  }
  for (const value of malformed) assert.throws(() => validateBundle(value));
});

test('validateBundle rejects duplicate kind and id pairs', () => {
  assert.throws(() => validateBundle(bundle([
    entry(), entry({ configDigest: 'b'.repeat(64), secret: 'synthetic-other-secret' }),
  ])));
});

test('validateBundle enforces the 100-entry limit', () => {
  const entries = Array.from({ length: 100 }, (_, index) => entry({ id: `fixture-agent-${index}`, secret: 'fixture' }));
  assert.doesNotThrow(() => validateBundle(bundle(entries)));
  assert.throws(() => validateBundle(bundle([...entries, entry({ id: 'fixture-agent-100', secret: 'fixture' })])));
});

test('validateBundle enforces the individual secret size limit', () => {
  assert.doesNotThrow(() => validateBundle(bundle([entry({ secret: 'x'.repeat(2000) })])));
  assert.throws(() => validateBundle(bundle([entry({ secret: 'x'.repeat(2001) })])));
  assert.doesNotThrow(() => validateBundle(bundle([entry({ secret: '😀'.repeat(500) })])));
  assert.throws(() => validateBundle(bundle([entry({ secret: '😀'.repeat(501) })])));
});

test('validateBundle enforces the 64 KiB serialized UTF-8 bundle limit', () => {
  const tooLarge = bundle(Array.from({ length: 40 }, (_, index) => entry({
    id: `fixture-agent-${index}`, secret: 'x'.repeat(2000),
  })));
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge), 'utf8') > 64 * 1024);
  assert.throws(() => validateBundle(tooLarge));

  // These secrets fit the individual UTF-8 bound. The full record still exceeds
  // the total byte limit, even though its JavaScript string length is smaller.
  const multibyte = bundle(Array.from({ length: 40 }, (_, index) => entry({
    id: `fixture-agent-${index}`, secret: '😀'.repeat(500),
  })));
  assert.ok(JSON.stringify(multibyte).length < 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(multibyte), 'utf8') > 64 * 1024);
  assert.throws(() => validateBundle(multibyte));
});

test('invalid save cannot replace an existing valid encrypted bundle', async t => {
  const { vault, safeStorage, file } = fixture(t);
  const original = bundle();
  await vault.save(original);
  const ciphertext = readFileSync(file);
  const encryptedBefore = safeStorage.calls.encrypt;
  await assertRejectedWithoutSecret(() => vault.save(bundle([entry({ extra: SYNTHETIC_SECRET })])));
  assert.equal(safeStorage.calls.encrypt, encryptedBefore, 'invalid records must be rejected before encryption');
  assert.deepEqual(readFileSync(file), ciphertext);
  assert.deepEqual(await vault.load(), original);
});

test('vault refuses a symbolic link in place of its credentials file', { skip: process.platform === 'win32' }, async t => {
  const { vault, stateRoot, file } = fixture(t);
  const target = join(stateRoot, 'fixture-symlink-target');
  const sentinel = 'synthetic-target-must-remain-unchanged';
  writeFileSync(target, sentinel, { mode: 0o600 });
  symlinkSync(target, file);
  await assertClosedLoad(vault);
  await assertRejectedWithoutSecret(() => vault.save(bundle()));
  assert.equal(readFileSync(target, 'utf8'), sentinel);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
});

test('vault refuses unsafe file permissions and oversized ciphertext before decryption', { skip: process.platform === 'win32' }, async t => {
  const { vault, safeStorage, file } = fixture(t);
  vault.save(bundle()); chmodSync(file, 0o644);
  await assertClosedLoad(vault); assert.equal(safeStorage.calls.decrypt, 0);
  chmodSync(file, 0o600); writeFileSync(file, Buffer.alloc(131073));
  await assertClosedLoad(vault); assert.equal(safeStorage.calls.decrypt, 0);
});
