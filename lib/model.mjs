import dns from "node:dns/promises";
import net from "node:net";
import https from "node:https";
import { redactSecrets } from "./redact.mjs";
export class ModelError extends Error {
  constructor(message, code = "MODEL_ERROR") {
    super(message);
    this.code = code;
  }
}
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    let p = ip.split(".").map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 192 && p[1] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    );
  }
  return (
    ip === "::" ||
    ip === "::1" ||
    /^f[cd]/i.test(ip) ||
    /^fe[89ab]/i.test(ip) ||
    ip.toLowerCase().startsWith("::ffff:") ||
    /^2001:db8:/i.test(ip)
  );
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
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new ModelError("无法解析 API 域名，请检查地址和网络", "ENDPOINT_DNS");
  }
  if (!addresses.length || addresses.some((x) => privateAddress(x.address)))
    throw new ModelError(
      "禁止连接私有、回环或保留网络地址",
      "ENDPOINT_BLOCKED",
    );
  return url.toString().replace(/\/$/, "");
}
async function pinnedFetch(url, options) {
  const u = new URL(url);
  const addresses = await dns.lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((x) => privateAddress(x.address)))
    throw new ModelError("API域名指向不允许的网络地址", "ENDPOINT_BLOCKED");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: options.method,
        rejectUnauthorized: true,
        headers: options.headers,
        signal: options.signal,
        lookup: (_hostname, opts, cb) => {
          if (opts?.all) cb(null, [address]);
          else cb(null, address.address, address.family);
        },
      },
      (res) => {
        let chunks = [],
          size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2000000) {
            req.destroy(new Error("模型响应过大"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
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
    if (signal?.aborted) throw new ModelError("任务已取消", "CANCELLED");
    if (timeout.aborted)
      throw new ModelError(
        "模型请求超过30秒，请检查网络或服务状态",
        "MODEL_TIMEOUT",
      );
    throw new ModelError(
      "模型连接失败；请核对服务地址、网络和TLS证书",
      "MODEL_NETWORK",
    );
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
  const raw = await res.text();
  if (raw.length > 2000000)
    throw new ModelError("模型响应过大", "MODEL_RESPONSE");
  let data;
  try {
    data = redactSecrets(JSON.parse(raw), [key]);
  } catch {
    throw new ModelError("模型服务没有返回有效 JSON", "MODEL_RESPONSE");
  }
  const message = data.choices?.[0]?.message;
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
