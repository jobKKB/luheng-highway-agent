// Bounded functional smoke. --check-source never calls search/extract.
// Live mode is for the already-authorized Windows GitHub Actions job only.
// No transport/resolver/service injection, model call, key, retry, or env mutation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DRIVER = fileURLToPath(import.meta.url);
const QUERY = "IANA example.com reserved domain";
const PAGE = "https://www.iana.org/help/example-domains";
const DECLARED_SOURCE = Object.freeze({
  remoteCommit: "ef1141bc0e79ce36442fad67f5e378c316b3d5f0",
  baseTree: "63b9ff7106e4c5b3062131e37d5f5da9f68237f3",
  note: "Declared parent source; module hashes are the enforced runtime binding. No remote access is performed.",
});
// Filled from the unchanged candidate lib files during offline preparation.
const EXPECTED_SOURCE_HASHES = {
  "lib/agent-authority.mjs": "0932f64a2dc0f99b0f1d051def0b6d084730a2d2582136d77d54ae13648c2cf9",
  "lib/agent-registry.mjs": "ca69299150a3b4c62d833a3ff1276e7defd228e8943917d8ed525779bc0abb73",
  "lib/agent-tools.mjs": "e1d4d33a64b04760350839d4de87cc0a23a42b157ff91b0044d82037513b3730",
  "lib/browser.mjs": "c40e83e9db9b9dea9b6060ef7bd61ae14a6f1697417b737a154bd6623a837b42",
  "lib/controlled-browser.mjs": "7b388d770fed9f37e98a15fd4a21544da18087c558e0d2242318b378ffe6f4b0",
  "lib/engine.mjs": "d97b5af86b0c57a84df975e634197e22ec5de7ce06ac14e1086d337d6cc42137",
  "lib/knowledge-search.mjs": "dea8269a2e5b3ba9feed6ca61f30eb5915aeb89b0a61db0b25e5ab9614238aa3",
  "lib/local-access.mjs": "a33e6318bdeb58f0d15f2f554739e64bf0800e863af971024533d91df7389177",
  "lib/mail-adapter.mjs": "f067a7e3b6a41f5150a3a19a99faacc3f2c5671a8f79d0578fe20365ad7b4ef9",
  "lib/model-transport.mjs": "a2a31ab50fda6bd3802795153a94d7f2126d9f403ce8866d1aecb88df1186f81",
  "lib/model-usage.mjs": "2a28a09421f700437c54f0ddbbba7f8c5b1325f2be130001d5f52a8acbce6a78",
  "lib/model.mjs": "5b99d5997e1012cb9371cec8e80c0fc8e2a25e9ddd728eb5502d6a612d1f00ee",
  "lib/office-artifacts.mjs": "6ff255f7e3d076bd13008d644ba28b9662533243dc02841b23f2100dd48664b8",
  "lib/paths.mjs": "227911dd9447f1eb84d80c863e835d7c1b735e8021aad43fde76d4d128b53d77",
  "lib/persisted-credentials.mjs": "92ad8b241ff105a10b74756d92148c7ad269d01269c64fbb9c49503decf0b2ee",
  "lib/private-directory.mjs": "66322979447481443e666c9af7fdb40b3e9a4eb8d6118786234a56383296d4e2",
  "lib/public-ip.mjs": "5883ee3c4c957466db659638833fd37730f991adbd9e9c71f8df558dbcfc43bc",
  "lib/public-web-transport.mjs": "3587386ead3060fdfebd526f02bb0821ebf3d2d8b259d44c7ac341c081330b72",
  "lib/public-web.mjs": "ddf56a575be0a7c1a8859f6c14574c3261bf40a39c31501f13ccf28de6a347ea",
  "lib/redact.mjs": "75c11ad658981c615c6f56903373d1e4399b403eb6ff9d71d73dba1124db3647",
  "lib/runtime-errors.mjs": "a7c2a95d14e8f05f5a8d88e8380fefd2952fff8a30aefcde1e7295e24bea9718",
  "lib/schedules.mjs": "cfce9bc02df623608c8cabcb9df59baf3ecc7171971408224a37fab6646ee343",
  "lib/skills.mjs": "648bfa00f4cc77290be55de72839cc65cb6ba62cd914b74e1b5d0ea6041682de",
  "lib/store.mjs": "5a8f863490581d974af68dd8103d6e3104ffdb8d4c10f52b4b798302dd4647db",
  "lib/task-outcome.mjs": "9fbd56512ec51a50cb2b77111bb6d9a4573242dfbc25c2c37580a29130a62c07",
  "lib/tool-registry.mjs": "01f31d55c3f2e280b8e0bcc4dc046b402b828676ebf7f62c9b91d649ca93e48e"
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const allowedCodes = new Set([
  "WEB_OK", "WEB_EMPTY", "WEB_NOT_CHECKED", "WEB_INPUT_INVALID", "WEB_POLICY_BLOCKED",
  "WEB_TIMEOUT", "WEB_DNS_UNAVAILABLE", "WEB_NETWORK", "WEB_PROXY_CONFIG",
  "WEB_RATE_LIMITED", "WEB_PROVIDER_FAILURE", "WEB_RESPONSE_INVALID",
  "WEB_RESPONSE_TOO_LARGE", "WEB_REDIRECT_LIMIT", "WEB_CONTENT_UNSUPPORTED",
  "WEB_INTERRUPTED", "CANCELLED", "TOOL_UNAVAILABLE", "TOOL_UNKNOWN",
  "TOOL_RESULT_LIMIT", "TOOL_ARGUMENTS_JSON", "OPERATION_BUDGET",
  "SMOKE_CONTRACT_FAILED", "SMOKE_SOURCE_MISMATCH", "SMOKE_LIVE_CONTEXT_REQUIRED",
  "SMOKE_CLI_INVALID", "SMOKE_RUNTIME_UNSUPPORTED", "SMOKE_DEADLINE",
  "SMOKE_ARTIFACT_FAILED", "SMOKE_CLEANUP_FAILED", "SMOKE_ENV_UNSUPPORTED",
  "SMOKE_REVISION_MISMATCH", "SMOKE_LOCAL_ERROR",
]);
const safeCode = (error) => allowedCodes.has(error?.code) ? error.code
  : error?.code === "ERR_ASSERTION" ? "SMOKE_CONTRACT_FAILED" : "SMOKE_LOCAL_ERROR";
const failure = (code) => Object.assign(new Error(code), { code });
const report = {
  version: 1, kind: "public-web-live-functional-smoke", startedAt: new Date().toISOString(),
  mode: null, status: "preparing", code: null, liveAttempted: false, livePassed: false,
  platform: process.platform, nodeVersion: process.version,
  driverSha256: hash(readFileSync(DRIVER)), source: { declared: DECLARED_SOURCE },
  bounds: { searchCalls: 1, extractCalls: 1, searchResultLimit: 3, extractUrlCount: 1,
    serviceTimeoutMs: 20000, overallAbortMs: 45000, processDeadlineMs: 55000,
    retries: 0, defaultMaxRedirectsPerExtract: 3 },
  inputs: { query: QUERY, urls: [PAGE] }, operations: [],
};
let outputDir, engine, store, tempDir, totalTimer, hardTimer;
const diagnostics = { "exa-mcp": { started: 0, responded: 0, httpStatuses: [] },
  "public-https": { started: 0, responded: 0, httpStatuses: [] } };
const subscriptions = [];

function parseCLI() {
  let checkSource = false, requireWindows = false;
  let sourceRoot = resolve(dirname(DRIVER), "..");
  const args = process.argv.slice(2);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw failure("SMOKE_CLI_INVALID");
    seen.add(arg);
    if (arg === "--check-source") checkSource = true;
    else if (arg === "--require-windows") requireWindows = true;
    else if (["--source-root", "--output-dir"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw failure("SMOKE_CLI_INVALID");
      if (arg === "--source-root") sourceRoot = resolve(value);
      else outputDir = resolve(value);
    } else throw failure("SMOKE_CLI_INVALID");
  }
  if (checkSource === requireWindows) throw failure("SMOKE_CLI_INVALID");
  if (!outputDir) throw failure("SMOKE_CLI_INVALID");
  report.mode = checkSource ? "source-only" : "live-windows-ci";
  return { sourceRoot, checkSource };
}
function persist() {
  if (!outputDir) return;
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "public-web-live-smoke.json"), JSON.stringify(report, null, 2) + "\n");
}
function bindSource(sourceRoot) {
  const files = [];
  for (const [path, expected] of Object.entries(EXPECTED_SOURCE_HASHES)) {
    const bytes = readFileSync(join(sourceRoot, path));
    const actual = hash(bytes);
    // Windows Git may materialize text as CRLF. Retain its exact byte hash;
    // allow only that line-ending conversion when enforcing the LF source lock.
    const canonicalLf = hash(bytes.toString("utf8").replace(/\r\n/g, "\n"));
    files.push({ path, sha256: actual, canonicalLfSha256: canonicalLf,
      matchesExpected: canonicalLf === expected });
  }
  report.source.files = files;
  report.source.expectedHashSetSha256 = hash(JSON.stringify(EXPECTED_SOURCE_HASHES));
  if (files.some((file) => !file.matchesExpected)) throw failure("SMOKE_SOURCE_MISMATCH");
  // Offline Git metadata, never fetch/remote contact or hooks.
  const git = (revision) => execFileSync("git", ["-C", sourceRoot, "rev-parse", "--verify", revision],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  const commit = git("HEAD"), tree = git("HEAD^{tree}");
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw failure("SMOKE_REVISION_MISMATCH");
  report.source.checkoutCommit = commit;
  report.source.checkoutTree = tree;
  report.source.baseTreeMatches = tree === DECLARED_SOURCE.baseTree;
}
function liveContext() {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_OS !== "Windows")
    throw failure("SMOKE_LIVE_CONTEXT_REQUIRED");
  if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || "") || report.source.checkoutCommit !== process.env.GITHUB_SHA)
    throw failure("SMOKE_REVISION_MISMATCH");
  // Refuse preloaded runtime substitutions or disabled TLS; never change them.
  if (process.env.NODE_OPTIONS?.trim() || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw failure("SMOKE_ENV_UNSUPPORTED");
  report.source.githubSha = process.env.GITHUB_SHA;
  report.ci = { githubActions: true, runnerOS: "Windows" };
}
const moduleAt = (root, path) => import(pathToFileURL(join(root, path)).href);
function safeObservation(state) {
  return { provider: ["exa-mcp", "public-https"].includes(state?.provider) ? state.provider : null,
    status: ["unobserved", "available", "unavailable"].includes(state?.status) ? state.status : "invalid",
    code: allowedCodes.has(state?.code) ? state.code : "SMOKE_CONTRACT_FAILED",
    observedAt: validDate(state?.observedAt) ? state.observedAt : null };
}
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function safeResult(result) {
  const results = Array.isArray(result?.results) ? result.results : [];
  return { ok: result?.ok === true, status: ["success", "empty", "unavailable"].includes(result?.status)
    ? result.status : "invalid", code: allowedCodes.has(result?.code) ? result.code : "SMOKE_CONTRACT_FAILED",
    provider: ["exa-mcp", "public-https"].includes(result?.provider) ? result.provider : null,
    retrievedAt: validDate(result?.retrievedAt) ? result.retrievedAt : null,
    untrusted: result?.untrusted === true, resultCount: results.length,
    sources: results.slice(0, 5).map((item) => {
      let origin = null;
      try { const url = new URL(item.url); if (url.protocol === "https:" && !url.username && !url.password) origin = url.origin; } catch {}
      const text = typeof item?.text === "string" ? item.text : "";
      return { origin, textChars: text.length, textSha256: hash(text),
        titleChars: typeof item?.title === "string" ? item.title.length : 0,
        approvedIanaPage: item?.url === PAGE };
    }) };
}
function installDiagnostics() {
  const classify = (request) => {
    const host = request?.getHeader?.("host");
    if (host === "mcp.exa.ai" && request.method === "POST") return "exa-mcp";
    if (["www.iana.org", "iana.org"].includes(host) && request.method === "GET") return "public-https";
    return null;
  };
  for (const [name, listener] of [
    ["http.client.request.start", ({ request }) => {
      const provider = classify(request); if (provider) diagnostics[provider].started++;
    }],
    ["http.client.response.finish", ({ request, response }) => {
      const provider = classify(request);
      if (provider) { diagnostics[provider].responded++; diagnostics[provider].httpStatuses.push(response.statusCode); }
    }],
  ]) {
    const dc = channel(name);
    const guardedListener = (message) => { try { listener(message); } catch {} };
    dc.subscribe(guardedListener);
    subscriptions.push(() => dc.unsubscribe(guardedListener));
  }
  report.actualNodeHttps = diagnostics;
}
function validateSuccess(result, provider, startedAt, endedAt) {
  assert.equal(result?.ok, true);
  assert.equal(result?.status, "success");
  assert.equal(result?.code, "WEB_OK");
  assert.equal(result?.provider, provider);
  assert.equal(result?.untrusted, true);
  assert.ok(validDate(result?.retrievedAt));
  assert.ok(Date.parse(result.retrievedAt) >= startedAt && Date.parse(result.retrievedAt) <= endedAt);
  assert.ok(Array.isArray(result.results) && result.results.length > 0 && result.results.length <= (provider === "exa-mcp" ? 3 : 1));
  assert.ok(result.results.some((source) => typeof source?.text === "string" && source.text.trim()));
  for (const source of result.results) {
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, ""); assert.equal(url.password, "");
    assert.ok(!url.port || url.port === "443");
    assert.equal(typeof source.title, "string");
    assert.equal(typeof source.text, "string");
  }
  const observation = engine.publicWeb.networkState(provider);
  assert.equal(observation.provider, provider);
  assert.equal(observation.status, "available");
  assert.equal(observation.code, "WEB_OK");
  assert.ok(validDate(observation.observedAt));
  assert.ok(Date.parse(observation.observedAt) >= startedAt && Date.parse(observation.observedAt) <= endedAt);
  const capability = engine.toolRegistry.capability(provider === "exa-mcp" ? "public_web_search" : "public_web_extract", engine.toolContext(task));
  assert.equal(capability.status, "available");
  assert.equal(capability.network.status, "reachable");
  assert.equal(capability.network.serviceStatus, "available");
  assert.equal(capability.network.code, "WEB_OK");
  assert.equal(capability.network.lastCheckedAt, observation.observedAt);
}
let task;
async function runOperation(name, args, provider, signal) {
  const startedAt = Date.now();
  const entry = { tool: name, provider, attempted: true, status: "running", code: null };
  report.operations.push(entry);
  let result;
  try {
    // Real registry dispatch and real Engine implementation, with its default service.
    result = await engine.executeAgentTool(task, name, args, signal);
    entry.result = safeResult(result);
    entry.observation = safeObservation(engine.publicWeb.networkState(provider));
    if (result?.ok !== true || result?.status !== "success") {
      entry.status = result?.status === "empty" ? "empty" : "unavailable";
      entry.code = allowedCodes.has(result?.code) ? result.code : "SMOKE_CONTRACT_FAILED";
      return false;
    }
    validateSuccess(result, provider, startedAt, Date.now());
    if (provider === "exa-mcp") {
      assert.ok(result.results.some((source) => /IANA|example\.com|reserved|documentation/i.test(source.text)));
      assert.equal(diagnostics[provider].started, 3);
      assert.equal(diagnostics[provider].responded, 3);
      assert.ok(diagnostics[provider].httpStatuses.every((status) => status >= 200 && status < 300));
    } else {
      const page = result.results[0], url = new URL(page.url);
      assert.ok(["www.iana.org", "iana.org"].includes(url.hostname));
      assert.match(url.pathname, /^\/help\/example-domains\/?$/);
      assert.equal(url.search, "");
      for (const word of [/example\.com/i, /example\.org/i, /documentation/i, /reserved|maintained/i]) assert.match(page.text, word);
      assert.ok(page.title.trim());
      assert.ok(diagnostics[provider].started >= 1 && diagnostics[provider].started <= 4);
      assert.equal(diagnostics[provider].responded, diagnostics[provider].started);
      assert.ok(diagnostics[provider].httpStatuses.at(-1) >= 200 && diagnostics[provider].httpStatuses.at(-1) < 300);
      entry.contentChecks = { exampleCom: true, exampleOrg: true, documentation: true, reservedOrMaintained: true, officialIanaSource: true };
    }
    entry.status = "passed"; entry.code = "WEB_OK";
    return true;
  } catch (error) {
    entry.status = "failed"; entry.code = safeCode(error);
    entry.observation = safeObservation(engine.publicWeb.networkState(provider));
    return false;
  } finally {
    entry.durationMs = Date.now() - startedAt;
    persist();
  }
}

