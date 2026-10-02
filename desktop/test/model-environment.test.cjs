'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { backendEnvironment } = require('../security.cjs');

test('backend preserves existing deployment proxy and CA environment only', () => {
  const existing = {
    PATH: '/bin', HTTPS_PROXY: 'http://proxy.example:8080', https_proxy: 'http://lower.example:8080',
    HTTP_PROXY: 'http://proxy.example:8080', http_proxy: 'http://lower.example:8080',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: '.example.com',
    NODE_EXTRA_CA_CERTS: '/existing/deployment-ca.pem', NODE_USE_SYSTEM_CA: '1',
  };
  assert.deepEqual(backendEnvironment({
    ...existing,
    NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '--require=/untrusted.js',
    NODE_USE_ENV_PROXY: '1', ALL_PROXY: 'socks5://unapproved.example',
    OPENAI_API_KEY: 'fake-key', DEEPSEEK_API_KEY: 'fake-key', NODE_DEBUG: 'http,https',
    SSL_CERT_FILE: '/unapproved-ca.pem', LD_PRELOAD: '/untrusted.so',
  }), existing);
});

test('backend does not create proxy or CA settings when deployment supplies none', () => {
  assert.deepEqual(backendEnvironment({ PATH: '/bin' }), { PATH: '/bin' });
  assert.deepEqual(backendEnvironment({ HTTPS_PROXY: null, NODE_USE_SYSTEM_CA: true }), {});
});
