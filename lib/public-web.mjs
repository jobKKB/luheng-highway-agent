import dns from "node:dns/promises";
import net from "node:net";
import { isPublicAddress } from "./public-ip.mjs";
import { requestPublicPinnedHTTPS } from "./public-web-transport.mjs";

export const PUBLIC_WEB_LIMITS = Object.freeze({
  maxResults: 5, maxQueryChars: 1000, maxUrlChars: 2048,
  maxResponseBytes: 2_000_000, maxPageBytes: 1_000_000,
  maxResultChars: 30_000, maxRedirects: 3, timeoutMs: 20_000,
});
const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";
const VERSION = "2025-03-26";
const PROTOCOLS = new Set([VERSION, "2025-06-18", "2025-11-25"]);
const TERMINAL = new Set(["WEB_INPUT_INVALID", "WEB_POLICY_BLOCKED", "CANCELLED"]);
const messages = {
  WEB_INPUT_INVALID: "公网检索参数无效",
  WEB_POLICY_BLOCKED: "公网地址违反安全策略，禁止访问私有、回环或保留网络",
  CANCELLED: "任务已取消",
};

export class PublicWebError extends Error {
  constructor(code) { super(messages[code] || "公网检索暂不可用"); this.name = "PublicWebError"; this.code = code; }
}
const fail = (code) => { throw new PublicWebError(code); };
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);

function publicURL(value) {
  if (typeof value !== "string" || !value || value.length > PUBLIC_WEB_LIMITS.maxUrlChars ||
      /[\s\u0000-\u001f\u007f\\]/u.test(value)) fail("WEB_INPUT_INVALID");
  let url;
  try { url = new URL(value); } catch { fail("WEB_INPUT_INVALID"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") ||
      url.username || url.password) fail("WEB_POLICY_BLOCKED");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const canonical = host.replace(/\.$/, "");
  if (!canonical || canonical === "localhost" || !canonical.includes(".") && !net.isIP(canonical) ||
      [".localhost", ".local", ".internal", ".home", ".lan"].some((suffix) => canonical.endsWith(suffix)) ||
      net.isIP(canonical) && !isPublicAddress(canonical)) fail("WEB_POLICY_BLOCKED");
  url.hash = "";
  return url;
}

function validateArgs(args, kind) {
  if (!plain(args) || Object.keys(args).some((key) => !(
    kind === "search" ? ["query", "limit"] : ["urls"]
  ).includes(key))) fail("WEB_INPUT_INVALID");
  if (kind === "search") {
    if (typeof args.query !== "string" || !args.query.trim() ||
        args.query.length > PUBLIC_WEB_LIMITS.maxQueryChars || /[\u0000-\u001f\u007f]/u.test(args.query)) fail("WEB_INPUT_INVALID");
    const limit = args.limit === undefined ? PUBLIC_WEB_LIMITS.maxResults : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > PUBLIC_WEB_LIMITS.maxResults) fail("WEB_INPUT_INVALID");
    return { query: args.query.trim(), limit };
  }
  if (!Array.isArray(args.urls) || args.urls.length < 1 || args.urls.length > PUBLIC_WEB_LIMITS.maxResults) fail("WEB_INPUT_INVALID");
  // Validate the entire requested set before any transmission.
  return { urls: args.urls.map(publicURL) };
}

async function abortable(promise, signal) {
  if (signal.aborted) throw signal.reason;
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener("abort", listener, { once: true });
    })]);
  } finally { if (listener) signal.removeEventListener("abort", listener); }
}

function header(response, name) {
  const headers = response?.headers;
  if (headers?.get) return headers.get(name) || "";
  if (plain(headers)) {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return typeof entry?.[1] === "string" ? entry[1] : "";
  }
  return "";
}
function httpCode(status) { return status === 429 ? "WEB_RATE_LIMITED" : "WEB_PROVIDER_FAILURE"; }

