import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { Duplex } from "node:stream";
import { createPublicWebService } from "../lib/public-web.mjs";
import { requestPublicPinnedHTTPS } from "../lib/public-web-transport.mjs";

// Synthetic contract fixtures only. No real DNS, HTTPS, credentials or data.
const pin = { address: "93.184.216.34", family: 4 };
const clock = () => Date.parse("2026-10-03T12:00:00Z");
const record = { url: "https://example.test/page", title: "Fixture", text: "Public fixture" };
const response = (body = "", status = 200, headers = { "content-type": "application/json" }) => ({
  status, headers, text: async () => body, bytesLength: Buffer.byteLength(body),
});
const rpc = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const html = (body = "<p>Public fixture</p>", status = 200, headers = {}) =>
  response(body, status, { "content-type": "text/html", ...headers });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const revokedError = (code = "TOOL_PERMISSION_DENIED") => Object.assign(new Error("Synthetic authorization revoked"), { code });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function searchFixture({ resolver = async () => [pin], requestImpl, callResult } = {}) {
  const calls = [];
  const service = createPublicWebService({ resolver, clock, requestImpl: async (url, options, address) => {
    const packet = JSON.parse(options.body);
    calls.push({ url, options, address, packet });
    if (requestImpl) return requestImpl(packet, options);
    if (packet.method === "initialize") return response(rpc(1, { protocolVersion: "2025-03-26" }));
    if (packet.method === "notifications/initialized") return response("", 202, {});
    return response(rpc(2, callResult || { structuredContent: { results: [record] } }));
  } });
  return { service, calls };
}

