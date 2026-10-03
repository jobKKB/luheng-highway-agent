import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicAddress } from '../lib/public-ip.mjs';
import { ControlledBrowserService, isPublicBrowserAddress } from '../lib/controlled-browser.mjs';
import { callCompletion, validateEndpoint } from '../lib/model.mjs';
import { MailService } from '../lib/mail-adapter.mjs';
import { Store } from '../lib/store.mjs';

const blockedIPv4 = [
  '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
  '100.64.0.0', '100.127.255.255', '127.0.0.0', '127.255.255.255',
  '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255',
  '192.0.0.0', '192.0.0.255', '192.0.2.0', '192.0.2.255',
  '192.88.99.0', '192.88.99.255', '192.168.0.0', '192.168.255.255',
  '198.18.0.0', '198.19.255.255', '198.51.100.0', '198.51.100.255',
  '203.0.113.0', '203.0.113.255', '224.0.0.0', '239.255.255.255',
  '240.0.0.0', '255.255.255.255',
];
const blockedIPv6 = [
  '::', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001',
  '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:7f00:1',
  '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:FFFF:0808:0808',
  '::8.8.8.8', '100::1', '64:ff9b::808:808', '64:ff9b:1::808:808',
  'fc00::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'FC00:0000:0000:0000:0000:0000:0000:0001', 'fe80::1', 'febf::1',
  'FE80:0000:0000:0000:0000:0000:0000:0001', 'fec0::1', 'ff02::1',
  'ff0e::1', 'FF02:0000:0000:0000:0000:0000:0000:0001',
  '2001::1', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:10::1',
  '2001:20::1', '2001:db8::1', '2001:0DB8:0000:0000:0000:0000:0000:0001',
  '2002:0808:0808::1', '2002:7f00:1::1', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '4000::1',
];
const blockedAddresses = [...blockedIPv4, ...blockedIPv6];
const publicAddresses = [
  '1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.0',
  '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.0.3.1',
  '192.88.98.255', '192.88.100.0', '198.17.255.255', '198.20.0.0',
  '2000::1', '2001:200::1', '2001:4860:4860::8888', '2606:4700:4700::1111',
  '2606:4700:4700:0000:0000:0000:0000:1111', '3ffe::1', '3fff:1000::1',
];
const record = address => ({ address, family: net.isIP(address) });
const modelOptions = {
  endpoint: 'https://model.policy.example.com/v1', model: 'injected-test-model',
  key: 'fabricated-unit-test-key', messages: [{ role: 'user', content: 'fixture' }],
};
const mailConfig = host => ({
  accountId: 'fixture', from: 'sender@example.invalid',
  imap: { host, user: 'fabricated-user', password: 'fabricated-mail-secret', secure: true, port: 993 },
  smtp: { host, user: 'fabricated-user', password: 'fabricated-mail-secret', secure: true, port: 465 },
});

// No public endpoint is contacted: DNS and HTTPS requests are mocked before a
// production-model call; mail factories below never create network connections.
function mockModelTransport(t) {
  const requests = [], agents = [];
  t.mock.method(https, 'Agent', function (options) {
    this.options = options; agents.push(this);
    this.destroy = () => { this.destroyed = true; };
  });
  t.mock.method(https, 'request', (options, callback) => {
    requests.push(options);
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content: 'offline fixture' } }] })));
      response.emit('end');
    });
    return req;
  });
  return { requests, agents };
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'network-ip-policy-'));
  const store = new Store(dir);
  const transportCalls = { imap: 0, smtp: 0 };
  const mail = new MailService(store, {
    imapFactory: () => { transportCalls.imap++; assert.fail('blocked target must not create IMAP transport'); },
    smtpFactory: () => { transportCalls.smtp++; assert.fail('blocked target must not create SMTP transport'); },
    ...options,
  });
  t.after(async () => { await mail.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, mail, dir, transportCalls };
}

test('shared policy preserves browser IPv4/IPv6 ranges and rejects invalid inputs', () => {
  assert.equal(isPublicBrowserAddress, isPublicAddress);
  for (const address of blockedAddresses) assert.equal(isPublicAddress(address), false, address);
  for (const address of publicAddresses) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['', 'localhost', '127.1', 'not-an-ip', '[::1]', '8.8.8.8/32', '999.1.1.1', null, undefined, {}, 42])
    assert.equal(isPublicAddress(address), false, String(address));
});

