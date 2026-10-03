'use strict';

// The production source is intentionally compiled in. Remote bodies never supply
// commands, filenames, source overrides, install flags, or a redirect allowlist.
const REPOSITORY_ID = 1400818714;
const REPOSITORY_OWNER_ID = 137971851;
const REPOSITORY_OWNER_LOGIN = 'jobKKB';
const REPOSITORY = 'jobKKB/luheng-highway-agent';
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_RELEASE_NOTES = 8000;
const MAX_VERSION_COMPONENT = 2147483647;
const MAX_REDIRECTS = 5;
const DEFAULT_CHANNEL = 'stable';
const ASSET_CONTENT_TYPES = Object.freeze([
  'application/octet-stream', 'application/x-msdownload',
  'application/vnd.microsoft.portable-executable', 'application/x-ms-dos-executable',
]);
// Observed by two HEAD requests on 2026-10-03 (no binary transfer):
// GitHub 302 -> this host/repository UUID path -> 200, application/octet-stream,
// Content-Length 244044118. Do not broaden to unobserved githubusercontent hosts.
const CDN_HOST = 'release-assets.githubusercontent.com';
const CDN_PATH = /^\/github-production-release-asset\/1400818714\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function policyError(code, message) {
  return Object.assign(new Error(message), { code });
}
function requireValue(condition, code = 'INVALID_METADATA', message = '更新元数据不符合要求') {
  if (!condition) throw policyError(code, message);
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function parseVersion(value) {
  requireValue(typeof value === 'string' && value.length <= 32
    && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value),
  'INVALID_VERSION', '版本格式不受支持');
  const parts = value.split('.').map(Number);
  requireValue(parts.every(part => Number.isSafeInteger(part) && part <= MAX_VERSION_COMPONENT),
    'INVALID_VERSION', '版本数值超出范围');
  return Object.freeze(parts);
}

// Local packaged versions support strict SemVer, including build metadata.
function parseCurrentVersion(value) {
  requireValue(typeof value === 'string' && value.length <= 128,
    'INVALID_VERSION', '当前版本格式不受支持');
  const match = /^([^+\-]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  requireValue(Boolean(match), 'INVALID_VERSION', '当前版本格式不受支持');
  const core = parseVersion(match[1]);
  const prerelease = match[2] ? match[2].split('.') : [];
  requireValue(prerelease.every(part => !/^[0-9]+$/.test(part)
    || (/^(0|[1-9][0-9]*)$/.test(part) && Number.isSafeInteger(Number(part))
      && Number(part) <= MAX_VERSION_COMPONENT)), 'INVALID_VERSION', '当前预发布版本格式不受支持');
  return Object.freeze({ core, prerelease: Object.freeze(prerelease) });
}
// Remote versions retain their complete strict SemVer label. Build metadata is
// forbidden so different remote labels cannot have identical precedence.
function parseReleaseVersion(value) {
  requireValue(typeof value === 'string' && !/[+\s]/.test(value),
    'INVALID_VERSION', '发布版本格式不受支持');
  return parseCurrentVersion(value);
}
function compareVersions(left, right) {
  const a = parseCurrentVersion(left); const b = parseCurrentVersion(right);
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i]; const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^[0-9]+$/.test(x); const ny = /^[0-9]+$/.test(y);
    if (nx !== ny) return nx ? -1 : 1;
    return nx ? (Number(x) > Number(y) ? 1 : -1) : (x > y ? 1 : -1);
  }
  return 0;
}
function assetName(version) { parseReleaseVersion(version); return `Luheng-Office-Agent-${version}-windows-x64.exe`; }
function assetDownloadURL(version) {
  return `${REPOSITORY_URL}/releases/download/v${version}/${assetName(version)}`;
}
function releaseURL(version) { parseReleaseVersion(version); return `${REPOSITORY_URL}/releases/tag/v${version}`; }

