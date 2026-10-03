// Completion is based on structured intent and recorded tool evidence. The small
// multilingual fallback is only a guard for clearly time-sensitive user requests;
// it is not a universal keyword-based success classifier.
export function evidenceRequirement(prompt) {
  const text = String(prompt || "");
  const historical = /(?:\b(?:in|during|as of)\s+(?:19|20)\d{2}\b|(?:19|20)\d{2}年|曾任|当时|historical|history of)/i.test(text) &&
    !/现任|当前|现在|today|current|right now/i.test(text);
  if (historical) return "none";
  if (!historical && /(?:谁是|现任|who is|name of)/i.test(text) && /总统|总理|董事长|CEO|president|ceo|governor|prime minister/i.test(text)) return "current";
  const weather = /天气|气温|weather|temperature|forecast/i.test(text);
  const explanatory = /是什么|什么意思|原理|解释|形成|概念|如何预测|我喜欢|我爱|how\s+.*(?:work|form)|explain|definition|(?:I love|I like)/i.test(text);
  if (weather && !explanatory && (/查|查询|看看|获取|告诉|今天.*(?:如何|怎么样|怎样|多少|预报)|(?:what|how).*(?:weather|temperature)|forecast/i.test(text) || /^(?:.{0,20}天气[？?]?|weather(?:\s+in\s+.{1,60})?[?]?)$/i.test(text.trim()))) return "current_weather";
  if (/(?:今天|当前|现在|实时|最新|today|current|latest|right now)/i.test(text) &&
      /查|查询|搜索|告诉|获取|新闻|价格|汇率|比分|航班|search|news|price|rate|score|flight|what|who|how much/i.test(text)) return "current";
  return "none";
}
// User intent, not a model-selected claimType, determines whether a real action
// receipt is required. Keep ordinary composition and how-to questions answerable
// in chat. These conservative guards do not authorize any action or tool.
export function actionRequirements(prompt) {
  const text = String(prompt || "").trim().replace(/(?:不要|不必|无需|不用|别|do not|don't|never)\s*(?:保存|写入|发送|执行|运行|创建|导出|save|send|run|execute|create|export)[^，,。.!?;；\n]*/ig, "");
  const howTo = /教程|教学|如何|怎么|怎样|^(?:请)?(?:解释|说明|介绍|什么是)|\b(?:explain|describe|tutorial|how to|instructions|steps to)\b|^how (?:do|can|should|does)\b/i.test(text);
  const directRequest = /请(?:你)?(?:帮我)?(?:将|把|保存|发送|执行|创建|导出)|帮我(?:保存|发送|执行|创建|导出)|(?:can|could|would) you\s+(?:save|send|run|execute|create|export)/i.test(text);
  if (howTo && !directRequest) return [];
  const kinds = [];
  const file = /文件|文稿|简报|报告|资料|下载|附件|工作区|目录|file|document|report|artifact|download|attachment|workspace|directory|\.[a-z0-9]{2,5}\b/i;
  if ((/保存|另存|写入|导出|save\b|export\b|write\b/i.test(text) && file.test(text)) ||
      /(?:生成|创建|制作|generate|create|make).*(?:文件|下载|附件|file|download|attachment|\.[a-z0-9]{2,5}\b)/i.test(text) ||
      /(?:给我|提供|发我|give me|provide).*(?:下载链接|download (?:link|file))/i.test(text)) kinds.push("file");
  if (/下载链接|(?:给我|提供|发我).*(?:下载|附件)|download (?:link|file)|(?:give me|provide).*(?:download|attachment)/i.test(text)) kinds.push("download");
  if (/提醒|remind|reminder/i.test(text) && /创建|设置|安排|提醒我|create|set|schedule|remind me/i.test(text)) kinds.push("reminder");
  if (/邮件|邮箱|email|e-mail/i.test(text) && /发送|发出|寄出|send\b/i.test(text)) kinds.push("mail_send");
  if (/草稿|draft/i.test(text) && /邮件|邮箱|email|e-mail/i.test(text) && /(?:创建|保存|存入|create|save)/i.test(text)) kinds.push("mail_draft");
  if (/命令|脚本|程序|command|script|program/i.test(text) && /执行|运行|run\b|execute\b/i.test(text)) kinds.push("command");
  if (/网页|网站|浏览器|webpage|website|browser/i.test(text) && /提交|填写|点击|submit\b|fill\b|click\b/i.test(text)) kinds.push("browser_action");
  return [...new Set(kinds)];
}
const publicUrl = value => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443"); } catch { return false; }
};
const day = (value, timeZone = "UTC") => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
function bodyDates(text) {
  return (String(text || "").match(/\d{4}(?:-\d{1,2}-\d{1,2}|年\s*\d{1,2}月\s*\d{1,2}日)/g) || [])
    .map(value => Date.parse(value.replace(/年\s*/g, "-").replace(/月\s*/g, "-").replace(/日/g, "")))
    .filter(Number.isFinite);
}
function currentSource(source, now) {
  if (!String(source.text || "").trim()) return false;
  const recent = value => Number.isFinite(value) && value <= now + 5 * 60 * 1000 && now - value <= 48 * 60 * 60 * 1000;
  const published = source.publishedAt ? Date.parse(source.publishedAt) : NaN;
  // Fetch time proves retrieval only. Explicit stale publication or exclusively
  // old dated body text cannot be promoted to a current fact by fetching again.
  if (source.publishedAt && !recent(published)) return false;
  const dates = bodyDates(source.text);
  if (dates.length && !dates.some(recent)) return false;
  return recent(published) || dates.some(recent);
}
function currentWeatherSource(source, now) {
  if (!source?.text || !publicUrl(source.url)) return false;
  const zone = (new URL(source.url).hostname === "weather.com.cn" || new URL(source.url).hostname.endsWith(".weather.com.cn")) ? "Asia/Shanghai" : "UTC";
  if (!/天气|气温|晴|雨|雪|℃|°\s*[CF]|temperature|forecast|sunny|rain|precipitation|humidity/i.test(source.text + " " + (source.title || ""))) return false;
  const date = day(now, zone), [year, month, dateDay] = date.split("-");
  // A fetch timestamp alone cannot establish freshness. Require a date in the
  // source text (or an explicit source-published date), never the model's claim.
  const published = source.publishedAt && Number.isFinite(Date.parse(source.publishedAt)) && day(source.publishedAt, zone) === date;
  if (source.publishedAt && !published) return false;
  const explicitDates = source.text.match(/\d{4}(?:-\d{1,2}-\d{1,2}|年\s*\d{1,2}月\s*\d{1,2}日)/g) || [];
  const datedText = source.text.includes(date) || new RegExp(`${year}年\\s*0?${+month}月\\s*0?${+dateDay}日`).test(source.text) ||
    (!explicitDates.length && new RegExp(`0?${+month}月\\s*0?${+dateDay}日`).test(source.text));
  const conflictingDate = explicitDates.length > 0 && !datedText;
  const officialToday = !conflictingDate && zone === "Asia/Shanghai" && new RegExp(`(?:^|\\D)0?${+dateDay}日\\s*[（(]今天[）)]`).test(source.text);
  return !!(!conflictingDate && published || datedText || officialToday);
}
export function recordToolEvidence(call, result) {
  const tool = call.function.name;
  const unsuccessful = result?.ok === false || result?.error || ["empty", "unavailable", "failed", "pending", "unknown", "invalidated", "stale", "expired", "rejected", "cancelled", "manual_handoff_complete"].includes(result?.status);
  const sources = ["public_web_search", "public_web_extract"].includes(tool) ? (result?.results || []).filter(source => publicUrl(source.url) && typeof source.text === "string" && !!source.text.trim()) : [];
  const actionKinds = [];
  if (!unsuccessful) {
    if (tool === "workspace_save" && result?.saved === true && result?.artifact?.url && result?.artifact?.sha256) actionKinds.push("file", "download");
    if (tool === "local_write_file" && result?.operation?.kind === "write" && result?.operation?.status === "completed") actionKinds.push("file");
    if (tool === "local_run_command" && result?.operation?.kind === "command" && result?.operation?.status === "completed") actionKinds.push("command");
    if (tool === "mail_request_send" && (result?.sent === true || result?.status === "sent")) actionKinds.push("mail_send");
    if (tool === "mail_create_draft" && result?.id && result?.status === "draft") actionKinds.push("mail_draft");
    if (tool === "browser_propose_actions" && result?.status === "completed" && result?.actionsCompleted > 0) actionKinds.push("browser_action");
    if (tool === "reminder_create" && result?.id) actionKinds.push("reminder");
  }
  return { callId: call.id, tool, success: !unsuccessful, status: result?.status || (unsuccessful ? "failed" : "success"),
    retrievedAt: result?.retrievedAt || null, sources, code: result?.code || null,
    nonempty: tool === "knowledge_search" ? !!result?.records?.length : sources.length > 0 || !["public_web_search", "public_web_extract"].includes(tool),
    // Save only evidence already produced by the actual handler. Model final
    // status/wording cannot manufacture an action receipt.
    action: actionKinds.length > 0, actionKinds };
}
export function evaluateFinish(task, finish, { now = Date.now() } = {}) {
  const requirement = task.evidenceRequirement || evidenceRequirement(task.prompt);
  const actions = actionRequirements(task.prompt);
  const all = task.toolEvidence || [];
  const requested = finish.evidenceToolCallIds;
  const selected = requested?.length ? all.filter(item => requested.includes(item.callId)) : all;
  const unknown = requested?.some(callId => !all.some(item => item.callId === callId));
  const claimType = actions.length ? "action" : finish.claimType || (requirement === "none" ? "stable" : "current");
  const sources = selected.filter(item => item.success && item.nonempty).flatMap(item => item.sources.map(source => ({ ...source, tool: item.tool, retrievedAt: item.retrievedAt })));
  let code = null;
  if (unknown) code = "FINISH_EVIDENCE_UNKNOWN";
  else if (finish.status === "needs_attention") code = "MODEL_NEEDS_ATTENTION";
  else if (!String(finish.summary || "").trim()) code = "FINAL_ANSWER_MISSING";
  else if (requirement === "current_weather") {
    const valid = sources.some(source => source.tool === "public_web_extract" &&
      Number.isFinite(Date.parse(source.retrievedAt)) && Math.abs(now - Date.parse(source.retrievedAt)) <= 30 * 60 * 1000 && currentWeatherSource(source, now));
    if (!valid) code = "CURRENT_WEATHER_EVIDENCE_MISSING";
  } else if (requirement === "current" || claimType === "current") {
    const fresh = sources.some(source => Number.isFinite(Date.parse(source.retrievedAt)) && Math.abs(now - Date.parse(source.retrievedAt)) <= 30 * 60 * 1000 && currentSource(source, now));
    if (!fresh) code = "CURRENT_SOURCE_MISSING";
  }
  // Empty retrieval/provider failure plus an unsupported final answer cannot be
  // reported as completed, even if the planner forgot to classify the request.
  else if (all.some(item => ["public_web_search", "public_web_extract"].includes(item.tool)) && !sources.length) code = "PUBLIC_SOURCE_MISSING";
  if (!code && (actions.some(kind => !selected.some(item => item.success && item.actionKinds?.includes(kind))) ||
      claimType === "action" && !selected.some(item => item.success && item.action))) code = "ACTION_RECEIPT_MISSING";
  if (!code && selected.length && selected.every(item => !item.success || !item.nonempty) && !all.some(item => item.success && item.nonempty)) code = "TOOL_EVIDENCE_MISSING";
  const status = code ? "needs_attention" : "completed";
  const reasons = {
    FINISH_EVIDENCE_UNKNOWN: "最终答复引用了不存在的工具证据",
    MODEL_NEEDS_ATTENTION: "任务仍需处理",
    FINAL_ANSWER_MISSING: "模型未给出最终答复",
    CURRENT_WEATHER_EVIDENCE_MISSING: "未取得包含当日日期的天气来源正文，无法确认当前天气",
    CURRENT_SOURCE_MISSING: "未取得支持当前事实的近期公开来源",
    ACTION_RECEIPT_MISSING: "没有记录到请求所需的动作或交付成功回执",
    TOOL_EVIDENCE_MISSING: "工具没有取得可用结果，无法确认请求已完成",
    PUBLIC_SOURCE_MISSING: "公网检索没有取得可用来源，任务尚未完成",
  };
  const citations = [...new Set(sources.map(source => source.url))].slice(0, 10);
  const summary = String(finish.summary || "").trim();
  return { status, code, reason: code ? reasons[code] : null, claimType,
    evidenceToolCallIds: selected.filter(item => item.success && item.nonempty).map(item => item.callId), citations,
    output: (code && code !== "MODEL_NEEDS_ATTENTION" ? "未完成：" + reasons[code] + "\n\n模型提供的未核验答复：\n" : "") + (summary || "未取得可用的最终答复") +
      (citations.length ? "\n\n已读取来源：\n" + citations.join("\n") : "") };
}