test('model literal IPs use shared policy without any DNS lookup', async t => {
  const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('literal addresses must not use DNS'));
  for (const address of blockedAddresses) {
    const host = net.isIPv6(address) ? `[${address}]` : address;
    await assert.rejects(validateEndpoint(`https://${host}/v1`), { code: 'ENDPOINT_BLOCKED' }, address);
  }
  for (const address of publicAddresses) {
    const host = net.isIPv6(address) ? `[${address}]` : address;
    const endpoint = `https://${host}/v1`;
    assert.equal(await validateEndpoint(endpoint), new URL(endpoint).toString());
  }
  // URL-normalized alternative IPv4 spellings remain blocked.
  for (const host of ['127.1', '2130706433', '0x7f000001'])
    await assert.rejects(validateEndpoint(`https://${host}/v1`), { code: 'ENDPOINT_BLOCKED' });
  assert.equal(lookup.mock.callCount(), 0);
});

test('model DNS rejects every mixed public/private answer and malformed/empty answers', async t => {
  let found;
  t.mock.method(dns, 'lookup', async () => found);
  for (const address of blockedAddresses) {
    for (const answers of [[record('8.8.8.8'), record(address)], [record(address), record('2606:4700:4700::1111')]]) {
      found = answers;
      await assert.rejects(validateEndpoint(modelOptions.endpoint), { code: 'ENDPOINT_BLOCKED' }, address);
    }
  }
  for (const answers of [[], null, {}, [null], [{}], [{ address: 'not-an-ip' }]]) {
    found = answers;
    await assert.rejects(validateEndpoint(modelOptions.endpoint), { code: 'ENDPOINT_BLOCKED' });
  }
  found = [record('8.8.8.8'), record('2606:4700:4700::1111')];
  assert.equal(await validateEndpoint(modelOptions.endpoint), modelOptions.endpoint);
});

test('model rejects DNS failures before invoking even an injected completion transport', async t => {
  t.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error('offline DNS fixture'), { code: 'ENOTFOUND' }); });
  await assert.rejects(callCompletion({ ...modelOptions, fetchImpl: async () => assert.fail('DNS failure must not reach fetch') }), { code: 'ENDPOINT_DNS' });
});

test('model rechecks all DNS answers immediately before the final pinned fetch', async t => {
  const transport = mockModelTransport(t);
  let calls = 0, rebound;
  t.mock.method(dns, 'lookup', async () => ++calls % 2 ? [record('8.8.8.8')] : rebound);
  for (const address of blockedAddresses) {
    rebound = [record('8.8.8.8'), record(address)];
    await assert.rejects(callCompletion(modelOptions), { code: 'ENDPOINT_BLOCKED' }, address);
  }
  assert.equal(calls, blockedAddresses.length * 2);
  assert.equal(transport.requests.length, 0);
  assert.equal(transport.agents.length, 0);
});

test('model pins public DNS results and public IPv6 literals with no extra DNS or TLS bypass', async t => {
  const transport = mockModelTransport(t);
  const lookup = t.mock.method(dns, 'lookup', async () => [record('2606:4700:4700::1111'), record('8.8.8.8')]);
  const first = await callCompletion(modelOptions);
  assert.equal(first.message.content, 'offline fixture');
  assert.equal(lookup.mock.callCount(), 2);
  assert.equal(transport.requests[0].hostname, '2606:4700:4700::1111');
  assert.equal(transport.requests[0].family, 6);
  assert.equal(transport.requests[0].servername, 'model.policy.example.com');
  assert.equal(transport.requests[0].headers.host, 'model.policy.example.com');
  await callCompletion({ ...modelOptions, endpoint: 'https://[2606:4700:4700:0:0:0:0:1111]/v1' });
  assert.equal(lookup.mock.callCount(), 2);
  assert.equal(transport.requests[1].hostname, '2606:4700:4700::1111');
  assert.equal(transport.requests[1].servername, '2606:4700:4700::1111');
  for (const request of transport.requests) assert.equal(request.rejectUnauthorized, true);
  for (const agent of transport.agents) assert.equal(agent.destroyed, true);
});

test('mail configuration rejects blocked literals without DNS or protocol transport', async t => {
  const { mail } = await setup(t);
  const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('literal addresses must not use DNS'));
  for (const address of blockedAddresses) {
    await assert.rejects(mail.configure(mailConfig(address)), error =>
      ['MAIL_HOST_BLOCKED', 'MAIL_HOST_INVALID'].includes(error.code), address);
  }
  for (const address of ['8.8.8.8', '2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111'])
    assert.equal((await mail.configure(mailConfig(address))).imap.host, address);
  assert.equal(lookup.mock.callCount(), 0);
});

