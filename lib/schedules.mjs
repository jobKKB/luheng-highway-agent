import { id } from "./store.mjs";

const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map();
const EDITABLE = new Set([
  "title", "prompt", "agentId", "budget", "timezone", "recurrence", "startAt", "status",
]);
const copy = (value) => structuredClone(value);
const iso = (value) => new Date(value).toISOString();

function timestamp(value, label = "时间") {
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${label}无效`);
  return result;
}

function timezoneName(value) {
  if (typeof value !== "string" || value.length > 100 || !/^(UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value))
    throw new Error("时区须为有效的 IANA 名称，例如 Asia/Shanghai");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new Error("时区须为有效的 IANA 名称，例如 Asia/Shanghai");
  }
}

function formatter(timezone) {
  if (!formatters.has(timezone))
    formatters.set(timezone, new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }));
  return formatters.get(timezone);
}

function wallParts(time, timezone) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(time)
    .filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function wallMillis(parts) {
  // setUTCFullYear avoids Date.UTC's special interpretation of years 0..99.
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour || 0, parts.minute || 0, parts.second || 0, 0);
  return date.getTime();
}

/** Resolve one local calendar minute. Gaps are skipped; overlaps use the earlier
 * instant, so a daily/weekly rule never fires twice on a repeated clock minute.
 * Sampling both sides also covers half-hour DST and date-line transitions. */
function resolveWall(parts, timezone) {
  const wall = wallMillis(parts);
  const offsets = new Set();
  for (let hour = -48; hour <= 48; hour += 6) {
    const sample = wall + hour * 60 * MINUTE;
    offsets.add(wallMillis(wallParts(sample, timezone)) - sample);
  }
  const matches = [];
  for (const offset of offsets) {
    const candidate = wall - offset;
    if (wallMillis(wallParts(candidate, timezone)) === wall) matches.push(candidate);
  }
  return matches.length ? Math.min(...matches) : null;
}

function calendarRun(schedule, reference, direction, inclusive) {
  const local = wallParts(reference, schedule.timezone);
  const localDay = wallMillis({ ...local, hour: 0, minute: 0, second: 0 });
  const [hour, minute] = schedule.recurrence.time.split(":").map(Number);
  // One missing weekly wall time can require looking through the next week.
  for (let offset = 0; offset <= 15; offset++) {
    const date = new Date(localDay + direction * offset * DAY);
    if (schedule.recurrence.type === "weekly" && !schedule.recurrence.daysOfWeek.includes(date.getUTCDay())) continue;
    const candidate = resolveWall({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 }, schedule.timezone);
    if (candidate === null || candidate < Date.parse(schedule.startAt)) continue;
    if (direction > 0 ? (inclusive ? candidate >= reference : candidate > reference) : (inclusive ? candidate <= reference : candidate < reference)) return candidate;
  }
  return null;
}

/** Return an ISO instant for the next rule occurrence; after is exclusive by default. */
export function nextOccurrence(schedule, after, { inclusive = false } = {}) {
  const reference = Math.max(timestamp(after), Date.parse(schedule.startAt));
  const beforeStart = timestamp(after) < Date.parse(schedule.startAt);
  if (schedule.recurrence.type === "interval") {
    const period = schedule.recurrence.intervalMinutes * MINUTE;
    const anchor = Date.parse(schedule.startAt);
    const index = Math.max(0, Math.floor((reference - anchor) / period) + ((inclusive || beforeStart) && (reference - anchor) % period === 0 ? 0 : 1));
    return iso(anchor + index * period);
  }
  const result = calendarRun(schedule, reference, 1, inclusive || beforeStart);
  if (result === null) throw new Error("无法计算下一次执行时间");
  return iso(result);
}

function latestDue(schedule, through) {
  const first = Date.parse(schedule.nextRunAt);
  if (schedule.recurrence.type === "interval") {
    const period = schedule.recurrence.intervalMinutes * MINUTE;
    return iso(first + Math.floor((through - first) / period) * period);
  }
  const result = calendarRun(schedule, through, -1, true);
  if (result === null || result < first) return schedule.nextRunAt;
  return iso(result);
}

function normalizeRecurrence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请设置重复规则");
  if (value.type === "interval") {
    if (!Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 525_600)
      throw new Error("执行间隔须为1至525600之间的整数分钟");
    return { type: "interval", intervalMinutes: value.intervalMinutes };
  }
  if (!["daily", "weekly"].includes(value.type)) throw new Error("仅支持 interval、daily、weekly 重复规则");
  if (typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error("执行时间须为 HH:mm 格式");
  if (value.type === "daily") return { type: "daily", time: value.time };
  if (!Array.isArray(value.daysOfWeek) || !value.daysOfWeek.length || value.daysOfWeek.length > 7 || value.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    throw new Error("每周执行日须为0至6的数组（0为周日）");
  return { type: "weekly", time: value.time, daysOfWeek: [...new Set(value.daysOfWeek)].sort() };
}

function normalizeStart(value) {
  const parts = typeof value === "string" && value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/);
  if (!parts)
    throw new Error("起始时间须包含明确时区，例如 2026-10-01T09:00:00+08:00");
  const [year, month, day, hour, minute, second] = parts.slice(1).map((part) => Number(part || 0));
  const calendar = new Date(wallMillis({ year, month, day }));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59)
    throw new Error("起始时间无效，请检查日期和时分秒");
  return iso(timestamp(value, "起始时间"));
}

/** Persistent, local-only recurring task service. All task side effects remain
 * subject to Engine's ordinary permissions and per-action approval gates.
 * Occurrences are claimed before dispatch; Engine.createScheduled is required to
 * atomically deduplicate by occurrence id across the claim/dispatch crash window.
 * No task that already exists is retried or replayed, including failed tasks. */
export class ScheduleService {
  constructor(store, engine, { clock = Date.now, startTimer = true, pollInterval = 1000 } = {}) {
    if (typeof engine?.createScheduled !== "function") throw new Error("调度需要支持幂等创建的任务引擎");
    this.store = store;
    this.engine = engine;
    this.clock = clock;
    this.closed = false;
    this.updateGate = false;
    this.ticking = false;
    this.lastError = null;
    if (startTimer) {
      if (!Number.isInteger(pollInterval) || pollInterval < 100) throw new Error("调度轮询间隔至少为100毫秒");
      this.timer = setInterval(() => {
        try { this.tick(); } catch (error) { this.lastError = String(error.message || error).slice(0, 500); }
      }, pollInterval);
      this.timer.unref();
    }
  }

  list() { return this.store.all("schedules"); }
  get(scheduleId) { return this.store.get("schedules", scheduleId); }
  occurrences(scheduleId) {
    return this.store.all("schedule_occurrences").filter((o) => !scheduleId || o.scheduleId === scheduleId);
  }

  validate(input, { checkAgent = true } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("调度参数无效");
    for (const key of Object.keys(input)) if (!EDITABLE.has(key)) throw new Error(`不支持修改调度字段：${key}`);
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000) throw new Error("任务内容须为1至12000字符");
    const title = input.title === undefined ? input.prompt.trim().slice(0, 80) : input.title;
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("调度名称须为1至200字符");
    const agentId = input.agentId ?? "coordinator";
    const agent = this.store.get("agents", agentId);
    if (checkAgent && !agent?.enabled) throw new Error("所选智能体不存在或已停用");
    const budget = input.budget ?? this.store.get("settings", "main")?.budget ?? 12;
    if (!Number.isInteger(budget) || budget < 1 || budget > 100) throw new Error("任务预算须为1至100的整数");
    const recurrence = normalizeRecurrence(input.recurrence);
    const timezone = timezoneName(input.timezone ?? "Asia/Shanghai");
    if (input.status !== undefined && !["active", "paused"].includes(input.status)) throw new Error("调度状态须为 active 或 paused；取消请使用取消操作");
    return { title: title.trim(), prompt: input.prompt.trim(), agentId, budget, timezone, recurrence, startAt: normalizeStart(input.startAt), status: input.status ?? "active" };
  }

  create(input) {
    const time = timestamp(this.clock());
    const recurrence = normalizeRecurrence(input?.recurrence);
    const startAt = input.startAt ?? iso(time + (recurrence.type === "interval" ? recurrence.intervalMinutes * MINUTE : 0));
    const config = this.validate({ ...input, startAt });
    const schedule = {
      ...config, id: id(), revision: 1, createdAt: iso(time), updatedAt: iso(time),
      nextRunAt: null, lastRunAt: null, lastTaskId: null, lastOccurrenceId: null,
      lastError: null, runCount: 0,
      missedRunPolicy: "coalesce-latest", dstPolicy: "skip-gap-earlier-overlap",
    };
    if (schedule.status === "active") schedule.nextRunAt = nextOccurrence(schedule, startAt, { inclusive: true });
    this.store.transaction(() => {
      this.store.put("schedules", schedule.id, schedule);
      this.store.audit("schedule.created", `${schedule.title} · ${schedule.timezone}`);
    });
    return copy(schedule);
  }

  update(scheduleId, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("调度参数无效");
    for (const key of Object.keys(patch)) if (!EDITABLE.has(key)) throw new Error(`不支持修改调度字段：${key}`);
    return this.store.transaction(() => {
      const existing = this.require(scheduleId);
      if (existing.status === "cancelled") throw new Error("已取消的调度不可恢复，请新建调度");
      const previousConfig = Object.fromEntries([...EDITABLE].map((key) => [key, existing[key]]));
      // Disabling/deleting an agent must never prevent pausing its schedule.
      // A newly selected agent is checked; Engine rechecks existing agents at run time.
      const config = this.validate({ ...previousConfig, ...patch }, { checkAgent: patch.agentId !== undefined && patch.agentId !== existing.agentId });
      const time = timestamp(this.clock());
      const changed = JSON.stringify(previousConfig) !== JSON.stringify(config);
      if (!changed) return existing;
      let schedule = { ...existing, ...config, revision: existing.revision + 1, updatedAt: iso(time), lastError: null };
      const timingChanged = ["timezone", "recurrence", "startAt"].some((key) => JSON.stringify(config[key]) !== JSON.stringify(existing[key]));
      if (schedule.status === "paused") schedule.nextRunAt = null;
      else if (existing.status === "paused" || timingChanged) schedule.nextRunAt = nextOccurrence(schedule, time);
      this.cancelPending(schedule.id, "调度已修改或暂停", time);
      schedule = { ...this.get(schedule.id), ...config, revision: schedule.revision, nextRunAt: schedule.nextRunAt, updatedAt: iso(time), lastError: null };
      this.store.put("schedules", schedule.id, schedule);
      this.store.audit("schedule.updated", `${schedule.title} · ${schedule.status}`);
      return schedule;
    });
  }

  // Paused time is intentionally skipped. Resuming picks the next future slot
  // on the original interval/calendar cadence, rather than replaying paused runs.
  pause(scheduleId) { return this.update(scheduleId, { status: "paused" }); }
  resume(scheduleId) { return this.update(scheduleId, { status: "active" }); }
  cancel(scheduleId) {
    return this.store.transaction(() => {
      const schedule = this.require(scheduleId);
      if (schedule.status === "cancelled") return schedule;
      const time = timestamp(this.clock());
      this.cancelPending(scheduleId, "调度已取消", time);
      const cancelled = { ...this.get(scheduleId), status: "cancelled", nextRunAt: null, updatedAt: iso(time) };
      this.store.put("schedules", scheduleId, cancelled);
      this.store.audit("schedule.cancelled", schedule.title);
      return cancelled;
    });
  }

  require(scheduleId) {
    const schedule = this.get(scheduleId);
    if (!schedule) throw new Error("调度不存在");
    return schedule;
  }

  existingTask(occurrenceId) {
    return this.store.all("tasks").find((task) => task.scheduleOccurrenceId === occurrenceId);
  }

  cancelPending(scheduleId, reason, time) {
    for (const occurrence of this.occurrences(scheduleId).filter((o) => o.status === "pending")) {
      const task = this.existingTask(occurrence.id);
      if (task) this.recordTask(occurrence, task, time);
      else this.store.put("schedule_occurrences", occurrence.id, { ...occurrence, status: "cancelled", cancelledAt: iso(time), error: reason });
    }
  }

  // Caller owns a Store transaction. This also reconciles a committed task when
  // the user pauses/cancels between a prior crash and the next scheduler tick.
  recordTask(occurrence, task, time) {
    const current = this.store.get("schedule_occurrences", occurrence.id);
    if (current.status === "created") return;
    this.store.put("schedule_occurrences", occurrence.id, { ...current, status: "created", taskId: task.id, dispatchedAt: iso(time), attempts: current.attempts + 1, retryAt: null, error: null });
    const schedule = this.get(occurrence.scheduleId);
    const latest = !schedule.lastRunAt || Date.parse(occurrence.scheduledFor) >= Date.parse(schedule.lastRunAt);
    this.store.put("schedules", schedule.id, {
      ...schedule,
      ...(latest ? { lastRunAt: occurrence.scheduledFor, lastTaskId: task.id, lastOccurrenceId: occurrence.id } : {}),
      lastError: null, runCount: schedule.runCount + 1, updatedAt: iso(time),
    });
    this.store.audit("schedule.dispatched", `${schedule.title}${occurrence.coalesced ? " · 离线遗漏已合并为一次" : ""}`, task.id);
  }

  claim(scheduleId, time) {
    if (this.closed || this.updateGate || this.engine.updateGate) return null;
    return this.store.transaction(() => {
      const schedule = this.get(scheduleId);
      if (!schedule || schedule.status !== "active") return null;
      const pending = this.occurrences(scheduleId).find((o) => o.status === "pending");
      if (pending) return pending;
      if (!schedule.nextRunAt || Date.parse(schedule.nextRunAt) > time) return null;
      const scheduledFor = latestDue(schedule, time);
      const occurrenceId = `${schedule.id}:${schedule.revision}:${scheduledFor}`;
      const occurrence = {
        id: occurrenceId, scheduleId, revision: schedule.revision,
        scheduledFor, coalesced: scheduledFor !== schedule.nextRunAt,
        coalescedFrom: scheduledFor !== schedule.nextRunAt ? schedule.nextRunAt : null,
        status: "pending", input: { prompt: schedule.prompt, agentId: schedule.agentId, budget: schedule.budget },
        createdAt: iso(time), taskId: null, attempts: 0, retryAt: null, error: null,
      };
      const existing = this.store.get("schedule_occurrences", occurrenceId);
      this.store.put("schedules", scheduleId, { ...schedule, nextRunAt: nextOccurrence(schedule, time), updatedAt: iso(time) });
      if (existing) return existing.status === "pending" ? existing : null;
      this.store.put("schedule_occurrences", occurrence.id, occurrence);
      return occurrence;
    });
  }

  dispatch(occurrence, time) {
    if (this.closed || this.updateGate || this.engine.closed || this.engine.updateGate) return null;
    if (occurrence.retryAt && Date.parse(occurrence.retryAt) > time && !this.existingTask(occurrence.id)) return null;
    try {
      // This must remain outside the schedule transaction: Engine owns its own
      // atomic deduplication transaction and commits the task before we mark it.
      const task = this.engine.createScheduled(occurrence.id, occurrence.scheduleId, occurrence.input);
      if (!task?.id || typeof task.then === "function") throw new Error("任务引擎未同步返回持久化任务");
      this.store.transaction(() => this.recordTask(occurrence, task, time));
      return task;
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      // A task may already have committed before the error. Keep this occurrence
      // pending so a later tick/restart can find it; never invent a second id.
      this.store.transaction(() => {
        const current = this.store.get("schedule_occurrences", occurrence.id);
        if (!current || current.status !== "pending") return;
        const attempts = current.attempts + 1;
        this.store.put("schedule_occurrences", occurrence.id, { ...current, attempts, retryAt: iso(time + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))), error: message });
        const schedule = this.get(occurrence.scheduleId);
        this.store.put("schedules", schedule.id, { ...schedule, lastError: message, updatedAt: iso(time) });
        if (current.error !== message) this.store.audit("schedule.deferred", `${schedule.title} · ${message}`);
      });
      return null;
    }
  }

  setUpdateGate(enabled) { this.updateGate = enabled === true; }

  tick() {
    if (this.closed || this.updateGate || this.engine.closed || this.engine.updateGate || this.ticking || !this.store.get("settings", "main")?.heartbeat) return [];
    this.ticking = true;
    try {
      const time = timestamp(this.clock());
      const tasks = [];
      for (const schedule of this.list().filter((s) => s.status === "active")) {
        const occurrence = this.claim(schedule.id, time);
        if (occurrence) {
          const task = this.dispatch(occurrence, time);
          if (task) tasks.push(task);
        }
      }
      this.lastError = null;
      return tasks;
    } finally { this.ticking = false; }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
}
