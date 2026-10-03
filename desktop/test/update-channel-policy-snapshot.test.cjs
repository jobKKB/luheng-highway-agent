'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../update-policy.cjs');
const snapshot = require('./fixtures/release052-public-snapshot.json');
test('readonly 2026-10-03 public v0.5.2 prerelease snapshot is accepted only by explicit preview, with exact existing asset', () => {
  assert.equal(snapshot.id, 402587713); assert.equal(snapshot.draft, false); assert.equal(snapshot.prerelease, true);
  const candidate = policy.chooseCandidate([snapshot], { currentVersion: '0.5.1', channel: 'preview' });
  assert.equal(candidate.version, '0.5.2'); assert.equal(candidate.assetId, 608106573); assert.equal(candidate.sizeBytes, 244046095);
  assert.equal(candidate.sha256, '45510cbe8f3af129687d8ace267a5184ac64d4d273f63948996d1554a70acfe3');
  assert.throws(() => policy.chooseCandidate([snapshot], { currentVersion: '0.5.1' }), { code: 'NO_RELEASE' });
  assert.throws(() => policy.chooseCandidate([snapshot], { currentVersion: '0.5.1', channel: 'stable' }), { code: 'NO_RELEASE' });
  assert.equal(policy.chooseCandidate([snapshot], { currentVersion: '0.6.0-beta.1', channel: 'preview' }), null, 'older existing public package cannot downgrade beta baseline');
});
