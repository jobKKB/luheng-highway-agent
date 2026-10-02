import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { bypassProxy, modelProxyEnvironment, requestPinnedHTTPS } from "../lib/model-transport.mjs";

const destination = new URL("https://api.example.com/v1/chat/completions");
const pin = { address: "93.184.216.34", family: 4 };
const testProxy = "http://test-user:test-password@proxy.example.test:3128";

function fakeHTTPS({ status = 200, chunks = [Buffer.from('{"ok":true}')], failure, hold = false, abortResponse = false } = {}) {
  const state = { agents: [], requests: [], bodies: [] };
  class Agent {
    constructor(options) { this.options = options; this.destroyed = false; state.agents.push(this); }
    destroy() { this.destroyed = true; }
  }
  return {
    state,
    Agent,
    request(options, callback) {
      state.requests.push(options);
      const req = new EventEmitter();
      req.destroy = (error) => { req.destroyed = true; req.emit("error", error); };
      req.end = (body) => {
        state.bodies.push(body);
        queueMicrotask(() => {
          if (failure) { req.emit("error", failure); return; }
          if (options.signal?.aborted) { req.destroy(Object.assign(new Error("secret abort detail"), { name: "AbortError", code: "ABORT_ERR" })); return; }
          if (hold) return;
          const res = new EventEmitter();
          res.statusCode = status;
          callback(res);
          if (abortResponse) { res.emit("aborted"); return; }
          for (const chunk of chunks) res.emit("data", chunk);
          if (!req.destroyed) res.emit("end");
        });
      };
      options.signal?.addEventListener("abort", () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
      return req;
    },
  };
}

test("NO_PROXY handles documented host, domain, wildcard, port and IPv4 range forms", () => {
  for (const [hostname, port, value, expected] of [
    ["api.example.com", 443, "API.EXAMPLE.COM", true],
    ["api.example.com", 443, "x.test, api.example.com:443", true],
    ["api.example.com", 443, "api.example.com:8443", false],
    ["api.example.com", 443, ".example.com", true],
    ["example.com", 443, ".example.com", true],
    ["evil-example.com", 443, ".example.com", false],
    ["api.example.com", 443, "*.example.com", true],
    ["example.com", 443, "*.example.com", false],
    ["api.example.com", 443, "example.com", false],
    ["api.example.com", 443, "*", true],
    ["93.184.216.34", 443, "93.184.216.0-93.184.216.255", true],
    ["93.184.217.34", 443, "93.184.216.0-93.184.216.255", false],
    ["93.184.216.34", 443, "garbage-93.184.216.255", false],
    ["api.example.com", 443, "", false],
  ]) assert.equal(bypassProxy(hostname, port, value), expected, `${hostname} ${value}`);
});

test("proxy selection uses original host, lowercase precedence and only HTTPS proxy settings", () => {
  assert.deepEqual(modelProxyEnvironment(destination, {}), {});
  assert.deepEqual(modelProxyEnvironment(destination, { HTTP_PROXY: testProxy, ALL_PROXY: testProxy }), {});
  assert.deepEqual(modelProxyEnvironment(destination, { HTTPS_PROXY: testProxy }), { HTTPS_PROXY: testProxy, NO_PROXY: "" });
  assert.deepEqual(modelProxyEnvironment(destination, { HTTPS_PROXY: testProxy, https_proxy: "https://lower.example:443" }), { HTTPS_PROXY: "https://lower.example:443", NO_PROXY: "" });
  assert.deepEqual(modelProxyEnvironment(destination, { HTTPS_PROXY: testProxy, NO_PROXY: "api.example.com" }), {});
  assert.deepEqual(modelProxyEnvironment(destination, { HTTPS_PROXY: testProxy, NO_PROXY: pin.address }), { HTTPS_PROXY: testProxy, NO_PROXY: "" });
  assert.deepEqual(modelProxyEnvironment(destination, { HTTPS_PROXY: testProxy, no_proxy: "api.example.com", NO_PROXY: "different.example" }), {});
});

test("malformed or unsupported configured proxy fails closed without credential disclosure", () => {
  for (const proxy of ["test-password", "http://test-user:test-password@", "socks5://test-user:test-password@proxy.example", "http://user:%ZZ@proxy.example", "http://proxy.example\r\nsecret"]) {
    assert.throws(() => modelProxyEnvironment(destination, { HTTPS_PROXY: proxy }), (error) => {
      assert.equal(error.code, "MODEL_PROXY_CONFIG");
      assert.doesNotMatch(error.message, /test-password|test-user|proxy\.example|%ZZ|secret/);
      return true;
    });
  }
});

test("proxied HTTPS pins CONNECT IP while retaining original TLS identity and Host", async () => {
  const httpsImpl = fakeHTTPS();
  const controller = new AbortController();
  const response = await requestPinnedHTTPS(destination, {
    method: "POST", body: "test-body", signal: controller.signal,
    headers: { authorization: "Bearer fake-key", Host: "wrong-host", "Proxy-Authorization": "should-not-reach-origin" },
    rejectUnauthorized: false,
  }, pin, { env: { HTTPS_PROXY: testProxy, NO_PROXY: pin.address }, httpsImpl });
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  const options = httpsImpl.state.requests[0];
  assert.equal(options.hostname, pin.address);
  assert.equal(options.family, 4);
  assert.equal(options.servername, "api.example.com");
  assert.equal(options.headers.host, "api.example.com");
  assert.equal(options.headers.authorization, "Bearer fake-key");
  assert.equal(Object.keys(options.headers).some((x) => x.toLowerCase() === "proxy-authorization"), false);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.path, "/v1/chat/completions");
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(httpsImpl.state.bodies, ["test-body"]);
  const agent = httpsImpl.state.agents[0];
  assert.deepEqual(agent.options.proxyEnv, { HTTPS_PROXY: testProxy, NO_PROXY: "" });
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.keepAlive, false);
  assert.equal(agent.destroyed, true);
});

