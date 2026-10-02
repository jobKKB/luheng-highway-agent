import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { Engine } from "../lib/engine.mjs";
import { ScheduleService, nextOccurrence } from "../lib/schedules.mjs";

async function harness(t, initial = "2026-10-01T00:00:00.000Z") {
  const dir = await mkdtemp(join(tmpdir(), "luheng-schedules-"));
  let time = Date.parse(initial), store, service, engine;
  const open = () => {
    store = new Store(dir);
    engine = {
      createScheduled(occurrenceId, scheduleId, input) {
        return store.transaction(() => {
          const existing = store.all("tasks").find((task) => task.scheduleOccurrenceId === occurrenceId);
          if (existing) return existing;
          const task = { ...input, id: `task-${store.all("tasks").length + 1}`, scheduleId, scheduleOccurrenceId: occurrenceId, status: "queued" };
          return store.put("tasks", task.id, task);
        });
      },
    };
    service = new ScheduleService(store, engine, { clock: () => time, startTimer: false });
  };
  open();
  t.after(async () => { service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get service() { return service; }, get engine() { return engine; },
    setTime(value) { time = typeof value === "number" ? value : Date.parse(value); },
    advance(milliseconds) { time += milliseconds; },
    restart() { service.close(); store.close(); open(); },
    create(patch = {}) { return service.create({ title: "测试重复任务", prompt: "整理本地测试资料", timezone: "Asia/Shanghai", recurrence: { type: "interval", intervalMinutes: 5 }, ...patch }); },
  };
}

function rule(timezone, recurrence, startAt = "2026-01-01T00:00:00.000Z") {
  return { timezone, recurrence, startAt };
}

test("interval schedule persists, fires once at its due time, and retains its cadence", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  assert.equal(schedule.nextRunAt, "2026-10-01T00:05:00.000Z");
  assert.deepEqual(h.service.tick(), []);
  h.advance(5 * 60_000);
  const [task] = h.service.tick();
  assert.equal(task.scheduleId, schedule.id);
  assert.equal(task.prompt, schedule.prompt);
  assert.equal(h.service.get(schedule.id).nextRunAt, "2026-10-01T00:10:00.000Z");
  assert.equal(h.service.get(schedule.id).runCount, 1);
  h.service.tick();
  h.restart();
  h.service.tick();
  assert.equal(h.store.all("tasks").length, 1);
  assert.equal(h.service.occurrences(schedule.id).length, 1);
  assert.equal(h.service.get(schedule.id).lastTaskId, task.id);
  h.advance(5 * 60_000);
  h.service.tick();
  assert.equal(h.store.all("tasks").length, 2);
});

test("downtime coalesces arbitrarily many overdue interval runs to one latest occurrence", async (t) => {
  const h = await harness(t);
  const schedule = h.create({ recurrence: { type: "interval", intervalMinutes: 1 } });
  h.setTime("2027-10-01T12:34:56.000Z");
  h.restart();
  assert.equal(h.service.tick().length, 1);
  assert.equal(h.service.get(schedule.id).nextRunAt, "2027-10-01T12:35:00.000Z");
  const [occurrence] = h.service.occurrences(schedule.id);
  assert.equal(occurrence.scheduledFor, "2027-10-01T12:34:00.000Z");
  assert.equal(occurrence.coalescedFrom, "2026-10-01T00:01:00.000Z");
  assert.equal(occurrence.coalesced, true);
  assert.equal(h.service.tick().length, 0);
});

test("daily rules preserve local wall time through spring and fall DST changes", () => {
  const schedule = rule("America/New_York", { type: "daily", time: "09:00" });
  assert.equal(nextOccurrence(schedule, "2026-03-07T14:00:00.000Z"), "2026-03-08T13:00:00.000Z");
  assert.equal(nextOccurrence(schedule, "2026-10-31T13:00:00.000Z"), "2026-11-01T14:00:00.000Z");
  assert.equal(nextOccurrence(schedule, "2026-03-08T13:00:00.000Z", { inclusive: true }), "2026-03-08T13:00:00.000Z");
});

