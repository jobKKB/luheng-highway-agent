import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPublicWebService, PUBLIC_WEB_LIMITS } from "../lib/public-web.mjs";
import { requestPublicPinnedHTTPS } from "../lib/public-web-transport.mjs";
import { isPublicAddress } from "../lib/public-ip.mjs";

// All fixtures are synthetic. Names use reserved .test domains; the public
// numeric pins are never connected because requestImpl/httpsImpl is injected.
const pin = { address: "93.184.216.34", family: 4 };
const resolver = async () => [pin];
const clock = () => Date.parse("2026-10-03T12:00:00Z");
const record = { url: "https://example.test/road?day=3", title: "Synthetic road report", text: "Public fixture", publishedDate: "2026-10-02" };
const response = (body = "", status = 200, headers = { "content-type": "application/json" }) => ({
  status, headers, text: async () => body, bytesLength: Buffer.byteLength(body),
});
const json = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const event = (id, result) => `event: message\ndata: ${json(id, result)}\n\n`;

function searchFixture({ result = { structuredContent: { results: [record] } },
  initializeResponse, callResponse, notificationResponse, resolverImpl = resolver, timeoutMs,
} = {}) {
  const calls = [];
  const service = createPublicWebService({ resolver: resolverImpl, clock,
    ...(timeoutMs ? { timeoutMs } : {}),
    requestImpl: async (url, options, address) => {
      const packet = JSON.parse(options.body);
      calls.push({ url, options, address, packet });
      if (packet.method === "initialize") return initializeResponse || response(json(1, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "synthetic", version: "1" } }));
      if (packet.method === "notifications/initialized") return notificationResponse || response("", 202, {});
      return callResponse || response(json(2, result));
    },
  });
  return { service, calls };
}

test("search performs bounded keyless MCP initialization, notification, explicit query only", async () => {
  const { service, calls } = searchFixture();
  const output = await service.search({ query: "  public road report  ", limit: 2 });
  assert.deepEqual(output, {
    ok: true, status: "success", code: "WEB_OK", provider: "exa-mcp",
    retrievedAt: "2026-10-03T12:00:00.000Z", results: [{
      url: record.url, title: record.title, text: record.text, publishedAt: "2026-10-02",
    }], untrusted: true,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.packet.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.deepEqual(calls[2].packet.params, { name: "web_search_exa", arguments: { query: "public road report", numResults: 2 } });
  assert.equal(calls[1].packet.id, undefined);
  for (const call of calls) {
    assert.equal(call.url.href, "https://mcp.exa.ai/mcp");
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers.accept, "application/json, text/event-stream");
    assert.equal(call.address.address, pin.address);
    assert.equal(call.options.signal.aborted, false);
    assert.equal(Object.keys(call.options.headers).some((key) => /authorization|cookie|api.key/i.test(key)), false);
  }
});

test("networkState is passive, starts unobserved, holds safe snapshots without query or URLs", async () => {
  const { service, calls } = searchFixture();
  assert.deepEqual(service.networkState(), { status: "unobserved", code: "WEB_NOT_CHECKED", provider: null, observedAt: null });
  service.networkState(); service.networkState();
  assert.equal(calls.length, 0);
  await service.search({ query: "synthetic query" });
  const state = service.networkState();
  assert.deepEqual(state, { status: "available", code: "WEB_OK", provider: "exa-mcp", observedAt: "2026-10-03T12:00:00.000Z" });
  state.status = "tampered";
  assert.equal(service.networkState().status, "available");
  assert.doesNotMatch(JSON.stringify(service.networkState()), /synthetic query|mcp\.exa/);
  assert.equal(calls.length, 3);
});

test("search rejects extra context and invalid query/limit arguments before any DNS or request", async () => {
  let lookups = 0;
  const { service, calls } = searchFixture({ resolverImpl: async () => { lookups++; return [pin]; } });
  for (const args of [null, [], {}, { query: "" }, { query: "\nsecret" }, { query: "x".repeat(1001) },
    { query: "road", limit: 0 }, { query: "road", limit: 6 }, { query: "road", limit: 1.5 },
    { query: "road", limit: "5" }, { query: "road", privateContext: "private fixture" },
  ]) await assert.rejects(service.search(args), { code: "WEB_INPUT_INVALID" });
  assert.equal(lookups, 0); assert.equal(calls.length, 0);
});

test("search supports JSON and SSE, negotiates MCP protocol and keeps session at fixed endpoint", async () => {
  const session = "synthetic-session";
  const { service, calls } = searchFixture({
    initializeResponse: response(event(1, { protocolVersion: "2025-06-18", capabilities: {} }), 200,
      { "content-type": "text/event-stream", "mcp-session-id": session }),
    callResponse: response(': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      event(2, { content: [{ type: "text", text: "Title: Synthetic page\nURL: https://example.test/page\nPublished: 2026-10-02\nAuthor: N/A\nHighlights:\nLine one\nLine two" }] }),
    200, { "content-type": "text/event-stream; charset=utf-8" }),
  });
  const output = await service.search({ query: "road" });
  assert.equal(output.status, "success");
  assert.deepEqual(output.results[0], { url: "https://example.test/page", title: "Synthetic page", text: "Line one\nLine two", publishedAt: "2026-10-02" });
  assert.equal(calls[0].options.headers["mcp-session-id"], undefined);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers["mcp-session-id"], session);
    assert.equal(call.options.headers["mcp-protocol-version"], "2025-06-18");
  }
  assert.doesNotMatch(JSON.stringify(output), /synthetic-session|Author:|progress/);
});