test("direct and NO_PROXY connections use an isolated nonproxy agent and still pin DNS", async () => {
  for (const env of [{}, { HTTPS_PROXY: testProxy, NO_PROXY: "api.example.com" }]) {
    const httpsImpl = fakeHTTPS({ status: 401 });
    const response = await requestPinnedHTTPS(destination, { method: "GET" }, pin, { env, httpsImpl });
    assert.equal(response.ok, false);
    assert.equal(response.status, 401);
    assert.deepEqual(httpsImpl.state.agents[0].options.proxyEnv, {});
    assert.equal(httpsImpl.state.requests[0].hostname, pin.address);
  }
});

test("IPv6 pins remain IPv6 and caller cannot supply a hostname in place of validated address", async () => {
  const httpsImpl = fakeHTTPS();
  await requestPinnedHTTPS(destination, {}, { address: "2606:4700:4700::1111", family: 6 }, { env: {}, httpsImpl });
  assert.equal(httpsImpl.state.requests[0].hostname, "2606:4700:4700::1111");
  await assert.rejects(requestPinnedHTTPS(destination, {}, { address: "rebind.example", family: 4 }, { env: {}, httpsImpl }), { code: "ENDPOINT_INVALID" });
  await assert.rejects(requestPinnedHTTPS("http://api.example.com", {}, pin, { env: {}, httpsImpl }), { code: "ENDPOINT_INVALID" });
  assert.equal(httpsImpl.state.requests.length, 1);
});

test("transport does not follow redirects", async () => {
  const httpsImpl = fakeHTTPS({ status: 302 });
  const response = await requestPinnedHTTPS(destination, {}, pin, { env: {}, httpsImpl });
  assert.equal(response.status, 302);
  assert.equal(response.ok, false);
  assert.equal(httpsImpl.state.requests.length, 1);
});

test("bounded response and interrupted response destroy per-request agents", async () => {
  for (const [setup, code] of [
    [{ chunks: [Buffer.alloc(2_000_001)] }, "MODEL_RESPONSE"],
    [{ abortResponse: true }, "ECONNRESET"],
  ]) {
    const httpsImpl = fakeHTTPS(setup);
    await assert.rejects(requestPinnedHTTPS(destination, {}, pin, { env: {}, httpsImpl }), { code });
    assert.equal(httpsImpl.state.agents[0].destroyed, true);
  }
});

test("network errors retain safe diagnostics but never raw URLs, proxy credentials or causes", async () => {
  const original = Object.assign(new Error(`connection to ${testProxy} failed using fake-key`), {
    code: "ECONNREFUSED", syscall: "connect", cause: new Error("test-password"),
    errors: [Object.assign(new Error(testProxy), { code: "ETIMEDOUT" })],
  });
  const httpsImpl = fakeHTTPS({ failure: original });
  await assert.rejects(requestPinnedHTTPS(destination, {}, pin, { env: {}, httpsImpl }), (error) => {
    assert.equal(error.code, "ECONNREFUSED");
    assert.equal(error.syscall, "connect");
    assert.equal(error.errors[0].code, "ETIMEDOUT");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /test-password|proxy\.example|fake-key/);
    return true;
  });
  assert.equal(httpsImpl.state.agents[0].destroyed, true);
});

test("AbortSignal cancellation propagates and closes the per-request agent", async () => {
  const httpsImpl = fakeHTTPS({ hold: true });
  const controller = new AbortController();
  const pending = requestPinnedHTTPS(destination, { signal: controller.signal }, pin, { env: {}, httpsImpl });
  controller.abort();
  await assert.rejects(pending, { code: "ABORT_ERR", name: "AbortError" });
  assert.equal(httpsImpl.state.agents[0].destroyed, true);
});