test("authorized search and extraction retain success, numeric pins and bounded request options", async () => {
  let checks = 0;
  const assertAuthorized = () => { checks++; };
  const { service, calls } = searchFixture();
  assert.equal((await service.search({ query: "public fixture" }, { assertAuthorized })).code, "WEB_OK");
  assert.deepEqual(calls.map(({ packet }) => packet.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.ok(checks > calls.length);
  for (const call of calls) {
    assert.deepEqual(call.address, pin);
    assert.equal(typeof call.options.assertAuthorized, "function");
    assert.equal(call.options.signal.aborted, false);
    assert.ok(call.options.maxBytes <= 2_000_000);
  }
  let extracts = 0;
  const extractor = createPublicWebService({ resolver: async () => [pin], clock,
    requestImpl: async (_url, options, address) => {
      extracts++;
      assert.deepEqual(address, pin);
      options.assertAuthorized();
      return html();
    },
  });
  assert.equal((await extractor.extract({ urls: [record.url] }, { assertAuthorized })).code, "WEB_OK");
  assert.equal(extracts, 1);
});

test("authorization failure before DNS rejects unchanged and creates no network observation", async () => {
  for (const method of ["search", "extract"]) {
    let lookups = 0, requests = 0;
    const service = createPublicWebService({ clock,
      resolver: async () => { lookups++; return [pin]; },
      requestImpl: async () => { requests++; return html(); },
    });
    const failure = revokedError("CALLER_SPECIFIC_AUTHORITY");
    const args = method === "search" ? { query: "public fixture" } : { urls: [record.url] };
    await assert.rejects(service[method](args, { assertAuthorized: () => { throw failure; } }), (error) => error === failure);
    assert.equal(lookups, 0); assert.equal(requests, 0);
    assert.equal(service.networkState().status, "unobserved");
  }
});

for (const code of ["TOOL_PERMISSION_DENIED", "TOOL_DISABLED"]) {
  for (const pauseAt of [1, 2, 3]) {
    test(`MCP DNS pause ${pauseAt} observes ${code} before the next request`, async () => {
      const ready = deferred(), release = deferred();
      let lookups = 0, revoked = false;
      const failure = revokedError(code);
      const { service, calls } = searchFixture({ resolver: async () => {
        if (++lookups === pauseAt) { ready.resolve(); await release.promise; }
        return [pin];
      } });
      const pending = service.search({ query: "public fixture" }, {
        assertAuthorized: () => { if (revoked) throw failure; },
      });
      await ready.promise;
      revoked = true; release.resolve();
      await assert.rejects(pending, (error) => error === failure);
      assert.equal(calls.length, pauseAt - 1);
      assert.equal(calls.filter(({ packet }) => packet.method === "tools/call").length, 0);
      assert.notEqual(service.networkState().code, "WEB_NETWORK");
    });
  }
}

test("actual requestImpl microtask rechecks authorization after the post-DNS checks", async () => {
  let dnsReturned = false, scheduled = false, revoked = false;
  const failure = revokedError();
  const { service, calls } = searchFixture({ resolver: async () => { dnsReturned = true; return [pin]; } });
  await assert.rejects(service.search({ query: "public fixture" }, {
    assertAuthorized: () => {
      if (revoked) throw failure;
      if (dnsReturned && !scheduled) {
        scheduled = true;
        queueMicrotask(() => { revoked = true; });
      }
    },
  }), (error) => error === failure);
  assert.equal(calls.length, 0);
  assert.equal(service.networkState().status, "unobserved");
});

test("revoked authority takes precedence when a pending DNS or request rejects", async () => {
  for (const stage of ["DNS", "request"]) {
    const ready = deferred(), release = deferred();
    const failure = revokedError();
    let revoked = false, requests = 0;
    const rejectAfterWait = async () => {
      ready.resolve(); await release.promise;
      throw new Error("Synthetic network failure");
    };
    const service = createPublicWebService({ clock,
      resolver: stage === "DNS" ? rejectAfterWait : async () => [pin],
      requestImpl: async () => { requests++; return rejectAfterWait(); },
    });
    const pending = service.search({ query: "public fixture" }, {
      assertAuthorized: () => { if (revoked) throw failure; },
    });
    await ready.promise; revoked = true; release.resolve();
    await assert.rejects(pending, (error) => error === failure);
    assert.equal(requests, stage === "DNS" ? 0 : 1);
    assert.equal(service.networkState().status, "unobserved");
  }
});

for (const route of ["redirect", "next URL"]) {
  for (const code of ["TOOL_PERMISSION_DENIED", "TOOL_DISABLED"]) {
    test(`extraction ${route} DNS pause stops ${code} before a subsequent request`, async () => {
      const ready = deferred(), release = deferred();
      const calls = [];
      let lookups = 0, revoked = false;
      const failure = revokedError(code);
      const service = createPublicWebService({ clock, resolver: async () => {
        if (++lookups === 2) { ready.resolve(); await release.promise; }
        return [pin];
      }, requestImpl: async (url) => {
        calls.push(url.href);
        return route === "redirect" ? html("", 302, { location: "/next" }) : html();
      } });
      const pending = service.extract({ urls: route === "redirect" ? [record.url]
        : [record.url, "https://other.test/next"] }, {
        assertAuthorized: () => { if (revoked) throw failure; },
      });
      await ready.promise;
      revoked = true; release.resolve();
      await assert.rejects(pending, (error) => error === failure);
      assert.deepEqual(calls, [record.url]);
      assert.notEqual(service.networkState().code, "WEB_NETWORK");
    });
  }
}

for (const stage of ["MCP query", "redirect", "next URL"]) {
  test(`abort during ${stage} DNS wait permits no subsequent request after DNS settles`, async () => {
    const ready = deferred(), release = deferred();
    const controller = new AbortController();
    let lookups = 0, requests = 0;
    const resolver = async () => {
      if (++lookups === (stage === "MCP query" ? 3 : 2)) { ready.resolve(); await release.promise; }
      return [pin];
    };
    let pending;
    if (stage === "MCP query") {
      const fixture = searchFixture({ resolver });
      pending = fixture.service.search({ query: "public fixture" }, { signal: controller.signal });
      await ready.promise;
      controller.abort();
      await assert.rejects(pending, { code: "CANCELLED" });
      release.resolve(); await flush();
      assert.equal(fixture.calls.length, 2);
      assert.equal(fixture.calls.filter(({ packet }) => packet.method === "tools/call").length, 0);
    } else {
      const service = createPublicWebService({ resolver, clock, requestImpl: async () => {
        requests++;
        return stage === "redirect" ? html("", 302, { location: "/next" }) : html();
      } });
      pending = service.extract({ urls: stage === "redirect" ? [record.url]
        : [record.url, "https://other.test/next"] }, { signal: controller.signal });
      await ready.promise;
      controller.abort();
      await assert.rejects(pending, { code: "CANCELLED" });
      release.resolve(); await flush();
      assert.equal(requests, 1);
    }
  });
}

test("revocation after a response prevents publishing a successful extraction", async () => {
  const failure = revokedError();
  let revoked = false, requests = 0;
  const service = createPublicWebService({ resolver: async () => [pin], clock,
    requestImpl: async () => { requests++; revoked = true; return html(); },
  });
  await assert.rejects(service.extract({ urls: [record.url] }, {
    assertAuthorized: () => { if (revoked) throw failure; },
  }), (error) => error === failure);
  assert.equal(requests, 1);
  assert.equal(service.networkState().status, "unobserved");
});

test("HTTP200 MCP tool failure updates provider observation to its safe semantic code", async () => {
  const { service, calls } = searchFixture({ callResult: {
    isError: true, content: [{ type: "text", text: "429 rate limit synthetic provider detail" }],
  } });
  const output = await service.search({ query: "public fixture" });
  assert.equal(output.status, "unavailable"); assert.equal(output.code, "WEB_RATE_LIMITED");
  assert.deepEqual(service.networkState("exa-mcp"), {
    provider: "exa-mcp", status: "unavailable", code: "WEB_RATE_LIMITED", observedAt: "2026-10-03T12:00:00.000Z",
  });
  assert.equal(calls.length, 3);
  assert.doesNotMatch(JSON.stringify(output), /synthetic provider detail/);
});

test("malformed HTTP200 RPC, initialization and tool content cannot leave WEB_OK observations", async () => {
  for (const stage of ["initialize", "tools/call", "tool content"]) {
    const { service, calls } = searchFixture({ requestImpl: (packet) => {
      if (packet.method === "initialize") return response(rpc(1, { protocolVersion: stage === "initialize" ? "2099-01-01" : "2025-03-26" }));
      if (packet.method === "notifications/initialized") return response("", 202, {});
      return stage === "tools/call" ? response("{ malformed synthetic packet") : response(rpc(2, { content: [] }));
    } });
    const output = await service.search({ query: "public fixture" });
    assert.equal(output.code, "WEB_RESPONSE_INVALID", stage);
    assert.equal(output.status, "unavailable", stage);
    assert.equal(service.networkState("exa-mcp").code, "WEB_RESPONSE_INVALID", stage);
    assert.equal(service.networkState("exa-mcp").status, "unavailable", stage);
    assert.equal(calls.length, stage === "initialize" ? 1 : 3);
  }
});

function socketHTTPS({ proxy = false, onAgent, onRequest } = {}) {
  const state = { agents: [], requests: [], connections: [], ends: [], writes: [], connects: 0 };
  const socket = () => {
    const stream = new EventEmitter();
    Object.assign(stream, { connecting: true, encrypted: true, authorized: false });
    stream.destroy = () => { stream.destroyed = true; stream.connecting = false; };
    stream.write = (body) => { if (stream.destroyed) return false; state.writes.push(body); return true; };
    return stream;
  };
  state.origin = socket();
  state.proxy = proxy ? socket() : null;
  if (state.proxy) state.proxy.encrypted = false;
  class Agent {
    constructor(options) { this.options = options; state.agents.push(this); onAgent?.(); }
    destroy() { this.destroyed = true; }
    createConnection(options, callback) {
      state.connections.push(options);
      state.completeTunnel = () => {
        state.origin.connecting = false; state.origin.authorized = true;
        callback(null, state.origin);
      };
      if (state.proxy) {
        state.proxy.once("connect", () => state.proxy.write("SYNTHETIC CONNECT"));
        return state.proxy;
      }
      return state.origin;
    }
  }
  const httpsImpl = { Agent, request(options, responseCallback) {
    state.requests.push(options); onRequest?.();
    const req = new EventEmitter(); state.req = req;
    req.destroy = (failure) => {
      if (req.destroyed) return;
      req.destroyed = true;
      if (failure) req.emit("error", failure);
    };
    req.end = (body) => {
      state.ends.push(body);
      state.origin.write(body);
      queueMicrotask(() => {
        if (req.destroyed) return;
        const res = new EventEmitter(); res.statusCode = 200; res.headers = { "content-type": "text/html" };
        responseCallback(res); res.emit("data", Buffer.from("fixture")); res.emit("end");
      });
    };
    options.agent.createConnection(options, (failure, stream) => {
      if (failure) req.destroy(failure); else req.emit("socket", stream);
    });
    if (!proxy) queueMicrotask(() => { if (!req.destroyed) req.emit("socket", state.origin); });
    options.signal?.addEventListener("abort", () => req.destroy(new Error("Synthetic abort")), { once: true });
    return req;
  } };
  state.resolveProxy = () => {
    const stream = state.proxy;
    stream.emit("lookup", null, "203.0.113.3", 4, "proxy.example.test");
    if (stream.destroyed || !stream.connecting) return;
    state.connects++; stream.connecting = false; stream.emit("connect");
  };
  state.secure = () => {
    state.origin.connecting = false; state.origin.authorized = true;
    state.origin.emit("secureConnect");
  };
  return { state, httpsImpl };
}
const webOptions = { method: "GET", maxBytes: 1_000_000 };
const proxyEnv = { HTTPS_PROXY: "http://proxy.example.test:3128" };

test("transport initial authorization failure makes zero HTTPS requests or req.end calls", async () => {
  const { state, httpsImpl } = socketHTTPS();
  const failure = revokedError("CALLER_SPECIFIC_AUTHORITY");
  await assert.rejects(requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { throw failure; },
  }, pin, { env: {}, httpsImpl }), (error) => error === failure);
  assert.equal(state.agents.length, 0);
  assert.equal(state.requests.length, 0); assert.equal(state.ends.length, 0);
});

