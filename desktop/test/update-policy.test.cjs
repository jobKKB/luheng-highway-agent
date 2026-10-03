'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const policy = require('../update-policy.cjs');
const { createUpdateSession, createUpdateTransport, MAX_JSON_BYTES } = require('../update-transport.cjs');
const EXE = Buffer.from('MZdemo');
const DIGEST = createHash('sha256').update(EXE).digest('hex');
const repository = { id: policy.REPOSITORY_ID, full_name: policy.REPOSITORY,
  owner: { id: policy.REPOSITORY_OWNER_ID, login: policy.REPOSITORY_OWNER_LOGIN },
  private: false, url: policy.API_ROOT, html_url: policy.REPOSITORY_URL };
const memorySession = () => ({ isPersistent: () => false });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function release(version = '0.5.1', changes = {}) {
  return { id: 402471888, tag_name: `v${version}`, draft: false, prerelease: true,
    url: `${policy.API_ROOT}/releases/402471888`, html_url: policy.releaseURL(version),
    published_at: '2026-10-03T11:10:33Z', body: 'Unsigned preview',
    assets: [{ id: 607666172, name: policy.assetName(version), state: 'uploaded',
      size: EXE.length, digest: `sha256:${DIGEST}`, content_type: 'application/x-msdownload',
      url: `${policy.API_ROOT}/releases/assets/607666172`, browser_download_url: policy.assetDownloadURL(version) }],
    ...changes };
}
function candidate(version = '0.5.1') { return policy.validateRelease(release(version)); }
function cdnURL(path = '4d14461f-5bcc-4ba4-a44e-63c38ac9aa7f') {
  return `https://release-assets.githubusercontent.com/github-production-release-asset/1400818714/${path}?sp=r&sig=test`;
}
function code(expected) { return error => { assert.equal(error.code, expected); return true; }; }
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Electron protocol simulation, including synchronous followRedirect, normal
// Readable/pipe backpressure, abort, request close, held bodies and safe headers.
function fakeNet(scripts) {
  const requests = [];
  return { requests,
    request(options) {
      const script = scripts.shift(); assert.ok(script, `Unexpected request ${options.url}`);
      const req = new EventEmitter(); Object.assign(req, { options, follows: 0, aborted: false });
      requests.push(req);
      req.abort = () => {
        if (req.aborted) return;
        req.aborted = true; req.emit('abort');
        if (req.response) req.response.destroy();
        req.emit('close');
      };
      req.followRedirect = () => { assert.equal(req.inRedirect, true); req.follows += 1; };
      req.end = () => { if (script.earlyRequestClose) req.emit('close'); setImmediate(() => {
        if (req.aborted || script.noResponse) return;
        if (script.error) { req.emit('error', new Error('secret token and signed CDN query')); return; }
        if (script.login) { req.emit('login', { realm: 'private' }, (...args) => { req.loginArgs = args; }); return; }
        for (const redirect of script.redirects || []) {
          req.inRedirect = true;
          req.emit('redirect', redirect.status || 302, redirect.method || 'GET', redirect.url, {});
          req.inRedirect = false;
          if (req.aborted) return;
        }
        const response = new PassThrough({ highWaterMark: 64 * 1024 });
        response.statusCode = script.statusCode || 200;
        response.headers = script.headers || { 'content-type': 'application/json' };
        response.rawHeaders = script.rawHeaders || [];
        req.response = response;
        response.on('end', () => setImmediate(() => req.emit('close')));
        req.emit('response', response);
        if (req.aborted) return;
        if (script.prematureClose) { response.destroy(); req.emit('close'); return; }
        if (script.streamError) { response.emit('error', new Error('server credential')); return; }
        const body = script.chunks || [Buffer.isBuffer(script.body) ? script.body
          : Buffer.from(typeof script.body === 'string' ? script.body : JSON.stringify(script.body ?? {}))];
        for (const chunk of body) response.write(chunk);
        if (!script.hold) response.end();
      }); };
      return req;
    },
  };
}
function clock() {
  let current = 0; let sequence = 0; const timers = new Map();
  return { now: () => current,
    setTimer: (fn, milliseconds) => { const id = ++sequence; timers.set(id, { fn, at: current + milliseconds }); return id; },
    clearTimer: id => timers.delete(id),
    advance(milliseconds) {
      current += milliseconds;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= current && timers.has(id)) { timers.delete(id); timer.fn(); }
      }
    },
    timers,
  };
}
function assetScript(changes = {}) {
  return { body: EXE, headers: { 'content-type': 'application/octet-stream', 'content-length': String(EXE.length) }, ...changes };
}