function parseRPC(text, type, id) {
  const packets = [];
  const parse = (value) => {
    let packet;
    try { packet = JSON.parse(value); } catch { fail("WEB_RESPONSE_INVALID"); }
    if (Array.isArray(packet)) packets.push(...packet); else packets.push(packet);
    if (packets.length > 256) fail("WEB_RESPONSE_INVALID");
  };
  if (/^application\/json(?:\s*;|$)/i.test(type)) parse(text);
  else if (/^text\/event-stream(?:\s*;|$)/i.test(type)) {
    const normalized = text.replace(/\r\n|\r/g, "\n");
    const events = normalized.split("\n\n");
    if (events.length > 256) fail("WEB_RESPONSE_INVALID");
    // SSE dispatches only complete events; a truncated last event is invalid.
    if (events.at(-1)?.trim()) fail("WEB_RESPONSE_INVALID");
    for (const event of events) {
      const data = event.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) parse(data);
    }
  } else fail("WEB_RESPONSE_INVALID");
  const matches = packets.filter((packet) => plain(packet) && packet.id === id);
  if (matches.length !== 1 || matches[0].jsonrpc !== "2.0" ||
      Object.hasOwn(matches[0], "result") === Object.hasOwn(matches[0], "error")) fail("WEB_RESPONSE_INVALID");
  if (Object.hasOwn(matches[0], "error")) fail("WEB_PROVIDER_FAILURE");
  if (!plain(matches[0].result)) fail("WEB_RESPONSE_INVALID");
  return matches[0].result;
}

function publishedDate(value) {
  if (typeof value !== "string" || value.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}
function sourceURL(value) {
  try { return publicURL(value).href; } catch { return null; }
}
const clean = (value, limit) => typeof value === "string"
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, limit) : "";

function appendResult(results, source, limit) {
  if (results.length >= limit) return;
  const url = sourceURL(source?.url);
  if (!url || results.some((item) => item.url === url)) return;
  const result = { url, title: clean(source.title, 300), text: clean(source.text, PUBLIC_WEB_LIMITS.maxResultChars) };
  const date = publishedDate(source.publishedAt ?? source.publishedDate);
  if (date) result.publishedAt = date;
  // Account for JSON escaping and metadata, not merely visible text length.
  while (JSON.stringify([...results, result]).length > PUBLIC_WEB_LIMITS.maxResultChars && result.text.length) {
    const over = JSON.stringify([...results, result]).length - PUBLIC_WEB_LIMITS.maxResultChars;
    result.text = result.text.slice(0, Math.max(0, result.text.length - Math.max(1, over)));
  }
  if (JSON.stringify([...results, result]).length <= PUBLIC_WEB_LIMITS.maxResultChars) results.push(result);
}