test("search handles current Exa blocks, text JSON, dates, duplicates, and result limits", async () => {
  const formatted = "Title: First\nURL: https://example.test/a\nPublished: N/A\nAuthor: Someone\nText: First text\n\n---\n\nTitle: Second\nURL: https://example.test/b\nPublished: 2026-10-01T10:20:30Z\nHighlights:\nSecond text";
  let fixture = searchFixture({ result: { content: [{ type: "text", text: formatted }] } });
  let output = await fixture.service.search({ query: "road", limit: 1 });
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].text, "First text");
  assert.equal(Object.hasOwn(output.results[0], "publishedAt"), false);
  fixture = searchFixture({ result: { content: [{ type: "text", text: JSON.stringify({ results: [record, record] }) }] } });
  output = await fixture.service.search({ query: "road" });
  assert.equal(output.results.length, 1);
});

test("genuine empty results are distinct from unavailable, never fabricated", async () => {
  for (const result of [{ structuredContent: { results: [] } },
    { content: [{ type: "text", text: "No search results found. Please try a different query." }] },
    { content: [{ type: "text", text: '{"results":[]}' }] },
  ]) {
    const { service } = searchFixture({ result });
    const output = await service.search({ query: "road" });
    assert.equal(output.ok, true); assert.equal(output.status, "empty");
    assert.equal(output.code, "WEB_EMPTY"); assert.deepEqual(output.results, []);
  }
});

test("429 and provider tool rate limits return safe unavailable with no retry", async () => {
  let fixture = searchFixture({ initializeResponse: response("sensitive provider detail", 429, {}) });
  let output = await fixture.service.search({ query: "road" });
  assert.equal(output.code, "WEB_RATE_LIMITED"); assert.equal(output.status, "unavailable");
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.service.networkState().status, "unavailable");
  fixture = searchFixture({ result: { isError: true, content: [{ type: "text", text: "429 rate limit private provider detail" }] } });
  output = await fixture.service.search({ query: "road" });
  assert.equal(output.code, "WEB_RATE_LIMITED");
  assert.doesNotMatch(JSON.stringify(output), /private provider/);
});