async function main() {
  const { sourceRoot, checkSource } = parseCLI();
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || major === 24 && minor < 5) throw failure("SMOKE_RUNTIME_UNSUPPORTED");
  bindSource(sourceRoot);
  if (!checkSource) liveContext();
  const { AGENT_TOOLS } = await moduleAt(sourceRoot, "lib/agent-tools.mjs");
  const { validateToolArguments } = await moduleAt(sourceRoot, "lib/tool-registry.mjs");
  const { createPublicWebService, PUBLIC_WEB_LIMITS } = await moduleAt(sourceRoot, "lib/public-web.mjs");
  for (const [name, args] of [["public_web_search", { query: QUERY, limit: 3 }], ["public_web_extract", { urls: [PAGE] }]]) {
    const schema = AGENT_TOOLS.find((tool) => tool.function.name === name)?.function.parameters;
    assert.ok(schema); validateToolArguments(args, schema);
  }
  assert.equal(PUBLIC_WEB_LIMITS.timeoutMs, 20000);
  // Default constructor and passive states only; no on-demand connectivity probe.
  const passive = createPublicWebService();
  for (const provider of ["exa-mcp", "public-https"]) assert.deepEqual(passive.networkState(provider),
    { provider, status: "unobserved", code: "WEB_NOT_CHECKED", observedAt: null });
  report.sourceContract = { matchedLibFiles: Object.keys(EXPECTED_SOURCE_HASHES).length,
    explicitPublicInputsMatchSchemas: true, defaultServiceInitialStatesUnobserved: true,
    sourceOnlyNetworkCalls: 0 };
  if (checkSource) {
    report.status = "source_checked"; report.code = "WEB_NOT_CHECKED";
    report.note = "Offline source/argument/passive-state contracts passed. No live request was made; this is not live acceptance.";
    return;
  }
  const [{ Engine }, { Store }, { BrowserBroker }] = await Promise.all([
    moduleAt(sourceRoot, "lib/engine.mjs"), moduleAt(sourceRoot, "lib/store.mjs"), moduleAt(sourceRoot, "lib/browser.mjs"),
  ]);
  tempDir = await mkdtemp(join(tmpdir(), "luheng-public-web-live-"));
  store = new Store(tempDir);
  const actor = { id: "public-web-live-smoke", enabled: true, name: "Public web functional smoke", permissions: ["web.read"] };
  store.put("agents", actor.id, actor);
  // No getKey/completion/publicWebService/resolver/requestImpl/httpsImpl overrides.
  engine = new Engine(store, new BrowserBroker(store));
  // A bounded fixture task uses the real SQLite Store and no model pump.
  task = { id: "public-web-live-smoke", agentId: actor.id, status: "running", prompt: QUERY,
    nonPublicContext: false, budget: 2, budgetUsed: 0, steps: [], toolQueue: [] };
  engine.save(task);
  const context = engine.toolContext(task);
  for (const [name, provider] of [["public_web_search", "exa-mcp"], ["public_web_extract", "public-https"]]) {
    assert.equal(engine.toolRegistry.capability(name, context).status, "available");
    assert.deepEqual(engine.publicWeb.networkState(provider), { provider, status: "unobserved", code: "WEB_NOT_CHECKED", observedAt: null });
  }
  installDiagnostics();
  const controller = new AbortController();
  totalTimer = setTimeout(() => controller.abort(failure("SMOKE_DEADLINE")), report.bounds.overallAbortMs);
  hardTimer = setTimeout(() => {
    report.status = "failed"; report.code = "SMOKE_DEADLINE"; report.livePassed = false;
    report.finishedAt = new Date().toISOString();
    try { persist(); } catch {}
    console.error("Public web live smoke failed: SMOKE_DEADLINE");
    process.exit(1);
  }, report.bounds.processDeadlineMs);
  report.liveAttempted = true;
  const searchPassed = await runOperation("public_web_search", { query: QUERY, limit: 3 }, "exa-mcp", controller.signal);
  // Independent provider check, not a retry/fallback for a failed Exa request.
  const extractPassed = await runOperation("public_web_extract", { urls: [PAGE] }, "public-https", controller.signal);
  assert.equal(task.budgetUsed, 2);
  report.status = searchPassed && extractPassed ? "passed" : "failed";
  report.livePassed = searchPassed && extractPassed;
  report.code = report.livePassed ? "WEB_OK" : report.operations.find((operation) => operation.status !== "passed")?.code || "SMOKE_CONTRACT_FAILED";
  report.note = "Only default registered public-web tool/transport functionality is covered; no model, UI, installer or domestic-network acceptance is implied.";
  if (!report.livePassed) process.exitCode = 1;
}

