import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncTaskDetail(){");
const end = source.indexOf("const getAgent", start);
const loader = source.slice(start, end);
function harness() {
  const requests = [];
  const context = vm.createContext({
    activeTaskDetail: null, taskDetailRequest: 0, navigationVersion: 0, selected: "a",
    state: { tasks: [{ id: "a", localContext: true }, { id: "b", localContext: true }] },
    visibleTaskId: () => context.selected,
    api: path => new Promise(resolve => requests.push({ path, resolve })),
    encodeURIComponent,
  });
  vm.runInContext(loader, context);
  return { context, requests, load: () => context.syncTaskDetail() };
}

test("local task details are fetched only for the selected task and stale navigation cannot reveal prior output", async () => {
  const h = harness();
  const first = h.load(); assert.equal(h.requests[0].path, "/api/tasks/a");
  h.context.selected = "b"; h.context.navigationVersion++;
  const second = h.load(); assert.equal(h.requests[1].path, "/api/tasks/b");
  h.requests[1].resolve({ id: "b", output: "current result" }); await second;
  h.requests[0].resolve({ id: "a", output: "stale private result" }); await first;
  assert.equal(h.context.activeTaskDetail.id, "b");
  assert.equal(h.context.activeTaskDetail.output, "current result");
});

test("cancel and newer detail reads discard an in-flight private result", async () => {
  const h = harness(); const first = h.load();
  h.context.taskDetailRequest++; h.context.activeTaskDetail = null;
  h.requests[0].resolve({ id: "a", status: "running", output: "late result" }); await first;
  assert.equal(h.context.activeTaskDetail, null);
  const old = h.load(), current = h.load();
  h.requests[2].resolve({ id: "a", status: "cancelled", output: "cancelled" }); await current;
  h.requests[1].resolve({ id: "a", status: "running", output: "obsolete" }); await old;
  assert.equal(h.context.activeTaskDetail.status, "cancelled");
});

test("unselected and ordinary persisted tasks do not fetch private task details", async () => {
  const h = harness(); h.context.selected = null; await h.load();
  h.context.selected = "a"; h.context.state.tasks[0].localContext = false; await h.load();
  assert.equal(h.requests.length, 0);
});