test("nonexistent local times are skipped and repeated times fire only the earlier instant", () => {
  const spring = rule("America/New_York", { type: "daily", time: "02:30" });
  assert.equal(nextOccurrence(spring, "2026-03-07T07:30:00.000Z"), "2026-03-09T06:30:00.000Z");
  const fall = rule("America/New_York", { type: "daily", time: "01:30" });
  assert.equal(nextOccurrence(fall, "2026-10-31T05:30:00.000Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(nextOccurrence(fall, "2026-11-01T05:30:00.000Z"), "2026-11-02T06:30:00.000Z");
  assert.equal(nextOccurrence(fall, "2026-11-01T06:00:00.000Z"), "2026-11-02T06:30:00.000Z");
});

test("timezone arithmetic supports half-hour DST and non-hour UTC offsets", () => {
  const gap = rule("Australia/Lord_Howe", { type: "daily", time: "02:15" });
  assert.equal(nextOccurrence(gap, "2026-10-02T15:45:00.000Z"), "2026-10-04T15:15:00.000Z");
  const overlap = rule("Australia/Lord_Howe", { type: "daily", time: "01:45" });
  assert.equal(nextOccurrence(overlap, "2026-04-03T14:45:00.000Z"), "2026-04-04T14:45:00.000Z");
  assert.equal(nextOccurrence(overlap, "2026-04-04T14:45:00.000Z"), "2026-04-05T15:15:00.000Z");
  const nepal = rule("Asia/Kathmandu", { type: "daily", time: "09:00" });
  assert.equal(nextOccurrence(nepal, "2026-10-01T00:00:00.000Z"), "2026-10-01T03:15:00.000Z");
});

test("weekly rules use local weekday and can skip a DST-gap week", () => {
  const shanghai = rule("Asia/Shanghai", { type: "weekly", time: "07:30", daysOfWeek: [1, 5] });
  assert.equal(nextOccurrence(shanghai, "2026-10-01T22:00:00.000Z"), "2026-10-01T23:30:00.000Z");
  assert.equal(nextOccurrence(shanghai, "2026-10-01T23:30:00.000Z"), "2026-10-04T23:30:00.000Z");
  const weeklyGap = rule("America/New_York", { type: "weekly", time: "02:30", daysOfWeek: [0] });
  assert.equal(nextOccurrence(weeklyGap, "2026-03-01T07:30:00.000Z"), "2026-03-15T06:30:00.000Z");
});

test("daily downtime coalescing uses latest due local time on either side of DST", async (t) => {
  const h = await harness(t, "2026-03-06T00:00:00.000Z");
  const schedule = h.create({ timezone: "America/New_York", recurrence: { type: "daily", time: "09:00" } });
  h.setTime("2026-03-09T12:59:00.000Z");
  h.restart();
  assert.equal(h.service.tick().length, 1);
  assert.equal(h.service.occurrences(schedule.id)[0].scheduledFor, "2026-03-08T13:00:00.000Z");
  assert.equal(h.service.get(schedule.id).nextRunAt, "2026-03-09T13:00:00.000Z");
  h.setTime("2026-03-09T13:00:00.000Z");
  assert.equal(h.service.tick().length, 1);
});

test("interval cadence is elapsed minutes, independent of DST and later wall-clock rollback", async (t) => {
  const h = await harness(t, "2026-11-01T04:30:00.000Z");
  const schedule = h.create({ timezone: "America/New_York", recurrence: { type: "interval", intervalMinutes: 60 } });
  h.setTime("2026-11-01T05:30:00.000Z"); h.service.tick();
  h.setTime("2026-11-01T06:30:00.000Z"); h.service.tick();
  assert.equal(h.store.all("tasks").length, 2);
  assert.equal(h.service.get(schedule.id).nextRunAt, "2026-11-01T07:30:00.000Z");
  h.setTime("2026-11-01T05:30:00.000Z");
  assert.equal(h.service.tick().length, 0);
});

test("pause skips paused runs, resume uses next original slot, cancellation is permanent", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  assert.equal(h.service.pause(schedule.id).nextRunAt, null);
  h.setTime("2026-10-02T00:02:00.000Z");
  h.restart();
  assert.equal(h.service.tick().length, 0);
  assert.equal(h.service.resume(schedule.id).nextRunAt, "2026-10-02T00:05:00.000Z");
  h.setTime("2026-10-02T00:05:00.000Z");
  const [task] = h.service.tick();
  assert.equal(h.service.cancel(schedule.id).status, "cancelled");
  assert.equal(h.service.cancel(schedule.id).status, "cancelled");
  h.advance(24 * 60 * 60_000);
  h.restart();
  assert.equal(h.service.tick().length, 0);
  assert.equal(h.store.get("tasks", task.id).status, "queued", "cancelling recurrence must not alter an existing task");
  assert.throws(() => h.service.resume(schedule.id), /已取消/);
});

test("edits preserve content-only timing, rebase changed timing, and use current input", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  const edited = h.service.update(schedule.id, { prompt: "更新后的测试内容", title: "新名称" });
  assert.equal(edited.revision, 2);
  assert.equal(edited.nextRunAt, schedule.nextRunAt);
  h.advance(5 * 60_000);
  assert.equal(h.service.tick()[0].prompt, "更新后的测试内容");
  h.setTime("2026-10-01T00:06:00.000Z");
  const changed = h.service.update(schedule.id, { recurrence: { type: "daily", time: "09:00" } });
  assert.equal(changed.nextRunAt, "2026-10-01T01:00:00.000Z");
  assert.equal(changed.revision, 3);
  assert.equal(h.service.update(schedule.id, { title: "新名称" }).revision, 3, "no-op patch is not a new schedule revision");
});