test("HTTP/provider failures and malformed RPC/SSE fail closed and do not echo content", async () => {
  for (const callResponse of [
    response("private detail", 503), response("{malformed private detail"),
    response(json(99, {})), response('{"jsonrpc":"2.0","id":2,"result":{},"error":{}}'),
    response('{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"private detail"}}'),
    response('event: message\ndata: {private detail}\n\n', 200, { "content-type": "text/event-stream" }),
    response(event(2, {}) + event(2, {}), 200, { "content-type": "text/event-stream" }),
    response(event(2, {}).trim(), 200, { "content-type": "text/event-stream" }),
    response(json(2, {}), 200, { "content-type": "text/html" }),
    response(json(2, { content: [{ type: "text", text: "unrecognized private detail" }] })),
  ]) {
    const { service } = searchFixture({ callResponse });
    const output = await service.search({ query: "road" });
    assert.equal(output.ok, false); assert.equal(output.status, "unavailable");
    assert.deepEqual(output.results, []); assert.doesNotMatch(JSON.stringify(output), /private detail/);
  }
});

test("malformed protocol/session/initialized response prevents tools call", async () => {
  for (const initializeResponse of [
    response(json(1, { protocolVersion: "2099-01-01" })),
    response(json(1, { protocolVersion: "2025-03-26" }), 200, { "content-type": "application/json", "mcp-session-id": "bad\r\nvalue" }),
    response(json(1, { protocolVersion: "2025-03-26" }), 200, { "content-type": "application/json", "mcp-session-id": "x".repeat(513) }),
  ]) {
    const { service, calls } = searchFixture({ initializeResponse });
    assert.equal((await service.search({ query: "road" })).code, "WEB_RESPONSE_INVALID");
    assert.equal(calls.length, 1);
  }
  const { service, calls } = searchFixture({ notificationResponse: response("provider detail", 200) });
  assert.equal((await service.search({ query: "road" })).code, "WEB_RESPONSE_INVALID");
  assert.equal(calls.length, 2);
});

test("public address policy covers private, metadata, mapped/translation/transition ranges", async () => {
  const blocked = ["0.0.0.0", "10.1.2.3", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "198.18.0.1", "192.0.2.1", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1", "fe80::1", "fc00::1", "3fff::1"];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, address);
    const { service, calls } = searchFixture({ resolverImpl: async () => [pin, { address, family: address.includes(":") ? 6 : 4 }] });
    await assert.rejects(service.search({ query: "road" }), { code: "WEB_POLICY_BLOCKED" });
    assert.equal(calls.length, 0, address);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("each MCP request revalidates every DNS result and rebinding stops before next request", async () => {
  let lookups = 0;
  const { service, calls } = searchFixture({ resolverImpl: async (host, options) => {
    assert.equal(host, "mcp.exa.ai"); assert.deepEqual(options, { all: true, verbatim: true });
    return ++lookups === 1 ? [pin] : [{ address: "127.0.0.1", family: 4 }];
  } });
  await assert.rejects(service.search({ query: "road" }), { code: "WEB_POLICY_BLOCKED" });
  assert.equal(lookups, 2); assert.equal(calls.length, 1);
});

test("DNS failures are observed unavailable without pretending the HTTP provider failed", async () => {
  const { service, calls } = searchFixture({ resolverImpl: async () => {
    throw Object.assign(new Error("private DNS detail"), { code: "EAI_AGAIN" });
  } });
  const output = await service.search({ query: "road" });
  assert.equal(output.code, "WEB_DNS_UNAVAILABLE"); assert.equal(output.status, "unavailable");
  assert.equal(calls.length, 0); assert.equal(service.networkState().status, "unavailable");
  assert.equal(service.networkState().code, "WEB_DNS_UNAVAILABLE");
  assert.equal(service.networkState("public-https").status, "unobserved");
  assert.doesNotMatch(JSON.stringify(output), /private DNS/);
});

test("provider-scoped passive observations cannot conflate extraction with Exa connectivity", async () => {
  let calls = 0;
  const service = createPublicWebService({ resolver, clock, requestImpl: async () => { calls++; return htmlResponse("<p>Public fixture</p>"); } });
  assert.equal(service.networkState("exa-mcp").status, "unobserved");
  await service.extract({ urls: ["https://example.test/"] });
  assert.equal(service.networkState().provider, "public-https");
  assert.equal(service.networkState("public-https").status, "available");
  assert.equal(service.networkState("exa-mcp").status, "unobserved");
  assert.throws(() => service.networkState("arbitrary-provider"), { code: "WEB_INPUT_INVALID" });
  assert.equal(calls, 1);
});

test("empty DNS answers are unavailable but private DNS policy rejects do not claim provider failure", async () => {
  const fixture = searchFixture({ resolverImpl: async () => [] });
  assert.equal((await fixture.service.search({ query: "road" })).code, "WEB_DNS_UNAVAILABLE");
  assert.equal(fixture.service.networkState("exa-mcp").code, "WEB_DNS_UNAVAILABLE");
  assert.equal(fixture.calls.length, 0);
  const blocked = searchFixture({ resolverImpl: async () => [{ address: "10.0.0.1", family: 4 }] });
  await assert.rejects(blocked.service.search({ query: "road" }), { code: "WEB_POLICY_BLOCKED" });
  assert.equal(blocked.service.networkState().status, "unobserved");
});

test("cancellation before and during requests is terminal with no subsequent MCP call", async () => {
  const controller = new AbortController(); controller.abort();
  const { service, calls } = searchFixture();
  await assert.rejects(service.search({ query: "road" }, { signal: controller.signal }), { code: "CANCELLED" });
  assert.equal(calls.length, 0); assert.equal(service.networkState().status, "unobserved");
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let requests = 0;
  const active = new AbortController();
  const pending = createPublicWebService({ resolver, clock, requestImpl: async (_url, options) => {
    requests++; started();
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("private cancellation detail")), { once: true }));
  } });
  const task = pending.search({ query: "road" }, { signal: active.signal });
  await ready; active.abort();
  await assert.rejects(task, { code: "CANCELLED" });
  assert.equal(requests, 1);
});

