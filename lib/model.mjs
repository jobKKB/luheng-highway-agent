import dns from "node:dns/promises";
import net from "node:net";
import { requestPinnedHTTPS } from "./model-transport.mjs";
import { redactSecrets } from "./redact.mjs";
import { isPublicAddress } from "./public-ip.mjs";
export class ModelError extends Error {
  constructor(message, code = "MODEL_ERROR") {
    super(message);
    this.code = code;
  }
}

const diagnosticMessages = Object.freeze({
  MODEL_ERROR: "模型请求失败，请检查模型配置或服务状态",
  KEY_MISSING: "尚未输入 API Key；密钥仅在本次应用运行期间保留",
  MODEL_MISSING: "请先填写模型名称",
  ENDPOINT_INVALID:
    "API 地址无效；请使用不含账号、密码、查询参数或片段的 HTTPS 地址（443 端口）",
  ENDPOINT_BLOCKED: "API 地址不符合公网访问安全策略，禁止连接私有、回环或保留网络地址",
  ENDPOINT_DNS: "无法解析 API 域名，请检查地址和网络",
  CANCELLED: "任务已取消",
  MODEL_TIMEOUT: "模型请求超过30秒，请检查网络或服务状态",
  MODEL_RESPONSE: "模型响应格式无效、内容缺失或超过限制",
  MODEL_PROXY_CONFIG: "现有网络代理配置无效，请检查代理配置",
  MODEL_NETWORK: "模型连接失败；请核对服务地址、网络和TLS证书",
  MODEL_NETWORK_PROXY: "无法通过现有网络代理连接模型服务，请检查代理或服务状态",
  MODEL_NETWORK_DNS: "无法解析模型服务域名，请检查 API 地址和 DNS 网络设置",
  MODEL_NETWORK_TLS: "模型服务 TLS 安全连接失败，请检查系统时间、证书和网络代理；证书验证仍保持开启",
  MODEL_NETWORK_TIMEOUT: "连接模型服务时发生网络超时，请检查网络或服务状态",
  MODEL_NETWORK_REFUSED: "模型服务拒绝建立连接，请检查服务地址或服务是否可用",
  MODEL_NETWORK_UNREACHABLE: "无法到达模型服务网络，请检查网络连接、代理或防火墙设置",
});

const networkDiagnosticCodes = new Map([
  ["ERR_PROXY_TUNNEL", "MODEL_NETWORK_PROXY"],
  ...["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA"].map((code) => [code, "MODEL_NETWORK_DNS"]),
  ...[
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_SIGNATURE_FAILURE", "CERT_REVOKED",
    "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
    "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  ].map((code) => [code, "MODEL_NETWORK_TLS"]),
  ...[
    "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ERR_TLS_HANDSHAKE_TIMEOUT",
  ].map((code) => [code, "MODEL_NETWORK_TIMEOUT"]),
  ["ECONNREFUSED", "MODEL_NETWORK_REFUSED"],
  ...["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN"].map((code) => [code, "MODEL_NETWORK_UNREACHABLE"]),
]);

// Only inspect data properties. Never read exception messages, stack traces,
// request/response objects, endpoint values, or accessor-generated details.
function errorProperty(error, key) {
  if (!error || typeof error !== "object") return undefined;
  try {
    return Object.getOwnPropertyDescriptor(error, key)?.value;
  } catch {
    return undefined;
  }
}

function diagnostic(code) {
  return { code, message: diagnosticMessages[code] };
}

// Safe to send to the client or copy as a diagnosis: every returned value comes
// from this allowlist, never from an exception's human-readable details.
export function modelErrorDiagnostic(error) {
  const code = errorProperty(error, "code");
  if (error instanceof ModelError) {
    if (typeof code === "string" && Object.hasOwn(diagnosticMessages, code))
      return diagnostic(code);
    if (typeof code === "string" && /^MODEL_HTTP_[1-5]\d{2}$/.test(code)) {
      const status = code.slice(-3);
      const messages = {
        401: "API Key 无效或无权访问",
        403: "模型服务拒绝访问",
        404: "接口路径或模型不存在",
        429: "模型服务限流或账户额度不足",
      };
      return { code, message: messages[status] || `模型服务返回错误（HTTP ${status}）` };
    }
    return diagnostic("MODEL_ERROR");
  }

  const pending = [error], seen = new Set(), categories = new Set();
  let truncated = false;
  // Fetch implementations can wrap system errors in cause or AggregateError.
  // Bound traversal and avoid selecting a misleading category for mixed causes.
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const category = networkDiagnosticCodes.get(errorProperty(current, "code"));
    if (category) categories.add(category);
    const cause = errorProperty(current, "cause");
    if (cause) pending.push(cause);
    const errors = errorProperty(current, "errors");
    if (Array.isArray(errors)) {
      if (errors.length > 16) truncated = true;
      pending.push(...errors.slice(0, 16));
    }
  }
  return diagnostic(categories.size === 1 && !pending.length && !truncated
    ? categories.values().next().value
    : "MODEL_NETWORK");
}

function requestError(error, signal, timeout) {
  if (signal?.aborted) return new ModelError("任务已取消", "CANCELLED");
  if (timeout.aborted)
    return new ModelError(diagnosticMessages.MODEL_TIMEOUT, "MODEL_TIMEOUT");
  const failure = modelErrorDiagnostic(error);
  return new ModelError(failure.message, failure.code);
}

function endpointAddresses(hostname) {
  // WHATWG URLs retain brackets around IPv6 literals. Never send them to DNS.
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(host);
  return family ? Promise.resolve([{ address: host, family }]) : dns.lookup(host, { all: true });
}