test("explicit future start is a lower bound and explicit past start coalesces once", async (t) => {
  const h = await harness(t);
  const future = h.create({ recurrence: { type: "daily", time: "09:00" }, startAt: "2026-10-10T12:00:00+08:00" });
  assert.equal(future.nextRunAt, "2026-10-11T01:00:00.000Z");
  const old = h.create({ startAt: "2020-01-01T00:00:00Z" });
  assert.equal(h.service.tick().length, 1);
  assert.equal(h.service.occurrences(old.id)[0].scheduledFor, "2026-10-01T00:00:00.000Z");
});

test("heartbeat disable gates recurring creation and reenable performs one catch-up", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  const settings = h.store.get("settings", "main");
  h.store.put("settings", "main", { ...settings, heartbeat: false });
  h.advance(60 * 60_000);
  h.restart();
  assert.deepEqual(h.service.tick(), []);
  h.store.put("settings", "main", { ...settings, heartbeat: true });
  assert.equal(h.service.tick().length, 1);
  assert.equal(h.service.get(schedule.id).nextRunAt, "2026-10-01T01:05:00.000Z");
});

test("crash after occurrence claim before task creation recovers the same persisted occurrence", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  h.advance(5 * 60_000);
  h.engine.createScheduled = () => { throw new Error("测试模拟任务队列暂不可用"); };
  assert.equal(h.service.tick().length, 0);
  const [pending] = h.service.occurrences(schedule.id);
  assert.equal(pending.status, "pending");
  assert.equal(h.service.get(schedule.id).nextRunAt, "2026-10-01T00:10:00.000Z");
  h.restart();
  assert.equal(h.service.tick().length, 0, "persisted backoff is respected");
  h.advance(2000);
  const [task] = h.service.tick();
  assert.equal(task.scheduleOccurrenceId, pending.id);
  assert.equal(h.service.occurrences(schedule.id)[0].status, "created");
  h.restart(); h.service.tick();
  assert.equal(h.store.all("tasks").length, 1);
});