function validateRepository(repository) {
  requireValue(plainObject(repository) && repository.id === REPOSITORY_ID
    && repository.full_name === REPOSITORY && repository.private === false
    && plainObject(repository.owner) && positiveInteger(repository.owner.id)
    && repository.owner.id === REPOSITORY_OWNER_ID && repository.owner.login === REPOSITORY_OWNER_LOGIN
    && repository.url === API_ROOT && repository.html_url === REPOSITORY_URL,
  'SOURCE_CHANGED', '固定更新仓库身份不匹配');
  return Object.freeze({ id: REPOSITORY_ID, full_name: REPOSITORY, private: false,
    owner: Object.freeze({ id: REPOSITORY_OWNER_ID, login: REPOSITORY_OWNER_LOGIN }),
    url: API_ROOT, html_url: REPOSITORY_URL });
}
function sanitizeReleaseNotes(notes) {
  requireValue(notes === null || notes === undefined || typeof notes === 'string');
  return (notes || '').slice(0, MAX_RELEASE_NOTES * 2)
    .replace(/\r\n?/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, MAX_RELEASE_NOTES);
}
function validateRelease(release) {
  requireValue(plainObject(release) && typeof release.tag_name === 'string'
    && release.tag_name.startsWith('v'));
  const version = release.tag_name.slice(1); const parsed = parseReleaseVersion(version);
  requireValue(positiveInteger(release.id) && release.draft === false
    && typeof release.prerelease === 'boolean'
    && (!parsed.prerelease.length || release.prerelease === true)
    && release.url === `${API_ROOT}/releases/${release.id}`
    && release.html_url === releaseURL(version));
  requireValue(typeof release.published_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(release.published_at)
    && Number.isFinite(Date.parse(release.published_at)));
  requireValue(new Date(release.published_at).toISOString()
    === release.published_at.replace(/(?<!\.\d{3})Z$/, '.000Z'));
  requireValue(Array.isArray(release.assets) && release.assets.length <= 1000);
  const expectedName = assetName(version);
  const matching = release.assets.filter(asset => plainObject(asset) && asset.name === expectedName);
  requireValue(matching.length === 1);
  const asset = matching[0];
  requireValue(positiveInteger(asset.id) && asset.state === 'uploaded'
    && positiveInteger(asset.size) && asset.size <= MAX_ASSET_BYTES
    && typeof asset.digest === 'string' && /^sha256:[0-9a-fA-F]{64}$/.test(asset.digest)
    && ASSET_CONTENT_TYPES.includes(asset.content_type)
    && asset.url === `${API_ROOT}/releases/assets/${asset.id}`
    && asset.browser_download_url === assetDownloadURL(version));
  return Object.freeze({ version, tag: `v${version}`, sizeBytes: asset.size,
    sha256: asset.digest.slice(7).toLowerCase(), assetId: asset.id, releaseId: release.id,
    assetName: expectedName, contentType: asset.content_type, releaseDate: release.published_at,
    releaseNotes: sanitizeReleaseNotes(release.body), releaseUrl: releaseURL(version),
    downloadUrl: assetDownloadURL(version), repositoryId: REPOSITORY_ID,
    repositoryFullName: REPOSITORY, unsigned: true });
}

function chooseCandidate(releases, { currentVersion, channel = DEFAULT_CHANNEL } = {}) {
  parseCurrentVersion(currentVersion);
  requireValue(['preview', 'stable'].includes(channel), 'INVALID_CHANNEL', '更新渠道不受支持');
  requireValue(Array.isArray(releases) && releases.length <= 300);
  const eligible = [];
  for (const release of releases) {
    if (!plainObject(release) || release.draft === true
      || (channel === 'stable' && release.prerelease === true)) continue;
    if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) continue;
    const version = release.tag_name.slice(1);
    let parsed;
    try { parsed = parseReleaseVersion(version); } catch { continue; }
    if (channel === 'stable' && parsed.prerelease.length) continue;
    eligible.push({ release, version });
  }
  requireValue(eligible.length > 0, 'NO_RELEASE', '该渠道暂时没有受支持的发布版本');
  eligible.sort((a, b) => compareVersions(b.version, a.version));
  const highest = eligible[0];
  requireValue(eligible.filter(item => item.version === highest.version).length === 1);
  // Even an equal/older release must pass source/asset validation before it can
  // establish "current". A broken newest release cannot hide behind an older one.
  const candidate = validateRelease(highest.release);
  return compareVersions(candidate.version, currentVersion) > 0 ? candidate : null;
}