try { await main(); }
catch (error) { report.status = "failed"; report.code = safeCode(error); report.livePassed = false; process.exitCode = 1; }
finally {
  clearTimeout(totalTimer);
  for (const unsubscribe of subscriptions) unsubscribe();
  try { await engine?.close(); store?.close(); if (tempDir) await rm(tempDir, { recursive: true, force: true }); }
  catch { report.status = "failed"; report.code = "SMOKE_CLEANUP_FAILED"; report.livePassed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  try { persist(); } catch { report.status = "failed"; report.code = "SMOKE_ARTIFACT_FAILED"; process.exitCode = 1; }
  const results = report.operations.map((operation) => `${operation.tool}=${operation.status}/${operation.code}`).join(", ");
  process.stdout.write(JSON.stringify({ mode: report.mode, status: report.status, code: report.code,
    liveAttempted: report.liveAttempted, livePassed: report.livePassed, results,
    checkoutCommit: report.source.checkoutCommit, driverSha256: report.driverSha256 }) + "\n", () => {
      clearTimeout(hardTimer);
      // A timed-out native DNS lookup can outlive its abortable promise. This
      // standalone CI driver terminates only after cleanup and evidence flush.
      if (report.mode === "live-windows-ci") process.exit(process.exitCode || 0);
    });
}