test("timeout bounds unresponsive DNS, request, and response body without polling or retry", async () => {
  for (const stage of ["dns", "request", "body"]) {
    let requests = 0;
    const service = createPublicWebService({ clock, timeoutMs: 10,
      resolver: stage === "dns" ? () => new Promise(() => {}) : resolver,
      requestImpl: async () => { requests++; return stage === "request" ? new Promise(() => {}) : { status: 200, headers: {}, text: () => new Promise(() => {}) }; },
    });
    const output = await service.search({ query: "road" });
    assert.equal(output.code, "WEB_TIMEOUT", stage);
    assert.equal(output.status, "unavailable", stage);
    assert.equal(requests, stage === "dns" ? 0 : 1);
  }
});

test("network exception details and unknown codes cannot leak into results", async () => {
  const service = createPublicWebService({ resolver, clock, requestImpl: async () => {
    throw Object.assign(new Error("https://secret:password@private.test secret-token"), { code: "SECRET_TOKEN" });
  } });
  const output = await service.search({ query: "road" });
  assert.equal(output.code, "WEB_NETWORK");
  assert.doesNotMatch(JSON.stringify(output), /secret|password|private\.test/i);
  assert.equal(service.networkState().code, "WEB_NETWORK");
});

test("search caps complete serialized results and response bytes", async () => {
  const huge = Array.from({ length: 20 }, (_, index) => ({ ...record, url: `https://example.test/${index}`, text: '"\\\n'.repeat(15000), title: "t".repeat(1000) }));
  let fixture = searchFixture({ result: { structuredContent: { results: huge } } });
  let output = await fixture.service.search({ query: "road" });
  assert.equal(output.status, "success");
  assert.ok(output.results.length <= 5);
  assert.ok(JSON.stringify(output.results).length <= 30000);
  assert.ok(output.results.every((item) => item.title.length <= 300));
  fixture = searchFixture({ callResponse: response("x".repeat(2_000_001)) });
  output = await fixture.service.search({ query: "road" });
  assert.equal(output.code, "WEB_RESPONSE_TOO_LARGE");
  assert.ok(fixture.calls[2].options.maxBytes < 2_000_000);
});

