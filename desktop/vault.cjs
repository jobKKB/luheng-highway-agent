'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const MAGIC = Buffer.from('LUHENG-VAULT-v1\n');
const MAX_BUNDLE_BYTES = 65536;
const MAX_FILE_BYTES = 131072;
const secureLinuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const plainObject = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exactKeys = (x, keys) => plainObject(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));

function validateBundle(bundle) {
  const invalid = () => { throw new Error('凭据快照格式或大小不符合要求。'); };
  if (!exactKeys(bundle, ['version', 'entries']) || bundle.version !== 1 || !Array.isArray(bundle.entries) || bundle.entries.length > 100) invalid();
  const ids = new Set();
  for (const entry of bundle.entries) {
    if (!exactKeys(entry, ['kind', 'id', 'configDigest', 'secret']) || !['global', 'role', 'mail'].includes(entry.kind)
        || typeof entry.id !== 'string' || !/^[A-Za-z0-9_:-]{1,180}$/.test(entry.id)
        || (entry.kind === 'global' && entry.id !== 'main')
        || typeof entry.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.configDigest)
        || typeof entry.secret !== 'string' || !entry.secret.length || entry.secret.length > 2000 || Buffer.byteLength(entry.secret) > 2000) invalid();
    const id = `${entry.kind}:${entry.id}`;
    if (ids.has(id)) invalid();
    ids.add(id);
  }
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) invalid();
  return bundle;
}

class SecretVault {
  constructor({ safeStorage, stateRoot, platform = process.platform }) {
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.file = path.join(stateRoot, 'credentials.vault');
    this.stateRoot = stateRoot;
  }
  availability() {
    let backend = this.platform === 'win32' ? 'dpapi' : this.platform === 'darwin' ? 'keychain' : 'unknown';
    try {
      if (this.platform === 'linux') backend = this.safeStorage.getSelectedStorageBackend();
      const available = this.safeStorage.isEncryptionAvailable() && (this.platform !== 'linux' || secureLinuxBackends.has(backend));
      return { available, backend, ...(available ? {} : { reason: '当前系统没有可用的安全密钥库；凭据仅保留在运行内存中，不会用明文回退保存。' }) };
    } catch {
      return { available: false, backend: 'unknown', reason: '无法访问系统安全密钥库；未启用本地凭据保存。' };
    }
  }
  status() {
    let stored = false;
    try { stored = fs.lstatSync(this.file).isFile(); } catch (error) { if (error.code !== 'ENOENT') return { ...this.availability(), stored: false, reason: '无法检查已保存的凭据文件。' }; }
    return { ...this.availability(), stored };
  }
  assertSecure() {
    if (!this.availability().available) throw new Error('系统安全密钥库不可用，不能保存或恢复凭据。');
  }
  assertFile() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('invalid');
      return stat;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('凭据文件不安全或已损坏；未读取其内容。');
    }
  }
  save(bundle) {
    validateBundle(bundle);
    this.assertSecure();
    this.assertFile();
    let encrypted;
    try { encrypted = this.safeStorage.encryptString(JSON.stringify(bundle)); }
    catch { throw new Error('系统安全密钥库加密失败；未保存凭据。'); }
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length + MAGIC.length > MAX_FILE_BYTES) throw new Error('系统安全密钥库返回了无效数据；未保存凭据。');
    const temp = path.join(this.stateRoot, `.credentials-${randomBytes(16).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, Buffer.concat([MAGIC, encrypted])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.assertFile();
      fs.renameSync(temp, this.file);
    } catch {
      throw new Error('加密凭据文件保存失败；请检查本地数据目录。');
    } finally {
      try { fs.unlinkSync(temp); } catch {}
      encrypted.fill(0);
    }
    return this.status();
  }
  load() {
    if (!this.assertFile()) return null;
    this.assertSecure();
    let bytes;
    try {
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (this.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('invalid');
        bytes = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
      if (bytes.length <= MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid');
      const text = this.safeStorage.decryptString(bytes.subarray(MAGIC.length));
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BUNDLE_BYTES) throw new Error('invalid');
      return validateBundle(JSON.parse(text));
    } catch {
      throw new Error('已保存的凭据无法安全恢复，可能已损坏或不属于当前系统用户；请重新录入或忘记已保存凭据。');
    } finally { bytes?.fill(0); }
  }
  forget() {
    this.assertFile();
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw new Error('未能删除已保存的凭据文件。'); }
    return this.status();
  }
}

module.exports = { SecretVault, validateBundle, exactKeys, MAX_BUNDLE_BYTES };