test('mail DNS rejects mixed public/private and malformed answers during configuration', async t => {
  const { mail } = await setup(t);
  let found;
  t.mock.method(dns, 'lookup', async () => found);
  for (const address of blockedAddresses) {
    for (const answers of [[record('8.8.8.8'), record(address)], [record(address), record('2606:4700:4700::1111')]]) {
      found = answers;
      await assert.rejects(mail.configure(mailConfig('mail.policy.example.com')), { code: 'MAIL_HOST_BLOCKED' }, address);
    }
  }
  for (const answers of [[], null, {}, [null], [{}], [{ address: 'invalid-address' }]]) {
    found = answers;
    await assert.rejects(mail.configure(mailConfig('mail.policy.example.com')), { code: 'MAIL_HOST_BLOCKED' });
  }
});

test('mail rechecks DNS before IMAP/SMTP transport after a public configuration', async t => {
  const { mail, transportCalls } = await setup(t);
  let found = [record('8.8.8.8')];
  t.mock.method(dns, 'lookup', async () => found);
  await mail.configure(mailConfig('mail.policy.example.com'));
  for (const address of ['0:0:0:0:0:0:0:1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:7f00:1::1']) {
    found = [record('8.8.8.8'), record(address)];
    await assert.rejects(mail.readInbox({ accountId: 'fixture' }), { code: 'MAIL_HOST_BLOCKED' });
    const draft = mail.createDraft({ accountId: 'fixture', to: 'recipient@example.invalid', subject: 'offline policy fixture', text: 'fabricated body' });
    const approval = mail.requestSend(draft.id);
    const result = await mail.decideSend(approval.id, 'approve');
    assert.equal(result.status, 'failed');
    assert.equal(result.dataStarted, undefined);
  }
  assert.deepEqual(transportCalls, { imap: 0, smtp: 0 });
});

test('mail pins a public IPv6 DNS result while retaining required TLS identity', async t => {
  const captured = [];
  const { mail } = await setup(t, { imapFactory: options => {
    captured.push(options);
    const client = new EventEmitter();
    client.mailbox = { uidValidity: 1, uidNext: 1 };
    client.connect = async () => {};
    client.getMailboxLock = async () => ({ release() {} });
    client.close = () => {};
    return client;
  } });
  t.mock.method(dns, 'lookup', async () => [record('2606:4700:4700::1111'), record('8.8.8.8')]);
  await mail.configure(mailConfig('mail.policy.example.com'));
  assert.deepEqual((await mail.readInbox({ accountId: 'fixture' })).messages, []);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].host, '2606:4700:4700::1111');
  assert.equal(captured[0].tls.servername, 'mail.policy.example.com');
  assert.equal(captured[0].tls.rejectUnauthorized, true);
  assert.equal(captured[0].tls.minVersion, 'TLSv1.2');
});

test('browser configuration shares the same fail-closed policy without launching Chromium', async t => {
  const { store, dir } = await setup(t);
  let found = [record('8.8.8.8')];
  const browser = new ControlledBrowserService(store, { dataDir: dir, resolveHost: async () => found });
  t.after(() => browser.close());
  for (const address of blockedAddresses) {
    const host = net.isIPv6(address) ? `[${address}]` : address;
    await assert.rejects(browser.configureTargets([{ id: 'fixture', startUrl: `https://${host}/` }]), { code: 'TARGET_PRIVATE' });
    found = [record('8.8.8.8'), record(address)];
    await assert.rejects(browser.configureTargets([{ id: 'fixture', startUrl: 'https://browser.policy.example.com/' }]), { code: 'TARGET_DNS_PRIVATE' });
  }
  found = [record('8.8.8.8'), record('2606:4700:4700::1111')];
  assert.equal((await browser.configureTargets([{ id: 'fixture', startUrl: 'https://browser.policy.example.com/' }])).length, 1);
});

test('test-only loopback exceptions stay explicit and do not admit other local addresses', async t => {
  const { mail } = await setup(t, { allowTestLocal: true });
  const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('test-only literals must not use DNS'));
  const endpoint = 'http://127.0.0.1:12345/v1';
  assert.equal(await validateEndpoint(endpoint, { allowTestLocal: true }), endpoint);
  await assert.rejects(validateEndpoint(endpoint), { code: 'ENDPOINT_INVALID' });
  await assert.rejects(validateEndpoint('http://127.0.0.2:12345/v1', { allowTestLocal: true }), { code: 'ENDPOINT_INVALID' });
  await assert.rejects(validateEndpoint('https://[::1]/v1', { allowTestLocal: true }), { code: 'ENDPOINT_BLOCKED' });
  assert.equal((await mail.configure(mailConfig('127.0.0.1'))).imap.host, '127.0.0.1');
  await assert.rejects(mail.configure(mailConfig('127.0.0.2')), { code: 'MAIL_HOST_BLOCKED' });
  await assert.rejects(mail.configure(mailConfig('::1')), { code: 'MAIL_HOST_BLOCKED' });
  assert.equal(lookup.mock.callCount(), 0);
});