test("search source links omit fragments and reject private/credential/HTTP links without following them", async () => {
  const { service, calls } = searchFixture({ result: { structuredContent: { results: [
    { ...record, url: "https://127.0.0.1/private" }, { ...record, url: "https://user:pass@example.test/" },
    { ...record, url: "http://example.test/" }, { ...record, url: "https://example.test/valid#fragment" },
  ] } } });
  const output = await service.search({ query: "road" });
  assert.equal(output.results.length, 1); assert.equal(output.results[0].url, "https://example.test/valid");
  assert.equal(calls.length, 3);
});

function extractionFixture(responses, overrides = {}) {
  const calls = [];
  const service = createPublicWebService({ resolver, clock, ...overrides,
    requestImpl: async (url, options, address) => {
      calls.push({ url, options, address });
      return typeof responses === "function" ? responses(url, calls.length) : responses[calls.length - 1];
    },
  });
  return { service, calls };
}
const htmlResponse = (text, status = 200, headers = {}) => response(text, status, { "content-type": "text/html; charset=utf-8", ...headers });

test("extract allows only bounded HTTPS443 URL lists and validates the whole list first", async () => {
  const { service, calls } = extractionFixture([]);
  for (const urls of [[], Array(6).fill("https://example.test/"), ["http://example.test/"],
    ["https://example.test:8443/"], ["https://user:pass@example.test/"], ["https://user%40name@example.test/"],
    ["https://127.1/"], ["https://0x7f000001/"], ["https://[::ffff:127.0.0.1]/"],
    ["https://localhost/"], ["https://localhost./"], ["https://metadata.google.internal/"],
    ["https://example.local/"], ["https://singlelabel/"], ["https://example.test/\nsecret"],
    ["https://example.test\\@127.0.0.1/"], ["https://example.test/", "https://192.168.0.1/"],
  ]) await assert.rejects(service.extract({ urls }), (error) => ["WEB_INPUT_INVALID", "WEB_POLICY_BLOCKED"].includes(error.code));
  await assert.rejects(service.extract({ urls: "https://example.test/" }), { code: "WEB_INPUT_INVALID" });
  await assert.rejects(service.extract({ urls: ["https://example.test/"], cookie: "private" }), { code: "WEB_INPUT_INVALID" });
  assert.equal(calls.length, 0);
});

test("extract strips scripts/styles/comments and decodes entities with untrusted metadata", async () => {
  const { service, calls } = extractionFixture([htmlResponse(`<!doctype html><html><head>
    <!-- <title>Wrong title</title><meta name="date" content="2000-01-01"> -->
    <title>Road &amp; &quot;Bridge&quot;</title><meta content="2026-10-02T12:34:56Z" property="article:published_time">
    <script>secret-script</script><style>secret-style</style></head>
    <body><!-- secret-comment --><h1>Road &amp; Bridge</h1><p>Open&nbsp;today &#x4e2d;&#25991; &lt;safe&gt;</p>
    <script src="private">secret-script-2</script><style>secret-style-2</style><template>secret-template</template></body></html>`)]);
  const output = await service.extract({ urls: ["https://example.test/road?today=true#anchor"] });
  assert.equal(output.status, "success"); assert.equal(output.untrusted, true);
  assert.deepEqual(output.results[0], {
    url: "https://example.test/road?today=true", title: 'Road & "Bridge"',
    text: "Road & Bridge Open today 中文 <safe>", publishedAt: "2026-10-02T12:34:56Z",
  });
  assert.equal(calls[0].options.method, "GET"); assert.equal(calls[0].options.body, undefined);
  assert.equal(Object.keys(calls[0].options.headers).some((key) => /authorization|cookie/i.test(key)), false);
});