// Wire-format compatibility only; independently authored, no Exa code ported.
// Format/schema inspected at exa-labs/exa-mcp-server commit
// f3d71fb6b0ff4b4683f108f05bc2bae61a9f7e97, src/tools/webSearch.ts:
// https://github.com/exa-labs/exa-mcp-server/blob/f3d71fb6b0ff4b4683f108f05bc2bae61a9f7e97/src/tools/webSearch.ts
function searchResults(result, limit) {
  if (result.isError) {
    const diagnostic = Array.isArray(result.content) ? result.content.filter((item) => item?.type === "text")
      .map((item) => typeof item.text === "string" ? item.text : "").join(" ") : "";
    fail(/\b429\b|rate[ -]?limit|too many requests/i.test(diagnostic) ? "WEB_RATE_LIMITED" : "WEB_PROVIDER_FAILURE");
  }
  const structured = result.structuredContent?.results ?? result.results;
  const output = [];
  if (Array.isArray(structured)) {
    for (const item of structured.slice(0, 100)) {
      if (plain(item)) appendResult(output, { ...item,
        text: item.text ?? (Array.isArray(item.highlights) ? item.highlights.filter((x) => typeof x === "string").join("\n") : ""),
      }, limit);
    }
    if (structured.length && !output.length) fail("WEB_RESPONSE_INVALID");
    return output;
  }
  if (!Array.isArray(result.content) || result.content.length > 100) fail("WEB_RESPONSE_INVALID");
  const content = result.content.filter((item) => item?.type === "text" && typeof item.text === "string");
  if (!content.length) fail("WEB_RESPONSE_INVALID");
  let recognizedEmpty = false;
  for (const item of content) {
    const text = item.text.trim();
    if (/^No search results found\.(?:\s+Please try a different query\.)?$/i.test(text)) { recognizedEmpty = true; continue; }
    // Some MCP deployments wrap the structured search response as text JSON.
    if (text.startsWith("{")) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { fail("WEB_RESPONSE_INVALID"); }
      if (!Array.isArray(parsed?.results)) fail("WEB_RESPONSE_INVALID");
      if (!parsed.results.length) recognizedEmpty = true;
      for (const source of parsed.results.slice(0, 100)) appendResult(output, source, limit);
      continue;
    }
    for (const block of text.split(/\n\s*---\s*\n/).slice(0, 100)) {
      const fields = {};
      let readingText = false;
      for (const line of block.split("\n")) {
        if (readingText) { fields.text += `\n${line}`; continue; }
        const field = line.match(/^(Title|URL|Published|Published Date|Text|Highlights):\s*(.*)$/);
        if (!field) continue;
        if (field[1] === "Text" || field[1] === "Highlights") { fields.text = field[2]; readingText = true; }
        else if (field[1] === "Title") fields.title = field[2];
        else if (field[1] === "URL") fields.url = field[2];
        else fields.publishedAt = field[2];
      }
      appendResult(output, fields, limit);
    }
  }
  if (!output.length && !recognizedEmpty) fail("WEB_RESPONSE_INVALID");
  return output;
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
    if (!key.startsWith("#")) return named[key.toLowerCase()];
    const number = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : "";
  });
}
function stripInactiveHTML(html) {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
}
function htmlText(html) {
  return decodeEntities(stripInactiveHTML(html)
    .replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}
function htmlMetadata(html) {
  html = stripInactiveHTML(html);
  const title = decodeEntities((html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "")
    .replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  let date;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attributes[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4]);
    const key = (attributes.property || attributes.name || attributes.itemprop || "").toLowerCase();
    if (["article:published_time", "date", "datepublished", "dc.date", "dcterms.date"].includes(key)) {
      date = publishedDate(attributes.content);
      if (date) break;
    }
  }
  if (!date) date = publishedDate(html.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1]);
  return { title, ...(date ? { publishedAt: date } : {}) };
}