test("crash after task commit before dispatch acknowledgement never duplicates or replays a task", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  h.advance(5 * 60_000);
  const create = h.engine.createScheduled.bind(h.engine);
  h.engine.createScheduled = (...args) => { const task = create(...args); h.store.put("tasks", task.id, { ...task, status: "failed" }); throw new Error("测试模拟任务写入后中断"); };
  h.service.tick();
  const [pending] = h.service.occurrences(schedule.id);
  assert.equal(pending.status, "pending");
  assert.equal(h.store.all("tasks").length, 1);
  h.restart();
  const [task] = h.service.tick();
  assert.equal(task.status, "failed", "existing failed task must not be rerun");
  assert.equal(task.scheduleOccurrenceId, pending.id);
  assert.equal(h.store.all("tasks").length, 1);
  assert.equal(h.service.get(schedule.id).runCount, 1);
  assert.equal(h.service.occurrences(schedule.id)[0].status, "created");
});

test("repeated deferred ticks back off without building a task/occurrence/audit storm", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  h.advance(5 * 60_000);
  let calls = 0;
  h.engine.createScheduled = () => { calls++; throw new Error("测试队列已满"); };
  h.service.tick();
  for (let i = 0; i < 20; i++) h.service.tick();
  assert.equal(calls, 1);
  h.advance(2_000); h.service.tick();
  assert.equal(calls, 2);
  h.advance(60 * 60_000); h.service.tick();
  assert.equal(h.service.occurrences(schedule.id).length, 1);
  assert.equal(h.store.all("audit").filter((a) => a.action === "schedule.deferred").length, 1);
  assert.equal(h.store.all("tasks").length, 0);
});

test("pause, edit, and cancel invalidate uncreated pending work instead of replaying it", async (t) => {
  for (const action of ["pause", "update", "cancel"]) {
    const h = await harness(t);
    const schedule = h.create();
    h.advance(5 * 60_000);
    h.engine.createScheduled = () => { throw new Error("测试创建被阻止"); };
    h.service.tick();
    if (action === "update") h.service.update(schedule.id, { prompt: "替换后的内容" });
    else h.service[action](schedule.id);
    assert.equal(h.service.occurrences(schedule.id)[0].status, "cancelled");
    h.restart();
    h.advance(2000);
    h.service.tick();
    assert.equal(h.store.all("tasks").length, 0);
  }
});

test("cancelling after a task committed recovers its history without cancelling or recreating the task", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  h.advance(5 * 60_000);
  const create = h.engine.createScheduled.bind(h.engine);
  h.engine.createScheduled = (...args) => { create(...args); throw new Error("测试模拟提交后的中断"); };
  h.service.tick();
  const cancelled = h.service.cancel(schedule.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.runCount, 1);
  assert.ok(cancelled.lastTaskId);
  assert.equal(h.service.occurrences(schedule.id)[0].status, "created");
  assert.equal(h.store.get("tasks", cancelled.lastTaskId).status, "queued");
  h.restart(); h.service.tick();
  assert.equal(h.store.all("tasks").length, 1);
});

test("disabled agents can still have their existing schedules paused and cancelled", async (t) => {
  const h = await harness(t);
  const schedule = h.create();
  h.store.put("agents", "coordinator", { ...h.store.get("agents", "coordinator"), enabled: false });
  assert.equal(h.service.pause(schedule.id).status, "paused");
  assert.equal(h.service.cancel(schedule.id).status, "cancelled");
});