test("extract handles plain text, time datetime, empty pages and unsupported binary", async () => {
  let fixture = extractionFixture([response(" Public fixture ", 200, { "content-type": "text/plain" })]);
  let output = await fixture.service.extract({ urls: ["https://example.test/"] });
  assert.equal(output.results[0].text, "Public fixture"); assert.equal(output.results[0].title, "");
  fixture = extractionFixture([htmlResponse('<body><time datetime="2026-10-01">Yesterday</time><script>unterminated private script')]);
  output = await fixture.service.extract({ urls: ["https://example.test/"] });
  assert.equal(output.results[0].publishedAt, "2026-10-01"); assert.equal(output.results[0].text, "Yesterday");
  fixture = extractionFixture([htmlResponse("<script>ignored</script><style>ignored</style><!-- ignored -->")]);
  output = await fixture.service.extract({ urls: ["https://example.test/"] });
  assert.equal(output.status, "empty"); assert.deepEqual(output.results, []);
  fixture = extractionFixture([response("%PDF-private fixture", 200, { "content-type": "application/pdf" })]);
  output = await fixture.service.extract({ urls: ["https://example.test/"] });
  assert.equal(output.code, "WEB_CONTENT_UNSUPPORTED"); assert.deepEqual(output.results, []);
});

test("extract follows at most three manual redirects, revalidates every hop, keeps query and pins DNS", async () => {
  let lookups = 0;
  const fixture = extractionFixture([
    htmlResponse("", 302, { location: "/second?step=2" }),
    htmlResponse("", 307, { location: "https://other.test/third?step=3" }),
    htmlResponse("", 303, { location: "./last?step=4" }), htmlResponse("<p>Final fixture</p>"),
  ], { resolver: async () => { lookups++; return [pin]; } });
  const output = await fixture.service.extract({ urls: ["https://example.test/first"] });
  assert.equal(output.results[0].url, "https://other.test/last?step=4");
  assert.equal(fixture.calls.length, 4); assert.equal(lookups, 4);
  assert.ok(fixture.calls.every((call) => call.address.address === pin.address && call.options.method === "GET"));
  const looping = extractionFixture(() => htmlResponse("", 302, { location: "/loop" }));
  assert.equal((await looping.service.extract({ urls: ["https://example.test/"] })).code, "WEB_REDIRECT_LIMIT");
  assert.equal(looping.calls.length, 2);
  const tooMany = extractionFixture((_url, index) => htmlResponse("", 302, { location: `/step-${index}` }));
  assert.equal((await tooMany.service.extract({ urls: ["https://example.test/"] })).code, "WEB_REDIRECT_LIMIT");
  assert.equal(tooMany.calls.length, 4);
});