/** Public-only read service. Overrides are constructor-only synthetic test hooks. */
export function createPublicWebService({
  resolver = (hostname, options) => dns.lookup(hostname, options),
  requestImpl = requestPublicPinnedHTTPS, clock = Date.now,
  timeoutMs = PUBLIC_WEB_LIMITS.timeoutMs,
} = {}) {
  if (typeof resolver !== "function" || typeof requestImpl !== "function" || typeof clock !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PUBLIC_WEB_LIMITS.timeoutMs) fail("WEB_INPUT_INVALID");
  let observation = { status: "unobserved", code: "WEB_NOT_CHECKED", provider: null, observedAt: null };
  const observations = new Map();
  const timestamp = () => new Date(clock()).toISOString();
  const observe = (provider, status, code) => {
    observation = { provider, status, code, observedAt: timestamp() };
    observations.set(provider, observation);
  };

  async function pinnedRequest(url, options, context, provider, perResponse) {
    context.assertActive();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let addresses;
    if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
    else {
      try { addresses = await abortable(Promise.resolve().then(() => {
        context.assertActive();
        return resolver(hostname, { all: true, verbatim: true });
      }), context.signal); }
      catch (error) {
        if (context.authorizationFailed) throw error;
        if (!context.signal.aborted) context.assertActive();
        // An on-demand DNS attempt is a real connectivity observation, without
        // asserting that the provider's HTTP service was reached or failed.
        observe(provider, "unavailable", context.signal.aborted
          ? context.signal.reason?.code === "WEB_TIMEOUT" ? "WEB_TIMEOUT" : "WEB_INTERRUPTED"
          : "WEB_DNS_UNAVAILABLE");
        if (context.signal.aborted) throw error;
        fail("WEB_DNS_UNAVAILABLE");
      }
    }
    context.assertActive();
    if (!Array.isArray(addresses) || !addresses.length) {
      observe(provider, "unavailable", "WEB_DNS_UNAVAILABLE");
      fail("WEB_DNS_UNAVAILABLE");
    }
    if (addresses.some((entry) =>
      !isPublicAddress(entry?.address) || net.isIP(entry.address) !== entry.family)) fail("WEB_POLICY_BLOCKED");
    context.assertActive();
    const maxBytes = Math.min(perResponse, context.remaining);
    if (maxBytes < 1) fail("WEB_RESPONSE_TOO_LARGE");
    try {
      const response = await abortable(Promise.resolve().then(() => {
        context.assertActive();
        return requestImpl(url, {
          ...options, signal: context.signal, maxBytes, assertAuthorized: context.assertActive,
        }, { address: addresses[0].address, family: addresses[0].family });
      }), context.signal);
      context.assertActive();
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599 || typeof response.text !== "function") fail("WEB_RESPONSE_INVALID");
      const text = await abortable(Promise.resolve().then(() => response.text()), context.signal);
      context.assertActive();
      if (typeof text !== "string") fail("WEB_RESPONSE_INVALID");
      const bytes = Math.max(Buffer.byteLength(text), Number.isInteger(response.bytesLength) ? response.bytesLength : 0);
      if (bytes > maxBytes) fail("WEB_RESPONSE_TOO_LARGE");
      context.remaining -= bytes;
      if (header(response, "content-encoding") && header(response, "content-encoding").toLowerCase() !== "identity") fail("WEB_CONTENT_UNSUPPORTED");
      observe(provider, response.status >= 200 && response.status < 300 ? "available" : "unavailable",
        response.status >= 200 && response.status < 300 ? "WEB_OK" : httpCode(response.status));
      return { response, text };
    } catch (error) {
      if (context.authorizationFailed) throw error;
      if (!context.signal.aborted) context.assertActive();
      observe(provider, "unavailable", context.signal.aborted ? "WEB_INTERRUPTED" : safeFailure(error));
      throw error;
    }
  }
  function safeFailure(error) {
    const code = error?.code;
    return ["WEB_TIMEOUT", "WEB_DNS_UNAVAILABLE", "WEB_NETWORK", "WEB_PROXY_CONFIG", "WEB_RATE_LIMITED",
      "WEB_PROVIDER_FAILURE", "WEB_RESPONSE_INVALID", "WEB_RESPONSE_TOO_LARGE", "WEB_REDIRECT_LIMIT", "WEB_CONTENT_UNSUPPORTED"]
      .includes(code) ? code : "WEB_NETWORK";
  }
  async function run(provider, { signal, assertAuthorized }, operation) {
    if (assertAuthorized !== undefined && typeof assertAuthorized !== "function") fail("WEB_INPUT_INVALID");
    if (signal?.aborted) fail("CANCELLED");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new PublicWebError("WEB_TIMEOUT")), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const context = { signal: combined, remaining: PUBLIC_WEB_LIMITS.maxResponseBytes, authorizationFailed: false };
    context.assertActive = () => {
      if (context.authorizationFailed) throw context.authorizationFailure;
      combined.throwIfAborted();
      try { assertAuthorized?.(); }
      catch (error) {
        context.authorizationFailed = true;
        context.authorizationFailure = error;
        throw error;
      }
    };
    const envelope = (results, code, ok = true) => ({
      ok, status: ok ? results.length ? "success" : "empty" : "unavailable",
      code, provider, retrievedAt: timestamp(), results, untrusted: true,
    });
    try {
      context.assertActive();
      const results = await operation(context);
      context.assertActive();
      return envelope(results, results.length ? "WEB_OK" : "WEB_EMPTY");
    } catch (error) {
      // Authorization errors belong to the caller's lifecycle/permission
      // boundary. Preserve them, including unknown codes, rather than claiming
      // a provider network failure or returning a completed result.
      if (context.authorizationFailed) throw context.authorizationFailure;
      if (signal?.aborted) fail("CANCELLED");
      if (!combined.aborted) context.assertActive();
      if (TERMINAL.has(error?.code)) throw error;
      const code = timeout.signal.aborted ? "WEB_TIMEOUT" : safeFailure(error);
      // HTTP 2xx alone cannot establish MCP protocol/tool availability. A
      // semantic failure must replace any earlier successful HTTP observation.
      observe(provider, "unavailable", code);
      return envelope([], code, false);
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    networkState: (provider) => {
      if (provider === undefined) return { ...observation };
      if (!["exa-mcp", "public-https"].includes(provider)) fail("WEB_INPUT_INVALID");
      return { ...(observations.get(provider) || {
        status: "unobserved", code: "WEB_NOT_CHECKED", provider, observedAt: null,
      }) };
    },
    async search(args, { signal, assertAuthorized } = {}) {
      const { query, limit } = validateArgs(args, "search");
      return run("exa-mcp", { signal, assertAuthorized }, async (context) => {
        const endpoint = publicURL(EXA_ENDPOINT);
        let session = "", protocol = VERSION;
        async function rpc(method, params, id) {
          context.assertActive();
          const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": protocol };
          if (session) headers["mcp-session-id"] = session;
          const packet = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(id === undefined ? {} : { id }) };
          const { response, text } = await pinnedRequest(endpoint, {
            method: "POST", headers, body: JSON.stringify(packet),
          }, context, "exa-mcp", PUBLIC_WEB_LIMITS.maxResponseBytes);
          if (response.status < 200 || response.status >= 300) fail(httpCode(response.status));
          if (id === undefined) {
            if (![202, 204].includes(response.status) || text.trim()) fail("WEB_RESPONSE_INVALID");
            return;
          }
          const result = parseRPC(text, header(response, "content-type"), id);
          if (method === "initialize") {
            const value = header(response, "mcp-session-id");
            if (value && (value.length > 512 || !/^[\x21-\x7e]+$/.test(value))) fail("WEB_RESPONSE_INVALID");
            session = value;
          }
          return result;
        }
        const initialized = await rpc("initialize", {
          protocolVersion: VERSION, capabilities: {}, clientInfo: { name: "luheng-public-web", version: "0.1.0" },
        }, 1);
        if (!PROTOCOLS.has(initialized.protocolVersion)) fail("WEB_RESPONSE_INVALID");
        protocol = initialized.protocolVersion;
        await rpc("notifications/initialized");
        // Only the explicit tool query is sent; this service never receives or
        // concatenates task history, private documents, model keys, or cookies.
        const result = await rpc("tools/call", { name: "web_search_exa", arguments: { query, numResults: limit } }, 2);
        return searchResults(result, limit);
      });
    },
    async extract(args, { signal, assertAuthorized } = {}) {
      const { urls } = validateArgs(args, "extract");
      return run("public-https", { signal, assertAuthorized }, async (context) => {
        const results = [];
        for (let url of urls) {
          context.assertActive();
          let redirects = 0;
          const seen = new Set();
          while (true) {
            context.assertActive();
            if (seen.has(url.href)) fail("WEB_REDIRECT_LIMIT");
            seen.add(url.href);
            const { response, text } = await pinnedRequest(url, {
              method: "GET", headers: { accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8" },
            }, context, "public-https", PUBLIC_WEB_LIMITS.maxPageBytes);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              if (++redirects > PUBLIC_WEB_LIMITS.maxRedirects) fail("WEB_REDIRECT_LIMIT");
              const location = header(response, "location");
              if (!location || location.length > PUBLIC_WEB_LIMITS.maxUrlChars || /[\s\u0000-\u001f\u007f\\]/u.test(location)) fail("WEB_POLICY_BLOCKED");
              let target;
              try { target = new URL(location, url).href; } catch { fail("WEB_POLICY_BLOCKED"); }
              url = publicURL(target);
              continue;
            }
            if (response.status < 200 || response.status >= 300) fail(httpCode(response.status));
            const type = header(response, "content-type").split(";")[0].trim().toLowerCase();
            if (!["text/html", "application/xhtml+xml", "text/plain"].includes(type)) fail("WEB_CONTENT_UNSUPPORTED");
            const html = type !== "text/plain";
            const extracted = html ? htmlText(text) : text.trim();
            if (extracted) appendResult(results, { url: url.href, ...(html ? htmlMetadata(text) : {}), text: extracted }, PUBLIC_WEB_LIMITS.maxResults);
            break;
          }
        }
        return results;
      });
    },
  });
}