function validateCandidate(candidate) {
  requireValue(plainObject(candidate)); parseReleaseVersion(candidate.version);
  requireValue(candidate.tag === `v${candidate.version}` && candidate.unsigned === true
    && candidate.repositoryId === REPOSITORY_ID && candidate.repositoryFullName === REPOSITORY
    && positiveInteger(candidate.releaseId) && positiveInteger(candidate.assetId)
    && positiveInteger(candidate.sizeBytes) && candidate.sizeBytes <= MAX_ASSET_BYTES
    && typeof candidate.sha256 === 'string' && /^[0-9a-f]{64}$/.test(candidate.sha256)
    && candidate.assetName === assetName(candidate.version)
    && candidate.releaseUrl === releaseURL(candidate.version)
    && candidate.downloadUrl === assetDownloadURL(candidate.version)
    && ASSET_CONTENT_TYPES.includes(candidate.contentType));
  return candidate;
}
function safeHTTPSURL(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 8192
    && !/[\s\u0000-\u001f\u007f\\]/.test(value), 'UNSAFE_URL', '更新地址不符合固定来源要求');
  let url;
  try { url = new URL(value); } catch { throw policyError('UNSAFE_URL', '更新地址不符合固定来源要求'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && (!url.port || url.port === '443'), 'UNSAFE_URL', '更新地址不符合固定来源要求');
  return url;
}
function validateDownloadURL(value, { candidate, redirectHop = 0 } = {}) {
  validateCandidate(candidate);
  requireValue(Number.isInteger(redirectHop) && redirectHop >= 0 && redirectHop <= MAX_REDIRECTS,
    'REDIRECT_LIMIT', '更新下载重定向次数超出限制');
  const url = safeHTTPSURL(value);
  if (redirectHop === 0) {
    requireValue(value === assetDownloadURL(candidate.version), 'UNSAFE_URL', '更新下载地址不匹配');
  } else {
    // Check the original path, not just URL.pathname: WHATWG URL normalizes
    // dot-segments and default ports before the whitelist sees them.
    const cdn = /^https:\/\/release-assets\.githubusercontent\.com(?::443)?(\/[^?#]*)\?[^#]+$/.exec(value);
    requireValue((value === assetDownloadURL(candidate.version))
      || (cdn && url.hostname === CDN_HOST && CDN_PATH.test(cdn[1]) && CDN_PATH.test(url.pathname)
        && url.search.length > 1), 'UNSAFE_URL', '更新重定向来源不受支持');
  }
  return url.href;
}
function validateAPIURL(value) {
  safeHTTPSURL(value);
  requireValue(value === API_ROOT || /^https:\/\/api\.github\.com\/repos\/jobKKB\/luheng-highway-agent\/releases\?per_page=100&page=[1-3]$/.test(value),
    'UNSAFE_URL', '更新 API 地址不受支持');
  return value;
}
function toPublicCandidate(candidate) {
  validateCandidate(candidate);
  requireValue(typeof candidate.id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(candidate.id));
  return Object.freeze({ id: candidate.id, version: candidate.version, sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256, releaseDate: candidate.releaseDate,
    releaseNotes: sanitizeReleaseNotes(candidate.releaseNotes), releaseUrl: candidate.releaseUrl, unsigned: true });
}
function isSupportedUpdatePlatform({ platform, arch, packaged } = {}) {
  return platform === 'win32' && arch === 'x64' && packaged === true;
}

module.exports = { REPOSITORY_ID, REPOSITORY_OWNER_ID, REPOSITORY_OWNER_LOGIN, REPOSITORY, API_ROOT, REPOSITORY_URL, MAX_ASSET_BYTES,
  MAX_RELEASE_NOTES, MAX_REDIRECTS, DEFAULT_CHANNEL, ASSET_CONTENT_TYPES,
  policyError, parseVersion, parseCurrentVersion, parseReleaseVersion, compareVersions, assetName, assetDownloadURL,
  releaseURL, validateRepository, sanitizeReleaseNotes, validateRelease, chooseCandidate,
  validateCandidate, validateDownloadURL, validateAPIURL, toPublicCandidate, isSupportedUpdatePlatform };