function publicAddresses(addresses) {
  return Array.isArray(addresses) && addresses.length > 0 &&
    addresses.every((entry) => isPublicAddress(entry?.address));
}
export async function validateEndpoint(
  endpoint,
  { allowTestLocal = false } = {},
) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ModelError("请输入有效的 API 地址", "ENDPOINT_INVALID");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new ModelError(
      "API 地址不能包含账号、密码、查询参数或片段",
      "ENDPOINT_INVALID",
    );
  if (
    allowTestLocal &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1"
  )
    return url.toString().replace(/\/$/, "");
  if (url.protocol !== "https:")
    throw new ModelError("真实模型接口必须使用 HTTPS", "ENDPOINT_INVALID");
  if (url.port && url.port !== "443")
    throw new ModelError("原型仅允许 HTTPS 443 端口", "ENDPOINT_INVALID");
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal")
  )
    throw new ModelError(
      "原型不支持内网或本机模型地址，请在受控部署中增加管理员白名单",
      "ENDPOINT_BLOCKED",
    );
  let addresses;
  try {
    addresses = await endpointAddresses(url.hostname);
  } catch {
    throw new ModelError("无法解析 API 域名，请检查地址和网络", "ENDPOINT_DNS");
  }
  if (!publicAddresses(addresses))
    throw new ModelError(
      "禁止连接私有、回环或保留网络地址",
      "ENDPOINT_BLOCKED",
    );
  return url.toString().replace(/\/$/, "");
}
async function pinnedFetch(url, options) {
  const u = new URL(url);
  const addresses = await endpointAddresses(u.hostname);
  if (!publicAddresses(addresses))
    throw new ModelError("API域名指向不允许的网络地址", "ENDPOINT_BLOCKED");
  return requestPinnedHTTPS(u, options, addresses[0]);
}

export async function callCompletion({
  endpoint,
  model,
  key,
  messages,
  tools,
  signal,
  allowTestLocal = false,
  fetchImpl,
}) {
  if (!key)
    throw new ModelError(
      "尚未输入 API Key；密钥仅在本次应用运行期间保留",
      "KEY_MISSING",
    );
  if (!model?.trim()) throw new ModelError("请先填写模型名称", "MODEL_MISSING");
  const base = await validateEndpoint(endpoint, { allowTestLocal });
  const requestImpl = fetchImpl || (allowTestLocal ? fetch : pinnedFetch);
  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await requestImpl(base + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 2400,
        ...(tools?.length
          ? { tools, tool_choice: "auto", parallel_tool_calls: false }
          : {}),
      }),
      signal: combined,
      redirect: "error",
    });
  } catch (e) {
    throw requestError(e, signal, timeout);
  }
  if (!res.ok) {
    const messages = {
      401: "API Key 无效或无权访问",
      403: "模型服务拒绝访问",
      404: "接口路径或模型不存在",
      429: "模型服务限流或账户额度不足",
    };
    throw new ModelError(
      messages[res.status] || `模型服务返回错误（HTTP ${res.status}）`,
      "MODEL_HTTP_" + res.status,
    );
  }
  let raw;
  try {
    raw = await res.text();
  } catch (e) {
    throw requestError(e, signal, timeout);
  }
  if (raw.length > 2000000)
    throw new ModelError("模型响应过大", "MODEL_RESPONSE");
  let data;
  try {
    data = redactSecrets(JSON.parse(raw), [key]);
  } catch {
    throw new ModelError("模型服务没有返回有效 JSON", "MODEL_RESPONSE");
  }
  const choice = data.choices?.[0];
  // A truncated answer may contain half-formed text or tool arguments. Stop
  // before accepting either; never retry or raise the output budget silently.
  if (choice?.finish_reason === "length")
    throw new ModelError(
      "模型输出达到长度上限（2400 token），已停止；本轮正文与工具调用均未采用，也不会自动重试",
      "MODEL_OUTPUT_LENGTH",
    );
  const message = choice?.message;
  if (
    message &&
    message.reasoning_content !== undefined &&
    message.reasoning_content !== null &&
    typeof message.reasoning_content !== "string"
  )
    throw new ModelError("模型推理内容格式无效", "MODEL_RESPONSE");
  if (
    !message ||
    (!message.tool_calls?.length && typeof message.content !== "string")
  )
    throw new ModelError("模型响应缺少文本或工具调用", "MODEL_RESPONSE");
  if (
    message.tool_calls &&
    (!Array.isArray(message.tool_calls) ||
      message.tool_calls.length > 8 ||
      message.tool_calls.some(
        (t) =>
          typeof t.id !== "string" ||
          typeof t.function?.name !== "string" ||
          typeof t.function?.arguments !== "string" ||
          t.function.arguments.length > 50000,
      ))
  )
    throw new ModelError("模型工具调用格式无效或超限", "MODEL_RESPONSE");
  return {
    message: {
      role: "assistant",
      content:
        typeof message.content === "string"
          ? message.content.slice(0, 32000)
          : null,
      // Optional provider reasoning is kept whole (already redacted above) so
      // the same task can return it during consecutive tool calling.
      ...(typeof message.reasoning_content === "string"
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    },
    usage: data.usage ?? null,
  };
}

export async function callModel(options) {
  const result = await callCompletion(options);
  if (!result.message.content?.trim())
    throw new ModelError("模型响应缺少文本内容", "MODEL_RESPONSE");
  return { content: result.message.content, usage: result.usage };
}