test("private, credential, non-HTTPS redirect targets are terminal without second request", async () => {
  for (const location of ["https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "https://[64:ff9b::7f00:1]/", "http://example.test/", "https://user:password@example.test/", "https://example.test:444/", "https://private.internal/", "https://example.test/\r\nsecret"]) {
    const { service, calls } = extractionFixture([htmlResponse("", 302, { location })]);
    await assert.rejects(service.extract({ urls: ["https://example.test/"] }), { code: "WEB_POLICY_BLOCKED" });
    assert.equal(calls.length, 1, location);
  }
});

test("redirect DNS rebinding and mixed public/private answers stop before unsafe request", async () => {
  let lookups = 0;
  const fixture = extractionFixture([htmlResponse("", 302, { location: "/again" })], { resolver: async () => ++lookups === 1 ? [pin] : [pin, { address: "10.0.0.1", family: 4 }] });
  await assert.rejects(fixture.service.extract({ urls: ["https://example.test/"] }), { code: "WEB_POLICY_BLOCKED" });
  assert.equal(fixture.calls.length, 1);
});

test("extract enforces 1MB per response, 2MB combined responses and serialized text cap", async () => {
  let fixture = extractionFixture([htmlResponse("x".repeat(1_000_001))]);
  assert.equal((await fixture.service.extract({ urls: ["https://example.test/"] })).code, "WEB_RESPONSE_TOO_LARGE");
  fixture = extractionFixture(() => htmlResponse("x".repeat(950_000)));
  const output = await fixture.service.extract({ urls: ["https://one.test/", "https://two.test/", "https://three.test/"] });
  assert.equal(output.code, "WEB_RESPONSE_TOO_LARGE"); assert.deepEqual(output.results, []);
  assert.equal(fixture.calls[0].options.maxBytes, 1_000_000);
  assert.equal(fixture.calls[2].options.maxBytes, 100_000);
  fixture = extractionFixture(() => htmlResponse('"'.repeat(200_000)));
  const bounded = await fixture.service.extract({ urls: ["https://one.test/", "https://two.test/"] });
  assert.equal(bounded.status, "success"); assert.ok(JSON.stringify(bounded.results).length <= PUBLIC_WEB_LIMITS.maxResultChars);
});

test("redirect body bytes count against aggregate budget and compressed responses fail closed", async () => {
  const fixture = extractionFixture([htmlResponse("x".repeat(900_000), 302, { location: "/second" }),
    htmlResponse("x".repeat(900_000), 302, { location: "/third" }), htmlResponse("x".repeat(200_001))]);
  const output = await fixture.service.extract({ urls: ["https://example.test/"] });
  assert.equal(output.code, "WEB_RESPONSE_TOO_LARGE"); assert.equal(fixture.calls[2].options.maxBytes, 200_000);
  const compressed = extractionFixture([htmlResponse("compressed fixture", 200, { "content-encoding": "gzip" })]);
  assert.equal((await compressed.service.extract({ urls: ["https://example.test/"] })).code, "WEB_CONTENT_UNSUPPORTED");
});

function fakeHTTPS({ status = 200, headers = { "content-type": "text/html" }, chunks = [Buffer.from("fixture")], failure, aborted = false, hold = false } = {}) {
  const state = { agents: [], requests: [], bodies: [] };
  class Agent {
    constructor(options) { this.options = options; state.agents.push(this); }
    destroy() { this.destroyed = true; }
  }
  return { state, Agent, request(options, callback) {
    state.requests.push(options);
    const req = new EventEmitter();
    req.destroy = (error) => { req.destroyed = true; req.emit("error", error); };
    req.end = (body) => { state.bodies.push(body); queueMicrotask(() => {
      if (failure) { req.emit("error", failure); return; }
      if (options.signal?.aborted) { req.destroy(new Error("private abort")); return; }
      if (hold) return;
      const res = new EventEmitter(); res.statusCode = status; res.headers = headers; callback(res);
      if (aborted) { res.emit("aborted"); return; }
      for (const chunk of chunks) res.emit("data", chunk);
      res.emit("end");
    }); };
    options.signal?.addEventListener("abort", () => req.destroy(new Error("private abort")), { once: true });
    return req;
  } };
}
const webOptions = { method: "GET", maxBytes: 1_000_000 };

test("web transport pins direct/proxy IP and TLS identity, preserves query, never follows redirects", async () => {
  const proxy = "http://synthetic-user:synthetic-password@proxy.example.test:3128";
  const httpsImpl = fakeHTTPS({ status: 302, headers: { location: "https://127.0.0.1/", "set-cookie": "secret-cookie" } });
  const reply = await requestPublicPinnedHTTPS("https://example.test/path?today=3", {
    ...webOptions, headers: { Host: "wrong", Cookie: "secret-cookie", Authorization: "Bearer secret",
      "Proxy-Authorization": "proxy-secret", "x-api-key": "private-key", accept: "text/html" }, rejectUnauthorized: false,
  }, pin, { env: { HTTPS_PROXY: proxy, NO_PROXY: pin.address }, httpsImpl });
  assert.equal(reply.status, 302); assert.equal(await reply.text(), "fixture");
  assert.deepEqual(reply.headers, { location: "https://127.0.0.1/" });
  assert.equal(httpsImpl.state.requests.length, 1);
  const request = httpsImpl.state.requests[0];
  assert.equal(request.hostname, pin.address); assert.equal(request.family, 4);
  assert.equal(request.servername, "example.test"); assert.equal(request.headers.host, "example.test");
  assert.equal(request.path, "/path?today=3"); assert.equal(request.rejectUnauthorized, true);
  assert.equal(request.headers["accept-encoding"], "identity");
  assert.equal(Object.keys(request.headers).some((key) => /authorization|cookie|api.key/i.test(key)), false);
  assert.deepEqual(httpsImpl.state.agents[0].options.proxyEnv, { HTTPS_PROXY: proxy, NO_PROXY: "" });
  assert.equal(httpsImpl.state.agents[0].options.rejectUnauthorized, true);
  assert.equal(httpsImpl.state.agents[0].destroyed, true);
});

test("web transport forwards AbortSignal and closes its per-request Agent when cancelled", async () => {
  const controller = new AbortController();
  const httpsImpl = fakeHTTPS({ hold: true });
  const pending = requestPublicPinnedHTTPS("https://example.test/", { ...webOptions, signal: controller.signal }, pin, { env: {}, httpsImpl });
  assert.equal(httpsImpl.state.requests[0].signal, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: "WEB_NETWORK" });
  assert.equal(httpsImpl.state.agents[0].destroyed, true);
});