test("transport rechecks after Agent construction before making any HTTPS request", async () => {
  const failure = revokedError();
  let revoked = false;
  const { state, httpsImpl } = socketHTTPS({ onAgent: () => { revoked = true; } });
  await assert.rejects(requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: {}, httpsImpl }), (error) => error === failure);
  assert.equal(state.requests.length, 0); assert.equal(state.ends.length, 0);
  assert.equal(state.agents[0].destroyed, true);
});

test("transport createConnection checks authority before its underlying connector", async () => {
  const failure = revokedError();
  let revoked = false;
  const { state, httpsImpl } = socketHTTPS({ onRequest: () => { revoked = true; } });
  await assert.rejects(requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: {}, httpsImpl }), (error) => error === failure);
  assert.equal(state.connections.length, 0); assert.equal(state.ends.length, 0);
  assert.equal(state.agents[0].destroyed, true);
});

test("transport proxy DNS boundary revocation prevents connecting, CONNECT and req.end", async () => {
  const failure = revokedError();
  let revoked = false;
  const { state, httpsImpl } = socketHTTPS({ proxy: true });
  const pending = requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: proxyEnv, httpsImpl });
  assert.equal(state.ends.length, 0);
  revoked = true; state.resolveProxy();
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(state.connects, 0); assert.equal(state.writes.length, 0); assert.equal(state.ends.length, 0);
  assert.equal(state.proxy.destroyed, true); assert.equal(state.agents[0].destroyed, true);
});