test('strict numeric release versions and numeric ordering do not overflow or sort lexically', () => {
  assert.deepEqual(policy.parseVersion('0.5.10'), [0, 5, 10]);
  assert.equal(policy.compareVersions('0.5.10', '0.5.2'), 1);
  assert.equal(policy.compareVersions('10.0.0', '9.99.99'), 1);
  for (const version of ['v0.5.1', '01.5.1', '0.05.1', '0.5', '0.5.1.0', '0.5.1-beta',
    '0.5.1+build', '0.5.1 ', '-1.0.0', '2147483648.0.0', '9007199254740993.0.0', null]) {
    assert.throws(() => policy.parseVersion(version), code('INVALID_VERSION'));
  }
});
test('strict local SemVer supports actual candidate version without silently stripping suffixes', () => {
  assert.equal(policy.compareVersions('0.6.0', '0.6.0-candidate.2'), 1);
  assert.equal(policy.compareVersions('0.6.0-candidate.10', '0.6.0-candidate.2'), 1);
  assert.equal(policy.compareVersions('0.6.0-alpha', '0.6.0-1'), 1);
  assert.equal(policy.compareVersions('0.6.0-alpha', '0.6.0-alpha.1'), -1);
  assert.equal(policy.compareVersions('0.6.0+one', '0.6.0+two'), 0);
  for (const version of ['0.6.0-01', '0.6.0-', '0.6.0-foo..bar', '0.6.0+b..c', '0.6.0-你好',
    '0.6.0-9007199254740993', '0.6.0 arbitrary', '0.6.0/foo']) {
    assert.throws(() => policy.parseCurrentVersion(version), code('INVALID_VERSION'));
  }
});
test('remote strict SemVer preserves bounded prerelease identifiers and forbids build metadata', () => {
  const parsed = policy.parseReleaseVersion('0.6.0-beta.2');
  assert.deepEqual(parsed.core, [0, 6, 0]); assert.deepEqual(parsed.prerelease, ['beta', '2']);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.prerelease));
  assert.deepEqual(policy.parseReleaseVersion('0.6.0').prerelease, []);
  assert.deepEqual(policy.parseReleaseVersion('2147483647.0.0-2147483647').prerelease, ['2147483647']);
  for (const version of [null, 'v0.6.0-beta.2', '00.6.0-beta.2', '0.6.0-01', '0.6.0-',
    '0.6.0-beta..2', '0.6.0-beta_2', '0.6.0-你好', '0.6.0-beta.2 ', '0.6.0-beta/2',
    '0.6.0\n', '0.6.0-beta.2\n', '0.6.0-beta.2\r', '0.6.0-beta.2\u2028',
    '0.6.0-beta%2e2', '2147483648.0.0-beta.2', '0.6.0-beta.2147483648',
    '0.6.0-9007199254740993', `0.6.0-${'a'.repeat(123)}`, '0.6.0+build', '0.6.0-beta.2+build']) {
    assert.throws(() => policy.parseReleaseVersion(version), code('INVALID_VERSION'));
    assert.throws(() => policy.assetName(version), code('INVALID_VERSION'));
    assert.throws(() => policy.releaseURL(version), code('INVALID_VERSION'));
  }
});
test('platform gate limits updates to packaged Windows x64', () => {
  assert.equal(policy.isSupportedUpdatePlatform({ platform: 'win32', arch: 'x64', packaged: true }), true);
  for (const options of [{ platform: 'linux', arch: 'x64', packaged: true },
    { platform: 'win32', arch: 'arm64', packaged: true }, { platform: 'win32', arch: 'x64', packaged: false }]) {
    assert.equal(policy.isSupportedUpdatePlatform(options), false);
  }
});
test('repo numeric identity, fixed owner/name, visibility and canonical URL must all match', () => {
  assert.equal(policy.validateRepository(repository).id, 1400818714);
  for (const changes of [{ id: 1 }, { full_name: 'other/luheng-highway-agent' }, { private: true },
    { url: 'https://api.github.com/repos/other/repo' }, { html_url: 'https://github.com/other/repo' }]) {
    assert.throws(() => policy.validateRepository({ ...repository, ...changes }), code('SOURCE_CHANGED'));
  }
});
test('fixed repository owner survives frozen double-sanitization without extra metadata', () => {
  assert.equal(policy.REPOSITORY_OWNER_ID, 137971851);
  assert.equal(policy.REPOSITORY_OWNER_LOGIN, 'jobKKB');
  const first = policy.validateRepository({ ...repository, extra: 'discard',
    owner: { ...repository.owner, type: 'User', extra: 'discard' } });
  assert.deepEqual(first, repository);
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.owner));
  const second = policy.validateRepository(first);
  assert.deepEqual(second, first); assert.ok(Object.isFrozen(second.owner));
  assert.notEqual(second.owner, first.owner);
  assert.deepEqual(policy.validateRepository(Object.assign(Object.create(null), repository,
    { owner: Object.assign(Object.create(null), repository.owner) })), repository);
});
test('missing, changed or non-plain repository owner and invalid owner id/login fail closed', () => {
  const missingOwner = { ...repository }; delete missingOwner.owner;
  assert.throws(() => policy.validateRepository(missingOwner), code('SOURCE_CHANGED'));
  for (const owner of [null, undefined, [], 'jobKKB', 137971851, true,
    new (class Owner { constructor() { Object.assign(this, repository.owner); } })(),
    Object.create(repository.owner),
    { login: policy.REPOSITORY_OWNER_LOGIN }, { id: policy.REPOSITORY_OWNER_ID },
    ...[1, 0, -1, null, undefined, true, '137971851', 137971851.5,
      NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(id => ({ ...repository.owner, id })),
    ...['other', 'jobkkb', '', null, undefined, 137971851, true].map(login => ({ ...repository.owner, login }))]) {
    assert.throws(() => policy.validateRepository({ ...repository, owner }), code('SOURCE_CHANGED'));
  }
  for (const value of [null, [], new (class Repository { constructor() { Object.assign(this, repository); } })()]) {
    assert.throws(() => policy.validateRepository(value), code('SOURCE_CHANGED'));
  }
});
test('explicit preview finds prerelease, stable ignores it, highest version wins', () => {
  const result = policy.chooseCandidate([release('0.5.2'), release('0.5.10'), release('0.5.3')],
    { currentVersion: '0.5.1', channel: 'preview' });
  assert.equal(result.version, '0.5.10'); assert.ok(Object.isFrozen(result));
  assert.throws(() => policy.chooseCandidate([release()], { currentVersion: '0.5.0', channel: 'stable' }), code('NO_RELEASE'));
  assert.equal(policy.chooseCandidate([release('0.6.0', { prerelease: false })],
    { currentVersion: '0.6.0-candidate.2', channel: 'stable' }).version, '0.6.0');
  assert.throws(() => policy.chooseCandidate([release()], { currentVersion: '0.5.0' }), code('NO_RELEASE'));
});
test('stable is the default and preview requires an explicit supported channel', () => {
  assert.equal(policy.DEFAULT_CHANNEL, 'stable');
  const releases = [release('0.5.2', { prerelease: false }), release('0.6.0-beta.2')];
  assert.equal(policy.chooseCandidate(releases, { currentVersion: '0.5.1' }).version, '0.5.2');
  assert.equal(policy.chooseCandidate(releases, { currentVersion: '0.5.1', channel: 'stable' }).version, '0.5.2');
  assert.equal(policy.chooseCandidate(releases, { currentVersion: '0.5.1', channel: 'preview' }).version, '0.6.0-beta.2');
  for (const channel of ['beta', 'Stable', '', null, true, {}]) {
    assert.throws(() => policy.chooseCandidate(releases, { currentVersion: '0.5.1', channel }), code('INVALID_CHANNEL'));
  }
});
test('preview accepts numeric stable and numeric GitHub prereleases while stable isolates both', () => {
  const stable = release('0.5.1', { prerelease: false }); const preview = release('0.5.2');
  assert.equal(policy.chooseCandidate([stable, preview], { currentVersion: '0.5.0', channel: 'preview' }).version, '0.5.2');
  assert.equal(policy.chooseCandidate([stable, preview], { currentVersion: '0.5.0', channel: 'stable' }).version, '0.5.1');
  assert.equal(policy.chooseCandidate([stable], { currentVersion: '0.5.0', channel: 'preview' }).version, '0.5.1');
  assert.throws(() => policy.chooseCandidate([preview], { currentVersion: '0.5.0', channel: 'stable' }), code('NO_RELEASE'));
});
test('strict preview beta.1 to beta.2 uses SemVer precedence and never downgrades', () => {
  const beta1 = release('0.6.0-beta.1'); const beta2 = release('0.6.0-beta.2');
  assert.equal(policy.chooseCandidate([beta1, beta2], { currentVersion: '0.6.0-beta.1', channel: 'preview' }).version, '0.6.0-beta.2');
  assert.equal(policy.chooseCandidate([beta2, release('0.6.0-beta.10')],
    { currentVersion: '0.6.0-beta.1', channel: 'preview' }).version, '0.6.0-beta.10');
  for (const currentVersion of ['0.6.0-beta.2', '0.6.0-beta.3', '0.6.0', '0.7.0-beta.1']) {
    assert.equal(policy.chooseCandidate([beta1, beta2], { currentVersion, channel: 'preview' }), null);
  }
  assert.throws(() => policy.chooseCandidate([beta1, beta2],
    { currentVersion: '0.6.0-beta.1', channel: 'stable' }), code('NO_RELEASE'));
  const stable = release('0.6.0', { prerelease: false });
  for (const channel of ['stable', 'preview']) {
    assert.equal(policy.chooseCandidate([stable, beta2], { currentVersion: '0.6.0-beta.2', channel }).version, '0.6.0');
    assert.equal(policy.chooseCandidate([release('0.5.2', { prerelease: false })],
      { currentVersion: '0.6.0-beta.1', channel }), null);
  }
});
test('strict prerelease tags require GitHub prerelease true, drafts and duplicate candidates fail closed', () => {
  const mismatch = release('0.6.0-beta.2', { prerelease: false });
  assert.throws(() => policy.validateRelease(mismatch), code('INVALID_METADATA'));
  assert.throws(() => policy.chooseCandidate([mismatch],
    { currentVersion: '0.6.0-beta.1', channel: 'preview' }), code('INVALID_METADATA'));
  assert.throws(() => policy.chooseCandidate([mismatch],
    { currentVersion: '0.6.0-beta.1', channel: 'stable' }), code('NO_RELEASE'));
  const draft = release('0.6.0-beta.2', { draft: true });
  assert.throws(() => policy.validateRelease(draft), code('INVALID_METADATA'));
  for (const channel of ['stable', 'preview']) {
    assert.throws(() => policy.chooseCandidate([draft], { currentVersion: '0.6.0-beta.1', channel }), code('NO_RELEASE'));
  }
  assert.throws(() => policy.chooseCandidate([release('0.6.0-beta.2'), release('0.6.0-beta.2')],
    { currentVersion: '0.6.0-beta.1', channel: 'preview' }), code('INVALID_METADATA'));
});
test('strict preview candidates preserve exact asset/source identity through public sanitization', () => {
  const c = candidate('0.6.0-beta.2');
  assert.equal(c.assetName, 'Luheng-Office-Agent-0.6.0-beta.2-windows-x64.exe');
  assert.equal(c.releaseUrl, `${policy.REPOSITORY_URL}/releases/tag/v0.6.0-beta.2`);
  assert.equal(c.downloadUrl, `${policy.REPOSITORY_URL}/releases/download/v0.6.0-beta.2/${c.assetName}`);
  assert.equal(policy.validateCandidate(c), c);
  assert.equal(policy.validateDownloadURL(c.downloadUrl, { candidate: c }), c.downloadUrl);
  const pub = policy.toPublicCandidate({ ...c, id: 'preview_candidate_identifier' });
  assert.equal(pub.version, '0.6.0-beta.2'); assert.equal(pub.releaseUrl, c.releaseUrl);
  for (const field of ['assetName', 'releaseUrl', 'downloadUrl']) {
    assert.throws(() => policy.validateCandidate({ ...c, [field]: c[field].replace('beta.2', 'beta.1') }), code('INVALID_METADATA'));
  }
  assert.throws(() => policy.validateCandidate({ ...c, version: '0.6.0-beta.2+build' }), code('INVALID_VERSION'));
  for (const mutate of [r => { r.assets.push({ ...r.assets[0] }); }, r => { r.assets[0].id = 0; },
    r => { r.assets[0].digest = null; }, r => { r.assets[0].size = policy.MAX_ASSET_BYTES + 1; },
    r => { r.assets[0].content_type = 'text/html'; }, r => { r.html_url = r.html_url.replace('jobKKB', 'other'); }]) {
    const r = release('0.6.0-beta.2'); mutate(r);
    assert.throws(() => policy.validateRelease(r), code('INVALID_METADATA'));
  }
});
test('only validated equal/older releases establish current; empty or malformed release data never does', () => {
  for (const version of ['0.5.1', '0.5.2']) assert.equal(policy.chooseCandidate([release()],
    { currentVersion: version, channel: 'preview' }), null);
  for (const releases of [[], [release('0.5.1', { draft: true })], [release('0.5.1', { tag_name: 'v0.5.1-beta..1' })],
    [release('0.5.1', { tag_name: 'v0.5.1+build' })]]) {
    assert.throws(() => policy.chooseCandidate(releases, { currentVersion: '0.5.0', channel: 'preview' }), code('NO_RELEASE'));
  }
  const malformedNewest = release('0.5.2'); malformedNewest.assets[0].digest = null;
  assert.throws(() => policy.chooseCandidate([release(), malformedNewest],
    { currentVersion: '0.5.0', channel: 'preview' }), code('INVALID_METADATA'));
  assert.throws(() => policy.chooseCandidate([release(), release()],
    { currentVersion: '0.5.0', channel: 'preview' }), code('INVALID_METADATA'));
});
test('strict release and uploaded exact EXE identity fields fail closed', () => {
  const mutations = [r => { r.id = 0; }, r => { r.id = '12'; }, r => { r.url += '/x'; },
    r => { r.html_url = r.html_url.replace('jobKKB', 'other'); }, r => { r.draft = 'false'; },
    r => { r.prerelease = null; }, r => { r.published_at = 'yesterday'; },
    r => { r.published_at = '2026-02-31T11:10:33Z'; }, r => { r.assets = []; },
    r => { r.assets.push({ ...r.assets[0], state: 'new' }); }, r => { r.assets[0].state = 'new'; },
    r => { r.assets[0].id = 0; }, r => { r.assets[0].id = 1.5; }, r => { r.assets[0].name = '../installer.exe'; },
    r => { r.assets[0].url = r.assets[0].url.replace('jobKKB', 'other'); },
    r => { r.assets[0].browser_download_url = 'https://attacker.test/installer.exe'; },
    r => { r.assets[0].content_type = 'text/html'; }, r => { r.assets[0].digest = null; },
    r => { r.assets[0].digest = DIGEST; }, r => { r.assets[0].digest = `sha512:${DIGEST}`; },
    r => { r.assets[0].digest = `sha256:${'a'.repeat(63)}`; }, r => { r.body = { command: 'run.exe' }; }];
  for (const size of [0, -1, 1.5, '6', Number.MAX_SAFE_INTEGER + 1, policy.MAX_ASSET_BYTES + 1]) {
    mutations.push(r => { r.assets[0].size = size; });
  }
  for (const mutate of mutations) { const r = release(); mutate(r); assert.throws(() => policy.validateRelease(r)); }
});
test('metadata extras are never execution configuration, notes are bounded inert text', () => {
  const r = release(); r.command = 'runas'; r.path = '/tmp/outside'; r.flags = ['/S'];
  r.assets[0].filename = 'remote-filename.exe';
  r.body = '<img src=x onerror=alert(1)>hello\u0000\u202e' + 'X'.repeat(20_000);
  const c = policy.validateRelease(r);
  assert.equal(c.command, undefined); assert.equal(c.path, undefined); assert.equal(c.flags, undefined);
  assert.equal(c.releaseNotes.length, policy.MAX_RELEASE_NOTES);
  assert.equal(c.releaseNotes.startsWith('hello'), true); assert.equal(c.releaseNotes.includes('<img'), false);
  const pub = policy.toPublicCandidate({ ...c, id: 'random_candidate_identifier', token: 'secret',
    cachePath: '/private/user/cache', signedURL: cdnURL() });
  assert.deepEqual(Object.keys(pub).sort(), ['id', 'version', 'sizeBytes', 'sha256', 'releaseDate',
    'releaseNotes', 'releaseUrl', 'unsigned'].sort());
  assert.equal(pub.downloadUrl, undefined);
});
test('download initial URL and each redirect are pinned to exact observed source and repository path', () => {
  const c = candidate();
  assert.equal(policy.validateDownloadURL(c.downloadUrl, { candidate: c }), c.downloadUrl);
  assert.equal(policy.validateDownloadURL(cdnURL(), { candidate: c, redirectHop: 1 }), cdnURL());
  for (const url of ['http://github.com/jobKKB/luheng-highway-agent/releases/download/v0.5.1/x.exe',
    'file:///tmp/installer.exe', 'data:application/octet-stream,MZ', 'javascript:alert(1)', '\\\\server\\installer.exe',
    'https://127.0.0.1/a', 'https://localhost/a', cdnURL().replace('.com/', '.com.attacker.test/'),
    cdnURL().replace('https://', 'https://user@'), cdnURL().replace('.com/', '.com:8443/'),
    cdnURL().replace('1400818714', '1400818715'), cdnURL().replace('release-assets.', 'objects.'),
    cdnURL().replace('github-production-release-asset', 'arbitrary'), cdnURL() + '#fragment',
    cdnURL().split('?')[0], c.downloadUrl.replace('v0.5.1', 'v0.5.2'),
    cdnURL().replace('/1400818714/', '/1400818714/arbitrary/../'),
    cdnURL().replace('/1400818714/', '/1400818714/arbitrary/%2e%2e/')]) {
    assert.throws(() => policy.validateDownloadURL(url, { candidate: c, redirectHop: 1 }), code('UNSAFE_URL'));
  }
  assert.throws(() => policy.validateDownloadURL(cdnURL(), { candidate: c }), code('UNSAFE_URL'));
  assert.throws(() => policy.validateDownloadURL(cdnURL(), { candidate: c, redirectHop: 6 }), code('REDIRECT_LIMIT'));
  assert.throws(() => policy.validateAPIURL(`${policy.API_ROOT}/releases/latest`), code('UNSAFE_URL'));
  assert.throws(() => policy.validateAPIURL(`${policy.API_ROOT}/releases?per_page=100&page=4`), code('UNSAFE_URL'));
});

test('production memory session strips cookies/auth/model/referrer headers and rejects cookie responses', () => {
  let partition; let options; const handlers = {};
  const session = { isPersistent: () => false, setPermissionRequestHandler: fn => { handlers.permission = fn; },
    setPermissionCheckHandler: fn => { handlers.check = fn; }, webRequest: {
      onBeforeSendHeaders: fn => { handlers.send = fn; }, onHeadersReceived: fn => { handlers.receive = fn; } } };
  assert.equal(createUpdateSession({ fromPartition: (p, o) => { partition = p; options = o; return session; } }), session);
  assert.equal(partition.startsWith('persist:'), false); assert.deepEqual(options, { cache: false });
  handlers.send({ requestHeaders: { Accept: 'safe', Host: 'github.com', Cookie: 'private',
    Authorization: 'Bearer secret', 'Proxy-Authorization': 'secret', Referer: 'private page',
    'X-Highway-Desktop-Token': 'secret', 'X-API-Key': 'secret', Origin: 'private', 'If-None-Match': '"safe"' } },
  result => assert.deepEqual(result.requestHeaders, { Accept: 'safe', Host: 'github.com', 'If-None-Match': '"safe"' }));
  handlers.receive({ responseHeaders: { 'Set-Cookie': ['private'], 'set-cookie2': ['private'], 'Content-Type': ['safe'] } },
    result => assert.deepEqual(result.responseHeaders, { 'Content-Type': ['safe'] }));
  handlers.permission(null, 'camera', approved => assert.equal(approved, false)); assert.equal(handlers.check(), false);
});
test('transport verifies repo before any release list, never accepts a source argument or page link', async () => {
  const net = fakeNet([{ body: repository }, { body: [release()], headers: { 'content-type': 'application/json', link: '<https://attacker.test>; rel="next"' } }]);
  const result = await createUpdateTransport().fetchReleases({ session: memorySession(), net, source: 'https://attacker.test' });
  assert.equal(result.repository.id, policy.REPOSITORY_ID); assert.equal(result.releases.length, 1);
  assert.deepEqual(result.repository.owner, repository.owner);
  assert.deepEqual(policy.validateRepository(result.repository), repository);
  assert.deepEqual(net.requests.map(req => req.options.url), [policy.API_ROOT, `${policy.API_ROOT}/releases?per_page=100&page=1`]);
  for (const req of net.requests) {
    assert.equal(req.options.credentials, 'omit'); assert.equal(req.options.useSessionCookies, false);
    assert.equal(req.options.redirect, 'manual'); assert.equal(req.options.referrerPolicy, 'no-referrer');
    assert.equal(req.options.bypassCustomProtocolHandlers, true);
    assert.equal(JSON.stringify(req.options.headers).includes('secret'), false);
  }
  const mismatch = fakeNet([{ body: { ...repository, id: 1 } }]);
  await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net: mismatch }), code('SOURCE_CHANGED'));
  assert.equal(mismatch.requests.length, 1);
});
test('transport rejects a missing or changed fixed owner before any release request', async () => {
  const missingOwner = { ...repository }; delete missingOwner.owner;
  for (const metadata of [missingOwner, { ...repository, owner: null },
    { ...repository, owner: { ...repository.owner, id: 1 } },
    { ...repository, owner: { ...repository.owner, id: '137971851' } },
    { ...repository, owner: { ...repository.owner, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...repository, owner: { ...repository.owner, login: 'other' } }]) {
    const net = fakeNet([{ body: metadata }]);
    await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net }), code('SOURCE_CHANGED'));
    assert.deepEqual(net.requests.map(req => req.options.url), [policy.API_ROOT]);
  }
});
test('release pagination has hard three-page/300-release bound', async () => {
  const net = fakeNet([{ body: repository }, ...Array.from({ length: 3 }, () => ({ body: Array(100).fill(release()) }))]);
  const result = await createUpdateTransport().fetchReleases({ session: memorySession(), net });
  assert.equal(result.releases.length, 300); assert.equal(net.requests.length, 4);
  const over = fakeNet([{ body: repository }, { body: Array(101).fill(release()) }]);
  await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net: over }), code('INVALID_METADATA'));
});
test('API rename redirect never follows; asset redirects follow synchronously after validation only', async () => {
  const renamed = fakeNet([{ redirects: [{ url: policy.API_ROOT.replace('jobKKB', 'renamed') }] }]);
  await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net: renamed }), code('UNSAFE_REDIRECT'));
  assert.equal(renamed.requests[0].follows, 0);
  const safe = fakeNet([assetScript({ redirects: [{ url: cdnURL() }] })]);
  const result = await createUpdateTransport().openAssetStream({ session: memorySession(), net: safe, candidate: candidate() });
  assert.deepEqual(await collect(result.stream), EXE); assert.equal(safe.requests[0].follows, 1);
  const unsafe = fakeNet([assetScript({ redirects: [{ url: 'https://attacker.test/file.exe' }] })]);
  await assert.rejects(createUpdateTransport().openAssetStream({ session: memorySession(), net: unsafe, candidate: candidate() }), code('UNSAFE_URL'));
  assert.equal(unsafe.requests[0].follows, 0);
  const tooMany = fakeNet([assetScript({ redirects: Array.from({ length: 6 }, () => ({ url: cdnURL() })) })]);
  await assert.rejects(createUpdateTransport().openAssetStream({ session: memorySession(), net: tooMany, candidate: candidate() }), code('REDIRECT_LIMIT'));
  assert.equal(tooMany.requests[0].follows, 5);
});
test('ETag 304 reuses verified bounded metadata; 304 without cache is an error', async () => {
  const net = fakeNet([{ body: repository, headers: { 'content-type': 'application/json', etag: '"repository"' } },
    { body: [release()], headers: { 'content-type': 'application/json', etag: '"releases"' } },
    { statusCode: 304 }, { statusCode: 304 }]);
  const transport = createUpdateTransport(); const session = memorySession();
  const first = await transport.fetchReleases({ session, net }); first.releases[0].id = 123;
  const second = await transport.fetchReleases({ session, net });
  assert.equal(second.releases[0].id, 402471888);
  assert.equal(net.requests[2].options.headers['If-None-Match'], '"repository"');
  assert.equal(net.requests[3].options.headers['If-None-Match'], '"releases"');
  await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net: fakeNet([{ statusCode: 304 }]) }), code('CACHE_MISS'));
});
test('403/429 honor Retry-After/reset and cooldown, 404/503 never become current', async () => {
  for (const statusCode of [403, 429]) {
    const time = clock(); const net = fakeNet([{ statusCode, headers: { 'retry-after': '120' } }]);
    const transport = createUpdateTransport(time); const session = memorySession();
    await assert.rejects(transport.fetchReleases({ session, net }), error => {
      assert.equal(error.code, 'RATE_LIMITED'); assert.equal(error.retryAfterMs, 120_000); return true;
    });
    await assert.rejects(transport.fetchReleases({ session, net }), code('RATE_LIMITED')); assert.equal(net.requests.length, 1);
  }
  for (const [statusCode, expected] of [[404, 'SOURCE_NOT_FOUND'], [503, 'HTTP_ERROR']]) {
    await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net: fakeNet([{ statusCode }]) }), code(expected));
  }
});
test('malformed, HTML, oversized, wrong-length, duplicate and encoded JSON bodies fail', async () => {
  const scripts = [[{ body: '<html>unsafe</html>', headers: { 'content-type': 'text/html' } }, 'INVALID_CONTENT_TYPE'],
    [{ body: '{bad json' }, 'INVALID_JSON'], [{ body: Buffer.from([0xff]) }, 'INVALID_JSON'],
    [{ body: Buffer.alloc(MAX_JSON_BYTES + 1) }, 'BODY_TOO_LARGE'],
    [{ body: '{}', headers: { 'content-type': 'application/json', 'content-length': '3' } }, 'SIZE_MISMATCH'],
    [{ body: '{}', headers: { 'content-type': 'application/json', 'content-length': '01' } }, 'INVALID_LENGTH'],
    [{ body: '{}', headers: { 'content-type': 'application/json', 'content-length': [ '2', '2' ] } }, 'INVALID_HEADERS'],
    [{ body: '{}', rawHeaders: ['Content-Length', '2', 'content-length', '2'] }, 'INVALID_HEADERS'],
    [{ body: '{}', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 'INVALID_ENCODING']];
  for (const [script, expected] of scripts) {
    await assert.rejects(createUpdateTransport().fetchReleases({ session: memorySession(), net: fakeNet([script]) }), code(expected));
  }
});
test('binary body bytes, exact length and MZ are enforced before manager verification', async () => {
  const cases = [[assetScript({ headers: { 'content-type': 'text/html' } }), 'INVALID_CONTENT_TYPE'],
    [assetScript({ headers: { 'content-type': 'application/octet-stream', 'content-length': '7' } }), 'SIZE_MISMATCH'],
    [assetScript({ body: Buffer.from('MZdemoo'), headers: { 'content-type': 'application/octet-stream' } }), 'BODY_TOO_LARGE'],
    [assetScript({ body: Buffer.from('MZ'), headers: { 'content-type': 'application/octet-stream' } }), 'SIZE_MISMATCH'],
    [assetScript({ body: Buffer.from('<html>') }), 'INVALID_EXECUTABLE']];
  for (const [script, expected] of cases) {
    const transport = createUpdateTransport(); const net = fakeNet([script]);
    await assert.rejects(async () => {
      const result = await transport.openAssetStream({ session: memorySession(), net, candidate: candidate() });
      await collect(result.stream);
    }, code(expected));
    assert.equal(net.requests[0].aborted, true);
  }
  const result = await createUpdateTransport().openAssetStream({ session: memorySession(), candidate: candidate(),
    net: fakeNet([assetScript({ chunks: [EXE.subarray(0, 1), EXE.subarray(1)] })]) });
  assert.deepEqual(await collect(result.stream), EXE);
  assert.deepEqual(Object.keys(result.headers).sort(), ['content-length', 'content-type']);
});
test('network/TLS/body interruption errors are sanitized and no auth credentials supplied', async () => {
  for (const [script, expected] of [[{ error: true }, 'NETWORK_ERROR'], [{ login: true }, 'AUTH_REQUIRED'],
    [{ prematureClose: true }, 'STREAM_ABORTED'], [{ streamError: true }, 'STREAM_ERROR']]) {
    const net = fakeNet([assetScript(script)]);
    await assert.rejects(async () => {
      const result = await createUpdateTransport().openAssetStream({ session: memorySession(), net, candidate: candidate() });
      await collect(result.stream);
    }, error => { assert.equal(error.code, expected); assert.equal(/secret|credential/.test(error.message), false); return true; });
    if (script.login) assert.deepEqual(net.requests[0].loginArgs, []);
  }
});
test('first byte timeout aborts both no response and a header-only held body', async () => {
  for (const script of [{ noResponse: true }, assetScript({ chunks: [], hold: true })]) {
    const time = clock(); const transport = createUpdateTransport({ ...time, timeouts: { firstByte: 10 } });
    const net = fakeNet([script]);
    const promise = (async () => {
      const result = await transport.openAssetStream({ session: memorySession(), net, candidate: candidate() });
      await collect(result.stream);
    })();
    const rejected = assert.rejects(promise, code('FIRST_BYTE_TIMEOUT'));
    await nextTurn(); time.advance(10); await rejected;
    assert.equal(net.requests[0].aborted, true); assert.equal(time.timers.size, 0);
  }
});
test('idle and total timeouts remain active after successful headers/partial progress', async () => {
  for (const [timeouts, advance, expected] of [[{ idle: 10 }, 10, 'IDLE_TIMEOUT'],
    [{ assetTotal: 10, idle: 100 }, 10, 'TOTAL_TIMEOUT']]) {
    const time = clock(); const net = fakeNet([assetScript({ chunks: [EXE.subarray(0, 2)], hold: true })]);
    const result = await createUpdateTransport({ ...time, timeouts }).openAssetStream({ session: memorySession(), net, candidate: candidate() });
    const rejected = assert.rejects(collect(result.stream), code(expected));
    await nextTurn(); time.advance(advance); await rejected;
    assert.equal(net.requests[0].aborted, true); assert.equal(time.timers.size, 0);
  }
});
test('cancellation before request, during connection and during stream is complete and bounded', async () => {
  const aborted = new AbortController(); aborted.abort(); const zero = fakeNet([]);
  await assert.rejects(createUpdateTransport().openAssetStream({ session: memorySession(), net: zero,
    candidate: candidate(), signal: aborted.signal }), code('CANCELLED')); assert.equal(zero.requests.length, 0);
  for (const script of [{ noResponse: true }, assetScript({ chunks: [EXE.subarray(0, 2)], hold: true })]) {
    const controller = new AbortController(); const net = fakeNet([script]); const time = clock();
    const promise = (async () => {
      const result = await createUpdateTransport(time).openAssetStream({ session: memorySession(), net,
        candidate: candidate(), signal: controller.signal }); await collect(result.stream);
    })();
    const rejected = assert.rejects(promise, code('CANCELLED'));
    await nextTurn(); controller.abort(); await rejected;
    assert.equal(net.requests[0].aborted, true); assert.equal(time.timers.size, 0);
  }
});
test('normal transfer clears timers; bounded streams apply Readable backpressure without whole-asset buffering', async () => {
  const time = clock(); const size = 1024 * 1024;
  const c = { ...candidate(), sizeBytes: size };
  const blocks = Array.from({ length: 16 }, (_, index) => {
    const block = Buffer.alloc(64 * 1024, 1); if (!index) block.write('MZ'); return block;
  });
  const net = fakeNet([assetScript({ chunks: blocks, headers: { 'content-type': 'application/octet-stream' } })]);
  const result = await createUpdateTransport(time).openAssetStream({ session: memorySession(), net, candidate: c });
  await nextTurn(); assert.ok(result.stream.readableLength <= 128 * 1024);
  assert.equal(result.stream.readableEnded, false);
  assert.equal((await collect(result.stream)).length, size); assert.equal(time.timers.size, 0);
});
test('Electron request-body Writable close is not mistaken for response completion or failure', async () => {
  const net = fakeNet([assetScript({ earlyRequestClose: true })]);
  const result = await createUpdateTransport().openAssetStream({ session: memorySession(), net, candidate: candidate() });
  assert.deepEqual(await collect(result.stream), EXE); assert.equal(net.requests[0].aborted, false);
});
test('persistent sessions and forged main candidates cannot send a network request', async () => {
  const transport = createUpdateTransport(); const net = fakeNet([]);
  assert.throws(() => transport.openAssetStream({ candidate: candidate(), session: { isPersistent: () => true }, net }), code('UNSAFE_SESSION'));
  assert.throws(() => transport.openAssetStream({ candidate: { ...candidate(), downloadUrl: 'https://attacker.test' }, session: memorySession(), net }), code('INVALID_METADATA'));
  assert.equal(net.requests.length, 0);
});
