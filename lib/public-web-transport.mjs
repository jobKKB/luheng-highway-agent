import https from "node:https";
import net from "node:net";
import { modelProxyEnvironment } from "./model-transport.mjs";
import { isPublicAddress } from "./public-ip.mjs";

const RESPONSE_LIMIT = 2_000_000;
const error = (code) => Object.assign(new Error("公网 HTTPS 请求失败"), { code });

/**
 * Web-specific pinned transport. Unlike the model transport, an ordinary public
 * page may have a query string. Every connection still targets a numeric PUBLIC
 * address, with original Host/SNI and mandatory TLS certificate verification.
 * This reuses only the existing scoped proxy policy, not a global fetch Agent.
 * Injection is for synthetic transport tests; production uses Node HTTPS.
 */
export async function requestPublicPinnedHTTPS(url, options, address, {
  env = process.env, httpsImpl = https,
} = {}) {
  let original;
  try { original = new URL(url); } catch { throw error("WEB_INPUT_INVALID"); }
  const hostname = original.hostname.replace(/^\[|\]$/g, "");
  if (original.protocol !== "https:" || (original.port && original.port !== "443") ||
      original.username || original.password || original.hash || !hostname ||
      !address || !isPublicAddress(address.address) ||
      net.isIP(address.address) !== address.family ||
      !["GET", "POST"].includes(options?.method) ||
      !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > RESPONSE_LIMIT) {
    throw error("WEB_POLICY_BLOCKED");
  }
  if (options.assertAuthorized !== undefined && typeof options.assertAuthorized !== "function") {
    throw error("WEB_INPUT_INVALID");
  }
  let authorizationFailed = false, authorizationFailure;
  const assertActive = () => {
    if (authorizationFailed) throw authorizationFailure;
    options.signal?.throwIfAborted();
    try { options.assertAuthorized?.(); }
    catch (failure) {
      authorizationFailed = true;
      authorizationFailure = failure;
      throw failure;
    }
  };
  assertActive();
  let proxyEnv;
  try { proxyEnv = modelProxyEnvironment(original, env); }
  catch { throw error("WEB_PROXY_CONFIG"); }
  let agent;
  try {
    agent = new httpsImpl.Agent({
      proxyEnv, keepAlive: false, maxCachedSessions: 0, rejectUnauthorized: true,
    });
  } catch { throw error("WEB_PROXY_CONFIG"); }
  // There is no API for passing origin credentials or cookies through this
  // public-only transport. Proxy auth, if configured by deployment, stays in
  // the Agent's CONNECT flow and is never forwarded to the origin.
  const allowedHeaders = new Set([
    "accept", "content-type", "mcp-session-id", "mcp-protocol-version", "user-agent",
  ]);
  const headers = Object.fromEntries(Object.entries(options.headers || {})
    .filter(([name, value]) => allowedHeaders.has(name.toLowerCase()) &&
      typeof value === "string" && !/[\r\n]/.test(value))
    .map(([name, value]) => [name.toLowerCase(), value]));
  headers.host = original.host;
  headers["accept-encoding"] = "identity";
  // An HTTPS proxy's DNS/tunnel setup is asynchronous inside Node's Agent.
  // Guard the returned socket as well as the eventual tunneled socket, without
  // replacing Node's numeric target, proxy policy, Host/SNI, or TLS validation.
  const sockets = new Set();
  let req, rejectPending;
  const stop = (failure) => {
    rejectPending?.(failure);
    req?.destroy(failure);
    for (const socket of sockets) socket.destroy();
  };
  const activeBoundary = () => {
    try { assertActive(); return true; }
    catch (failure) { stop(failure); return false; }
  };
  const guardSocket = (socket) => {
    if (!socket || sockets.has(socket)) return socket;
    sockets.add(socket);
    // Node checks whether the socket was destroyed after emitting lookup,
    // before connecting to a newly resolved proxy address.
    socket.prependListener("lookup", activeBoundary);
    socket.prependOnceListener("connect", activeBoundary);
    socket.prependOnceListener("secureConnect", activeBoundary);
    const write = socket.write;
    socket.write = function (...args) {
      // This also protects CONNECT writes following an asynchronous proxy
      // handshake and the actual request flush after socket assignment.
      if (!activeBoundary()) return false;
      return write.apply(this, args);
    };
    return socket;
  };
  const createConnection = agent.createConnection;
  const guardedConnection = typeof createConnection === "function";
  if (guardedConnection) {
    agent.createConnection = function (connectionOptions, callback) {
      assertActive();
      return guardSocket(createConnection.call(this, connectionOptions, (failure, socket) => {
        guardSocket(socket);
        if (!failure && !activeBoundary()) return;
        callback(failure, socket);
      }));
    };
  }
  try {
    return await new Promise((resolve, reject) => {
      rejectPending = reject;
      assertActive();
      req = httpsImpl.request({
        protocol: "https:", hostname: address.address, family: address.family,
        port: 443, servername: hostname, path: original.pathname + original.search,
        method: options.method, headers, signal: options.signal,
        rejectUnauthorized: true, agent,
      }, (res) => {
        const chunks = [];
        let size = 0;
        const contentLength = Number(res.headers?.["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
          req.destroy(error("WEB_RESPONSE_TOO_LARGE"));
          return;
        }
        res.on("data", (chunk) => {
          if (req.destroyed) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > options.maxBytes) {
            req.destroy(error("WEB_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          if (req.destroyed) return;
          const keptHeaders = {};
          for (const name of ["content-type", "content-encoding", "location", "mcp-session-id"]) {
            if (typeof res.headers?.[name] === "string") keptHeaders[name] = res.headers[name];
          }
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, headers: keptHeaders, bytesLength: size, text: async () => body });
        });
        res.on("error", reject);
        res.on("aborted", () => reject(error("WEB_NETWORK")));
      });
      req.on("error", reject);
      let ended = false;
      const send = () => {
        if (ended || req.destroyed || !activeBoundary()) return;
        ended = true;
        try { req.end(options.body); }
        catch (failure) { stop(failure); }
      };
      if (!activeBoundary()) return;
      if (guardedConnection) {
        // Keep the body unqueued while proxy DNS, CONNECT and the TLS handshake
        // are pending. A new permission/lifecycle check precedes req.end itself.
        req.once("socket", (socket) => {
          guardSocket(socket);
          if (!activeBoundary()) return;
          if (socket.encrypted && !socket.authorized) socket.once("secureConnect", send);
          else if (socket.connecting) socket.once("connect", send);
          else send();
        });
      } else send(); // Lightweight synthetic HTTPS test doubles have no sockets.
    });
  } catch (failure) {
    if (authorizationFailed) throw authorizationFailure;
    if (!options.signal?.aborted) assertActive();
    // No raw network, certificate, proxy, URL, or response details are exposed.
    const code = ["WEB_RESPONSE_TOO_LARGE", "WEB_PROXY_CONFIG"].includes(failure?.code)
      ? failure.code : "WEB_NETWORK";
    throw error(code);
  } finally {
    // A pending proxy tunnel is not yet in the Agent's normal socket pool.
    for (const socket of sockets) socket.destroy();
    agent.destroy();
  }
}