test("transport async tunnel completion rechecks before assigning the origin socket or req.end", async () => {
  const failure = revokedError("TOOL_DISABLED");
  let revoked = false;
  const { state, httpsImpl } = socketHTTPS({ proxy: true });
  const pending = requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: proxyEnv, httpsImpl });
  state.resolveProxy();
  assert.deepEqual(state.writes, ["SYNTHETIC CONNECT"]);
  revoked = true; state.completeTunnel();
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(state.ends.length, 0);
  assert.equal(state.proxy.destroyed, true); assert.equal(state.origin.destroyed, true);
});

test("transport TLS ready boundary revocation sends no body and remains terminal", async () => {
  const failure = revokedError();
  let revoked = false;
  const { state, httpsImpl } = socketHTTPS();
  const pending = requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: {}, httpsImpl });
  await flush();
  assert.equal(state.ends.length, 0);
  revoked = true; state.secure();
  await assert.rejects(pending, (error) => error === failure);
  revoked = false; state.secure();
  assert.equal(state.ends.length, 0); assert.equal(state.writes.length, 0);
  assert.equal(state.origin.destroyed, true); assert.equal(state.agents[0].destroyed, true);
});

test("transport cancellation while proxy DNS waits sends no later CONNECT or req.end", async () => {
  const controller = new AbortController();
  const { state, httpsImpl } = socketHTTPS({ proxy: true });
  const pending = requestPublicPinnedHTTPS(record.url, {
    ...webOptions, signal: controller.signal, assertAuthorized: () => {},
  }, pin, { env: proxyEnv, httpsImpl });
  controller.abort();
  await assert.rejects(pending, { code: "WEB_NETWORK" });
  state.resolveProxy(); await flush();
  assert.equal(state.connects, 0); assert.equal(state.writes.length, 0); assert.equal(state.ends.length, 0);
  assert.equal(state.proxy.destroyed, true);
});

test("transport rechecks authority before sanitizing an asynchronous request error", async () => {
  const failure = revokedError();
  let revoked = false;
  const { state, httpsImpl } = socketHTTPS();
  const pending = requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: {}, httpsImpl });
  await flush(); revoked = true;
  state.req.emit("error", new Error("Synthetic network failure"));
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(state.ends.length, 0); assert.equal(state.writes.length, 0);
  assert.equal(state.origin.destroyed, true);
});

