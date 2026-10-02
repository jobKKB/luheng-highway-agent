import https from "node:https";
import net from "node:net";

const RESPONSE_LIMIT = 2_000_000;

function transportError(message, code) {
  return Object.assign(new Error(message), { code });
}

function ipv4Number(ip) {
  return ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

// Match Node's documented NO_PROXY forms against the ORIGINAL destination.
// Never match against the pinned address: doing so would change hostname-based
// bypass policy (and could accidentally bypass a required deployment proxy).
// https://nodejs.org/api/http.html#no_proxy-format
export function bypassProxy(hostname, port, noProxy = "") {
  const host = hostname.toLowerCase();
  return noProxy.split(",").some((value) => {
    const entry = value.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*" || entry === host || entry === `${host}:${port}`) return true;
    if (entry.startsWith(".")) {
      const domain = entry.slice(1);
      return host === domain || host.endsWith(`.${domain}`);
    }
    if (entry.startsWith("*.")) return host.endsWith(entry.slice(1));
    if (net.isIPv4(host) && entry.includes("-")) {
      const range = entry.split("-").map((part) => part.trim());
      if (range.length !== 2 || !range.every(net.isIPv4)) return false;
      const number = ipv4Number(host);
      return number >= ipv4Number(range[0]) && number <= ipv4Number(range[1]);
    }
    return false;
  });
}

// HTTPS follows https_proxy/HTTPS_PROXY only, as the built-in Node Agent does.
// Lowercase takes precedence. Do not enable ALL_PROXY, NODE_OPTIONS, or global
// proxy state: this is scoped to the requested model connection only.
export function modelProxyEnvironment(url, env = process.env) {
  const proxy = env.https_proxy || env.HTTPS_PROXY;
  const noProxy = env.no_proxy || env.NO_PROXY || "";
  if (!proxy || bypassProxy(url.hostname, url.port || "443", noProxy)) return {};
  try {
    if (typeof proxy !== "string" || /[\r\n]/.test(proxy)) throw new Error();
    const parsed = new URL(proxy);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    // Node decodes these when building CONNECT authentication. Validate before
    // constructing its Agent so malformed values cannot leak in an error.
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw transportError("已有 HTTPS 代理配置无效，请检查部署配置", "MODEL_PROXY_CONFIG");
  }
  // NO_PROXY was evaluated against the hostname above. The Agent now connects
  // to the validated IP, so it must not re-evaluate bypass rules against that IP.
  return { HTTPS_PROXY: proxy, NO_PROXY: "" };
}

// Preserve only bounded machine-readable diagnostics. Network errors (including
// invalid proxy URLs) can otherwise include proxy credentials or request details.
function safeNetworkError(error) {
  const safe = transportError("模型 HTTPS 连接失败", "MODEL_NETWORK");
  if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) safe.code = error.code;
  if (error?.name === "AbortError") safe.name = "AbortError";
  if (["connect", "getaddrinfo", "read", "write"].includes(error?.syscall)) safe.syscall = error.syscall;
  if (Array.isArray(error?.errors)) {
    safe.errors = error.errors.slice(0, 8).map((item) => {
      const nested = transportError("模型 HTTPS 连接失败", "MODEL_NETWORK");
      if (typeof item?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.code)) nested.code = item.code;
      return nested;
    });
  }
  return safe;
}

/**
 * Issue a model request to an already validated PUBLIC DNS address. The caller
 * must resolve all addresses and reject private/reserved results immediately
 * before invoking this function. No target DNS lookup is repeated here.
 * Dependency injection is for offline tests; production callers use defaults.
 */
export async function requestPinnedHTTPS(
  url,
  options,
  address,
  { env = process.env, httpsImpl = https } = {},
) {
  const original = new URL(url);
  if (original.protocol !== "https:" || (original.port && original.port !== "443") ||
      original.username || original.password || original.search || original.hash ||
      !address || !net.isIP(address.address) || net.isIP(address.address) !== address.family) {
    throw transportError("模型 HTTPS 传输参数无效", "ENDPOINT_INVALID");
  }
  const proxyEnv = modelProxyEnvironment(original, env);
  let agent;
  try {
    agent = new httpsImpl.Agent({
      proxyEnv,
      keepAlive: false,
      maxCachedSessions: 0,
      rejectUnauthorized: true,
    });
  } catch {
    throw transportError("已有 HTTPS 代理配置无效，请检查部署配置", "MODEL_PROXY_CONFIG");
  }
  const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(
    ([name]) => !["host", "proxy-authorization", "proxy-connection"].includes(name.toLowerCase()),
  ));
  headers.host = original.host;
  try {
    return await new Promise((resolve, reject) => {
      const req = httpsImpl.request({
        protocol: "https:",
        // Both direct TCP and proxy CONNECT target this exact validated IP.
        // Original Host and SNI preserve virtual-host routing and certificate
        // verification, without handing the proxy an unpinned hostname.
        hostname: address.address,
        family: address.family,
        port: 443,
        servername: original.hostname.replace(/^\[|\]$/g, ""),
        path: original.pathname,
        method: options.method,
        headers,
        signal: options.signal,
        rejectUnauthorized: true,
        agent,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) {
            req.destroy(transportError("模型响应过大", "MODEL_RESPONSE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => Buffer.concat(chunks).toString("utf8"),
        }));
        res.on("error", reject);
        res.on("aborted", () => reject(transportError("模型响应意外中断", "ECONNRESET")));
      });
      req.on("error", reject);
      req.end(options.body);
    });
  } catch (error) {
    throw safeNetworkError(error);
  } finally {
    agent.destroy();
  }
}