test("web transport honors original-host proxy bypass and public IPv6 pin", async () => {
  const httpsImpl = fakeHTTPS();
  await requestPublicPinnedHTTPS("https://example.test/", webOptions, { address: "2606:4700:4700::1111", family: 6 }, {
    env: { HTTPS_PROXY: "http://proxy.example.test:3128", NO_PROXY: "example.test" }, httpsImpl,
  });
  assert.deepEqual(httpsImpl.state.agents[0].options.proxyEnv, {});
  assert.equal(httpsImpl.state.requests[0].hostname, "2606:4700:4700::1111");
  assert.equal(httpsImpl.state.requests[0].family, 6);
});

test("web transport rejects unsafe pins/URLs/methods/budgets before constructing Agent", async () => {
  const httpsImpl = fakeHTTPS();
  for (const [url, options, address] of [
    ["http://example.test/", webOptions, pin], ["https://user:pass@example.test/", webOptions, pin],
    ["https://example.test:8443/", webOptions, pin], ["https://example.test/#anchor", webOptions, pin],
    ["https://example.test/", webOptions, { address: "127.0.0.1", family: 4 }],
    ["https://example.test/", webOptions, { address: "rebind.test", family: 4 }],
    ["https://example.test/", webOptions, { address: pin.address, family: 6 }],
    ["https://example.test/", { method: "DELETE", maxBytes: 100 }, pin],
    ["https://example.test/", { method: "GET", maxBytes: 2_000_001 }, pin],
  ]) await assert.rejects(requestPublicPinnedHTTPS(url, options, address, { env: {}, httpsImpl }), { code: "WEB_POLICY_BLOCKED" });
  assert.equal(httpsImpl.state.agents.length, 0); assert.equal(httpsImpl.state.requests.length, 0);
});

test("web transport response bounds, content length, interruptions and proxy failures are sanitized", async () => {
  for (const [settings, expected] of [
    [{ chunks: [Buffer.alloc(1_000_001)] }, "WEB_RESPONSE_TOO_LARGE"],
    [{ headers: { "content-length": "1000001" } }, "WEB_RESPONSE_TOO_LARGE"],
    [{ failure: Object.assign(new Error("private proxy credentials"), { code: "ECONNREFUSED" }) }, "WEB_NETWORK"],
    [{ aborted: true }, "WEB_NETWORK"],
  ]) {
    const httpsImpl = fakeHTTPS(settings);
    await assert.rejects(requestPublicPinnedHTTPS("https://example.test/", webOptions, pin, { env: {}, httpsImpl }), (error) => {
      assert.equal(error.code, expected); assert.doesNotMatch(error.message, /private proxy/); return true;
    });
    assert.equal(httpsImpl.state.agents[0].destroyed, true);
  }
  const httpsImpl = fakeHTTPS();
  await assert.rejects(requestPublicPinnedHTTPS("https://example.test/", webOptions, pin, {
    env: { HTTPS_PROXY: "http://private-user:private-password@" }, httpsImpl,
  }), (error) => { assert.equal(error.code, "WEB_PROXY_CONFIG"); assert.doesNotMatch(error.message, /private-user|private-password/); return true; });
  assert.equal(httpsImpl.state.agents.length, 0);
});