test("authorized transport waits for TLS and preserves numeric pin, identity and certificate validation", async () => {
  for (const proxy of [false, true]) {
    let checks = 0;
    const { state, httpsImpl } = socketHTTPS({ proxy });
    const pending = requestPublicPinnedHTTPS("https://example.test/path?fixture=1", {
      ...webOptions, assertAuthorized: () => { checks++; }, body: "SYNTHETIC BODY",
    }, pin, { env: proxy ? proxyEnv : {}, httpsImpl });
    await flush();
    assert.equal(state.ends.length, 0);
    if (proxy) { state.resolveProxy(); state.completeTunnel(); }
    else state.secure();
    const output = await pending;
    assert.equal(await output.text(), "fixture");
    assert.deepEqual(state.ends, ["SYNTHETIC BODY"]);
    assert.ok(checks > 3);
    const request = state.requests[0];
    assert.equal(request.hostname, pin.address); assert.equal(request.family, pin.family);
    assert.equal(request.servername, "example.test"); assert.equal(request.headers.host, "example.test");
    assert.equal(request.path, "/path?fixture=1"); assert.equal(request.rejectUnauthorized, true);
    assert.equal(state.agents[0].options.rejectUnauthorized, true);
    assert.deepEqual(state.agents[0].options.proxyEnv, proxy ? { ...proxyEnv, NO_PROXY: "" } : {});
    assert.equal(state.agents[0].destroyed, true);
  }
});

// Exercise Node's real Agent pool and ClientRequest/HTTP parser over a synthetic
// Duplex, rather than relying only on the minimal EventEmitter transport double.
// createConnection never calls net/tls, so neither mode opens a real socket.
function nativeAgentHTTPS(callbackOnly) {
  const state = { writes: [], ends: [], requests: [], agents: [] };
  let responded = false;
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      state.writes.push(Buffer.from(chunk)); done();
      if (!responded) {
        responded = true;
        queueMicrotask(() => {
          if (!stream.destroyed) stream.push("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture");
        });
      }
    },
  });
  Object.assign(stream, { encrypted: true, connecting: !callbackOnly, authorized: callbackOnly });
  for (const name of ["setTimeout", "setNoDelay", "setKeepAlive", "ref", "unref"]) stream[name] = () => stream;
  class Agent extends https.Agent {
    constructor(options) { super(options); state.agents.push(this); }
    createConnection(options, callback) {
      state.connectionOptions = options;
      state.ready = () => {
        stream.connecting = false; stream.authorized = true;
        if (callbackOnly) callback(null, stream);
        else { stream.emit("connect"); stream.emit("secureConnect"); }
      };
      return callbackOnly ? undefined : stream;
    }
    destroy() { this.destroyed = true; super.destroy(); }
  }
  const httpsImpl = { Agent, request(options, callback) {
    state.requests.push(options);
    const req = https.request(options, callback);
    const end = req.end;
    req.end = function (...args) { state.ends.push(args[0]); return end.apply(this, args); };
    return req;
  } };
  return { state, stream, httpsImpl };
}

test("real Node Agent and ClientRequest complete direct and callback-only synthetic socket requests without deadlock", async () => {
  for (const callbackOnly of [false, true]) {
    const { state, stream, httpsImpl } = nativeAgentHTTPS(callbackOnly);
    const pending = requestPublicPinnedHTTPS(record.url, {
      ...webOptions, assertAuthorized: () => {},
    }, pin, { env: callbackOnly ? proxyEnv : {}, httpsImpl });
    await flush();
    assert.equal(state.ends.length, 0); assert.equal(state.writes.length, 0);
    state.ready();
    const reply = await pending;
    assert.equal(reply.status, 200); assert.equal(await reply.text(), "fixture");
    assert.equal(state.ends.length, 1);
    assert.match(Buffer.concat(state.writes).toString(), /^GET \/page HTTP\/1\.1\r\n/);
    assert.equal(state.connectionOptions.host, pin.address);
    assert.equal(state.connectionOptions.servername, "example.test");
    assert.equal(state.connectionOptions.rejectUnauthorized, true);
    assert.equal(state.agents[0].destroyed, true); assert.equal(stream.destroyed, true);
  }
});

test("real Node Agent callback-only asynchronous completion rejects revoked authority before req.end", async () => {
  const { state, stream, httpsImpl } = nativeAgentHTTPS(true);
  const failure = revokedError();
  let revoked = false;
  const pending = requestPublicPinnedHTTPS(record.url, {
    ...webOptions, assertAuthorized: () => { if (revoked) throw failure; },
  }, pin, { env: proxyEnv, httpsImpl });
  await flush(); revoked = true; state.ready();
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(state.ends.length, 0); assert.equal(state.writes.length, 0);
  assert.equal(state.agents[0].destroyed, true); assert.equal(stream.destroyed, true);
});
