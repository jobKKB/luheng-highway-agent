import test from "node:test";
import assert from "node:assert/strict";
import { callCompletion, ModelError, modelErrorDiagnostic, validateEndpoint } from "../lib/model.mjs";

const secret = "FAKE_MODEL_KEY_MUST_NEVER_ESCAPE_437b";
const privateDetails = `authorization: Bearer ${secret}; https://user:${secret}@private.example/v1; request body: private prompt`;
const fakeError = (code, cause) => Object.assign(new Error(privateDetails, { cause }), { code });
const options = {
  endpoint: "http://127.0.0.1:1/v1",
  model: "fake-unit-test-model",
  key: secret,
  messages: [{ role: "user", content: "private prompt" }],
  allowTestLocal: true,
};

function assertSafe(result) {
  assert.deepEqual(Object.keys(result).sort(), ["code", "message"]);
  assert.equal(typeof result.code, "string");
  assert.equal(typeof result.message, "string");
  for (const detail of [secret, "Bearer", "authorization", "private.example", "private prompt", "https://user:"])
    assert.ok(!JSON.stringify(result).includes(detail), `diagnostic included forbidden detail: ${detail}`);
}

const categories = {
  MODEL_NETWORK_PROXY: ["ERR_PROXY_TUNNEL"],
  MODEL_NETWORK_DNS: ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA"],
  MODEL_NETWORK_TLS: [
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_SIGNATURE_FAILURE", "CERT_REVOKED",
    "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
    "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  ],
  MODEL_NETWORK_TIMEOUT: ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ERR_TLS_HANDSHAKE_TIMEOUT"],
  MODEL_NETWORK_REFUSED: ["ECONNREFUSED"],
  MODEL_NETWORK_UNREACHABLE: ["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN"],
};

for (const [category, codes] of Object.entries(categories)) {
  test(`sanitized diagnosis classifies ${category} from direct and wrapped codes`, () => {
    for (const code of codes) {
      const direct = modelErrorDiagnostic(fakeError(code));
      const wrapped = modelErrorDiagnostic(new TypeError(privateDetails, { cause: fakeError(code) }));
      assert.equal(direct.code, category);
      assert.deepEqual(wrapped, direct);
      assertSafe(direct);
    }
  });
}

test("classification uses exact codes, never guesses from sensitive exception details", () => {
  for (const error of [
    new Error(`ENOTFOUND TLS ETIMEDOUT ${privateDetails}`),
    fakeError(`ECONNREFUSED ${secret}`),
    fakeError("ECONNRESET"),
    fakeError("ABORT_ERR"),
    null, undefined, secret,
  ]) {
    const result = modelErrorDiagnostic(error);
    assert.equal(result.code, "MODEL_NETWORK");
    assertSafe(result);
  }
  const error = fakeError("ENOTFOUND");
  for (const key of ["message", "stack", "request", "response", "endpoint", "cause"])
    Object.defineProperty(error, key, { get() { throw new Error("must not read sensitive accessor"); } });
  assert.equal(modelErrorDiagnostic(error).code, "MODEL_NETWORK_DNS");
});

test("aggregate causes are bounded, cycle-safe and conservative for mixed failures", () => {
  const same = new AggregateError([fakeError("ENETUNREACH"), fakeError("EHOSTUNREACH")], privateDetails);
  assert.equal(modelErrorDiagnostic(new Error(privateDetails, { cause: same })).code, "MODEL_NETWORK_UNREACHABLE");
  const mixed = new AggregateError([fakeError("ETIMEDOUT"), fakeError("ECONNREFUSED")], privateDetails);
  assert.equal(modelErrorDiagnostic(mixed).code, "MODEL_NETWORK");
  const cyclic = fakeError("ENOTFOUND");
  cyclic.cause = cyclic;
  assert.equal(modelErrorDiagnostic(cyclic).code, "MODEL_NETWORK_DNS");
  let deep = fakeError("ENOTFOUND");
  for (let i = 0; i < 32; i++) deep = new Error(privateDetails, { cause: deep });
  assert.equal(modelErrorDiagnostic(deep).code, "MODEL_NETWORK");
  const wide = new AggregateError([fakeError("ENOTFOUND"), ...Array(15).fill(null), fakeError("ETIMEDOUT")], privateDetails);
  assert.equal(modelErrorDiagnostic(wide).code, "MODEL_NETWORK");
  for (const error of [same, mixed, cyclic, deep, wide]) assertSafe(modelErrorDiagnostic(error));
});

test("ModelError diagnoses canonicalize messages and only allow bounded known codes", () => {
  const codes = [
    "MODEL_ERROR", "KEY_MISSING", "MODEL_MISSING", "ENDPOINT_INVALID", "ENDPOINT_BLOCKED",
    "ENDPOINT_DNS", "CANCELLED", "MODEL_TIMEOUT", "MODEL_RESPONSE", "MODEL_NETWORK", "MODEL_PROXY_CONFIG",
    ...Object.keys(categories), "MODEL_HTTP_301", "MODEL_HTTP_401", "MODEL_HTTP_403",
    "MODEL_HTTP_404", "MODEL_HTTP_429", "MODEL_HTTP_500", "MODEL_HTTP_503",
  ];
  for (const code of codes) {
    const result = modelErrorDiagnostic(new ModelError(privateDetails, code));
    assert.equal(result.code, code);
    assertSafe(result);
  }
  for (const code of [secret, `MODEL_HTTP_401 ${secret}`, "MODEL_HTTP_999", "__proto__", "constructor"]) {
    const result = modelErrorDiagnostic(new ModelError(privateDetails, code));
    assert.equal(result.code, "MODEL_ERROR");
    assertSafe(result);
  }
  assert.match(modelErrorDiagnostic(new ModelError(privateDetails, "MODEL_HTTP_503")).message, /HTTP 503/);
  assert.match(modelErrorDiagnostic(new ModelError(privateDetails, "MODEL_TIMEOUT")).message, /30秒/);
  assert.doesNotMatch(modelErrorDiagnostic(fakeError("ETIMEDOUT")).message, /30秒/);
});

test("fake completion transports expose only sanitized diagnostics and never retry", async () => {
  for (const [category, [code]] of Object.entries(categories)) {
    let calls = 0;
    await assert.rejects(() => callCompletion({
      ...options,
      fetchImpl: async () => { calls++; throw new TypeError(privateDetails, { cause: fakeError(code) }); },
    }), (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.code, category);
      assert.deepEqual({ code: error.code, message: error.message }, modelErrorDiagnostic(fakeError(code)));
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(secret));
      assertSafe({ code: error.code, message: error.message });
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("response-body transport failures are also sanitized", async () => {
  await assert.rejects(() => callCompletion({
    ...options,
    fetchImpl: async () => ({ ok: true, text: async () => { throw fakeError("UND_ERR_BODY_TIMEOUT"); } }),
  }), (error) => {
    assert.equal(error.code, "MODEL_NETWORK_TIMEOUT");
    assertSafe({ code: error.code, message: error.message });
    return true;
  });
});

test("cancellation and explicit request timeout keep their distinct honest messages", async (t) => {
  const controller = new AbortController();
  controller.abort(privateDetails);
  await assert.rejects(() => callCompletion({
    ...options, signal: controller.signal,
    fetchImpl: async () => { throw fakeError("ABORT_ERR"); },
  }), (error) => error.code === "CANCELLED" && error.message === "任务已取消");
  t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(privateDetails));
  await assert.rejects(() => callCompletion({
    ...options,
    fetchImpl: async () => { throw fakeError("ABORT_ERR"); },
  }), (error) => error.code === "MODEL_TIMEOUT" && /30秒/.test(error.message) && !error.message.includes(secret));
});

test("HTTP errors retain status without reading the provider error body", async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await assert.rejects(() => callCompletion({
      ...options,
      fetchImpl: async () => ({ ok: false, status, text: async () => { throw new Error("error bodies must not be read"); } }),
    }), (error) => {
      assert.equal(error.code, `MODEL_HTTP_${status}`);
      assertSafe({ code: error.code, message: error.message });
      return true;
    });
  }
});

test("endpoint policy errors remain enforced before the fake transport is called", async () => {
  for (const endpoint of [
    "http://example.com/v1", `https://user:${secret}@example.com/v1`,
    `https://example.com/v1?key=${secret}`, "https://example.com:8443/v1",
    "https://localhost/v1", "https://test.internal/v1",
  ]) {
    await assert.rejects(() => callCompletion({
      ...options, endpoint, allowTestLocal: false,
      fetchImpl: async () => { assert.fail("blocked endpoints must not reach transport"); },
    }), (error) => {
      assert.ok(["ENDPOINT_INVALID", "ENDPOINT_BLOCKED"].includes(error.code));
      assertSafe(modelErrorDiagnostic(error));
      return true;
    });
  }
  await assert.rejects(() => validateEndpoint(options.endpoint), { code: "ENDPOINT_INVALID" });
});
