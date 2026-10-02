import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { id, now } from "./store.mjs";
const require = createRequire(import.meta.url);
export class BrowserBroker {
  constructor(store, { baseUrl, fixtureToken }) {
    this.store = store;
    this.baseUrl = baseUrl;
    this.fixtureToken = fixtureToken;
    this.live = new Map();
    this.browser = null;
    this.launchPromise = null;
    this.closed = false;
    mkdirSync(join(store.dir, "screenshots"), { recursive: true, mode: 0o700 });
  }
  async browserInstance() {
    if (this.closed) throw new Error("浏览器执行器已关闭");
    if (this.browser) return this.browser;
    if (!this.launchPromise)
      this.launchPromise = (async () => {
        const { chromium } = require("playwright");
        const executablePath = process.env.HIGHWAY_BUNDLED_BROWSER==='1'?(process.env.HIGHWAY_BUNDLED_BROWSER_EXECUTABLE||undefined):(
          process.env.HIGHWAY_CHROMIUM_PATH ||
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined));
        return (this.browser = await chromium.launch({
          headless: true,
          executablePath,
          chromiumSandbox: true,
        }));
      })().finally(() => (this.launchPromise = null));
    return this.launchPromise;
  }
  async create(taskId) {
    const session = {
      id: id(),
      taskId,
      status: "agent",
      createdAt: now(),
      records: [],
      plannedTitle: "演示：K18+200 排水沟巡查安排",
      writeLease: false,
    };
    this.store.put("sessions", session.id, session);
    await this.page(session.id);
    return session;
  }
  async page(sessionId) {
    if (this.closed) throw new Error("浏览器执行器已关闭");
    const live = this.live.get(sessionId);
    if (live) return live.page;
    const session = this.store.get("sessions", sessionId);
    if (!session) throw new Error("浏览器会话不存在");
    const browser = await this.browserInstance();
    if (this.closed) throw new Error("浏览器执行器已关闭");
    const context = await browser.newContext({
      viewport: { width: 1120, height: 760 },
      locale: "zh-CN",
      extraHTTPHeaders: { "x-fixture-token": this.fixtureToken },
    });
    try {
      if (this.closed) throw new Error("浏览器执行器已关闭");
      await context.route("**/*", (route) => {
        const u = new URL(route.request().url());
        return u.origin === this.baseUrl ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${this.baseUrl}/fixture/oa?session=${sessionId}`);
      if (this.closed) throw new Error("浏览器执行器已关闭");
      this.live.set(sessionId, { context, page });
      return page;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
  async read(sessionId) {
    const page = await this.page(sessionId);
    await page.reload();
    const text = await page.locator("#records").innerText();
    await this.screenshot(sessionId);
    return text;
  }
  async screenshot(sessionId) {
    const p = await this.page(sessionId);
    const filename = join(this.store.dir, "screenshots", `${sessionId}.png`);
    await p.screenshot({ path: filename, fullPage: true });
    return filename;
  }
  async write(sessionId, signal) {
    let session = this.store.get("sessions", sessionId);
    if (session.status === "manual")
      throw new Error("人工接管中，请先归还控制权");
    if (signal?.aborted) throw new Error("任务已取消");
    const page = await this.page(sessionId);
    await page.reload();
    session = { ...this.store.get("sessions", sessionId), writeLease: true };
    this.store.put("sessions", sessionId, session);
    try {
      await page.locator("#title").fill(session.plannedTitle);
      if (signal?.aborted) throw new Error("任务已取消");
      await page.locator("#submit").click();
      await page.locator("#result").filter({ hasText: "已保存" }).waitFor();
      await this.screenshot(sessionId);
      return this.store.get("sessions", sessionId).records;
    } finally {
      const s = this.store.get("sessions", sessionId);
      this.store.put("sessions", sessionId, { ...s, writeLease: false });
    }
  }
  async takeover(sessionId) {
    let s = this.store.get("sessions", sessionId);
    if (!s) throw new Error("会话不存在");
    s = { ...s, status: "manual", writeLease: false };
    this.store.put("sessions", s.id, s);
    this.store.audit(
      "browser.takeover",
      "人工已接管模拟OA；自动动作暂停",
      s.taskId,
    );
    return s;
  }
  async resume(sessionId) {
    let s = this.store.get("sessions", sessionId);
    if (!s) throw new Error("会话不存在");
    s = { ...s, status: "agent", writeLease: false };
    this.store.put("sessions", s.id, s);
    await this.read(sessionId);
    this.store.audit(
      "browser.resume",
      "已归还控制权并重新读取模拟OA",
      s.taskId,
    );
    return s;
  }
  async stop(sessionId) {
    const live = this.live.get(sessionId);
    if (live) {
      this.live.delete(sessionId);
      await live.context.close();
    }
  }
  async close() {
    this.closed = true;
    if (this.launchPromise) await this.launchPromise.catch(() => {});
    await Promise.all(
      [...this.live.keys()].map((k) => this.stop(k).catch(() => {})),
    );
    await this.browser?.close();
    this.browser = null;
  }
}
export const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function fixtureHtml(session) {
  return `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>模拟 OA · 路衡测试环境</title><style>body{font-family:system-ui;margin:0;background:#f5f7fb;color:#1a3041}header{background:#173447;color:white;padding:24px 38px}main{padding:30px;max-width:950px;margin:auto}section{background:white;padding:26px;border:1px solid #dde4eb;border-radius:14px;margin-bottom:20px}small{color:#718096}h1{font-size:24px}li{padding:12px;border-bottom:1px solid #eee}input{padding:13px;width:75%;border:1px solid #a9bac4;border-radius:8px}button{padding:13px;background:#126a60;color:white;border:0;border-radius:8px;cursor:pointer}.warning{background:#fff2d8;padding:12px;border-radius:8px}#result{padding:12px;color:#126a60}</style><header><b>路衡 · 模拟 OA</b><span style="float:right">本地隔离会话 / ${escapeHtml(session.id.slice(0, 8))}</span></header><main><h1>巡查与养护工作台</h1><p class="warning">全部为虚构测试数据，不连接真实OA。当前控制：${session.status === "manual" ? "人工接管" : "智能体（提交前审批）"}</p><section><h2>待办台账</h2><ul id="records"><li>K18+200 排水沟淤积 · 待安排清理 · 虚构样例</li><li>本周路面巡查12次，一般问题3项，已处理2项 · 虚构样例</li>${session.records.map((r) => `<li>${escapeHtml(r.title)} <small>已保存 / ${escapeHtml(r.createdAt)}</small></li>`).join("")}</ul></section><section><h2>新增演示巡查安排</h2><form id="form"><input id="title" placeholder="输入演示安排（只写入本地测试库）" maxlength="300" required><button id="submit" type="submit">保存安排</button></form><div id="result" role="status"></div><small>智能体必须先获得审批；人工必须先从路衡客户端点击“接管”。</small></section></main><script src="/fixture/script.js"></script></html>`;
}
