import { createHash } from 'node:crypto';

// Only this module and the desktop utility-process bridge handle the cleartext
// snapshot. The HTTP renderer never receives it; the application database stores
// connection metadata, never this bundle. Exact bindings prevent restore after a
// connection/identity change, even if two roles use the same provider.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = (kind, id, config) => digest([kind, id, config]);
const modelFields = c => [c?.endpoint || '', c?.model || ''];
const mailFields = (account, protocol) => {
  const c = account?.[protocol];
  return c ? [account.from, c.host, c.port, c.secure, c.user] : null;
};

const plainObject = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exactKeys = (x, keys) => plainObject(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
export function validateCredentialBundle(bundle) {
  if (!exactKeys(bundle, ['version', 'entries']) || bundle.version !== 1 || !Array.isArray(bundle.entries) || bundle.entries.length > 100 || Buffer.byteLength(JSON.stringify(bundle)) > 65536)
    throw new Error('已保存凭据格式无效');
  const seen = new Set();
  for (const e of bundle.entries) {
    if (!exactKeys(e, ['kind', 'id', 'configDigest', 'secret']) || !['global','role','mail'].includes(e.kind) || typeof e.id !== 'string' || !/^[A-Za-z0-9_:-]{1,180}$/.test(e.id) || (e.kind === 'global' && e.id !== 'main') || typeof e.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(e.configDigest) || typeof e.secret !== 'string' || !e.secret || Buffer.byteLength(e.secret) > 2000)
      throw new Error('已保存凭据格式无效');
    const key = e.kind + ':' + e.id;
    if (seen.has(key)) throw new Error('已保存凭据标识重复');
    seen.add(key);
  }
  return bundle;
}

export class CredentialSnapshots {
  constructor({ store, roleKeys, mail, getGlobal, setGlobal }) {
    Object.assign(this, { store, roleKeys, mail, getGlobal, setGlobal });
  }
  capture() {
    const entries = [];
    const add = (kind, id, config, secret) => {
      if (secret) entries.push({ kind, id, configDigest: binding(kind, id, config), secret });
    };
    const main = this.store.get('settings', 'main');
    add('global', 'main', modelFields(main), this.getGlobal(main.endpoint));
    for (const agent of this.store.all('agents')) {
      if (agent.modelConfig?.inherit === false)
        add('role', agent.id, modelFields(agent.modelConfig), this.roleKeys.get(agent.modelConfig.endpoint, agent.id));
    }
    for (const account of this.store.all('mail_accounts')) {
      for (const protocol of ['imap', 'smtp']) {
        if (account[protocol]) add('mail', account.accountId + ':' + protocol, mailFields(account, protocol), this.mail.credentials.get(account.accountId)?.[protocol]?.password);
      }
    }
    return validateCredentialBundle({ version: 1, entries });
  }
  restore(bundle) {
    validateCredentialBundle(bundle);
    let restored = 0, skipped = 0;
    for (const e of bundle.entries) {
      let config, apply;
      if (e.kind === 'global' && e.id === 'main') {
        const main = this.store.get('settings', 'main');
        config = modelFields(main);
        apply = () => this.setGlobal(e.secret, main.endpoint);
      } else if (e.kind === 'role') {
        const agent = this.store.get('agents', e.id);
        if (agent?.modelConfig?.inherit === false) {
          config = modelFields(agent.modelConfig);
          apply = () => this.roleKeys.set(e.id, agent.modelConfig.endpoint, e.secret);
        }
      } else if (e.kind === 'mail') {
        const match = e.id.match(/^([A-Za-z0-9_-]+):(imap|smtp)$/);
        const account = match && this.store.get('mail_accounts', match[1]);
        const protocol = match?.[2];
        if (account?.[protocol]) {
          config = mailFields(account, protocol);
          apply = () => {
            const old = this.mail.credentials.get(account.accountId) || {};
            this.mail.credentials.set(account.accountId, { ...old, [protocol]: { user: account[protocol].user, password: e.secret } });
          };
        }
      }
      if (apply && binding(e.kind, e.id, config) === e.configDigest) { apply(); restored++; }
      else skipped++;
    }
    return { restored, skipped };
  }
}