test("multiple scheduler instances share atomic occurrence claims", async (t) => {
  const h = await harness(t);
  h.create();
  h.advance(5 * 60_000);
  const second = new ScheduleService(h.store, h.engine, { clock: () => Date.parse("2026-10-01T00:05:00.000Z"), startTimer: false });
  t.after(() => second.close());
  h.service.tick(); second.tick(); h.service.tick();
  assert.equal(h.store.all("tasks").length, 1);
  assert.equal(h.store.all("schedule_occurrences").length, 1);
});

test("validation rejects malformed rules, unsafe timing ambiguity, readonly fields, and disabled agents", async (t) => {
  const h = await harness(t);
  for (const patch of [
    { recurrence: { type: "interval", intervalMinutes: 0 } },
    { recurrence: { type: "interval", intervalMinutes: 1.5 } },
    { recurrence: { type: "interval", intervalMinutes: 525601 } },
    { recurrence: { type: "monthly", time: "09:00" } },
    { recurrence: { type: "daily", time: "24:00" } },
    { recurrence: { type: "weekly", time: "09:00", daysOfWeek: [] } },
    { recurrence: { type: "weekly", time: "09:00", daysOfWeek: [7] } },
    { timezone: "Imaginary/Timezone" }, { timezone: "+08:00" },
    { startAt: "2026-10-01T09:00" }, { startAt: "not a date" },
    { startAt: "2026-02-30T09:00:00Z" }, { startAt: "2026-10-01T24:00:00Z" },
    { prompt: "   " }, { budget: 0 }, { agentId: "missing" },
    { status: "cancelled" }, { nextRunAt: "2026-10-01T00:00:00Z" },
  ]) assert.throws(() => h.create(patch));
  const schedule = h.create();
  assert.throws(() => h.service.update(schedule.id, { revision: 999 }));
  assert.throws(() => h.service.update(schedule.id, { budget: 101 }));
  assert.equal(h.service.get(schedule.id).revision, 1);
  h.store.put("agents", "coordinator", { ...h.store.get("agents", "coordinator"), enabled: false });
  assert.throws(() => h.create(), /已停用/);
});

test("real engine attaches occurrence identity, enforces task limits, and deduplicates existing failures", async (t) => {
  const h = await harness(t);
  const engine = new Engine(h.store, { close: async () => {} }, { delay: 1 });
  // Direct synchronous creation validates the actual engine hook without model,
  // browser, mail, or any other external effect.
  const first = engine.createScheduled("safe-test-occurrence", "safe-test-schedule", { prompt: "测试本地资料", agentId: "coordinator", budget: 3 });
  assert.equal(first.scheduleOccurrenceId, "safe-test-occurrence");
  h.store.put("tasks", first.id, { ...first, status: "failed" });
  const again = engine.createScheduled("safe-test-occurrence", "safe-test-schedule", { prompt: "不要重放此任务" });
  assert.equal(again.id, first.id);
  assert.equal(again.status, "failed");
  assert.equal(h.store.all("tasks").length, 1);
  for (let index = 0; index < 30; index++) engine.createScheduled(`capacity-${index}`, "safe-test-schedule", { prompt: "容量限制测试" });
  assert.throws(() => engine.createScheduled("capacity-overflow", "safe-test-schedule", { prompt: "不得超出容量" }), /30/);
  assert.equal(engine.createScheduled("safe-test-occurrence", "safe-test-schedule", { prompt: "不应再次创建" }).id, first.id);
  await engine.close();
});

test("local service timer ticks while open and stops on close", async (t) => {
  const h = await harness(t);
  let time = Date.parse("2026-10-01T00:00:00.000Z");
  const timed = new ScheduleService(h.store, h.engine, { clock: () => time, pollInterval: 100 });
  t.after(() => timed.close());
  const schedule = timed.create({ prompt: "计时器本地测试", timezone: "UTC", recurrence: { type: "interval", intervalMinutes: 1 } });
  time += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(timed.get(schedule.id).runCount, 1);
  timed.close(); time += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(timed.get(schedule.id).runCount, 1);
  assert.deepEqual(timed.tick(), []);
});
