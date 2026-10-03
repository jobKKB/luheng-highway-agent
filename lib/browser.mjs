/** Compatibility holder for historical task metadata only.
 * Business demos and their browser pages have been removed. Real web work uses
 * ControlledBrowserService and its explicit target / approval boundaries.
 */
export class BrowserBroker {
  constructor(store) { this.store = store; }
  async stop() {}
  async close() {}
  async create() { throw new Error("内置演示浏览器已移除，请配置真实网页目标"); }
  async read() { throw new Error("内置演示浏览器已移除"); }
  async write() { throw new Error("旧版演示审批不再执行"); }
  async screenshot() { throw new Error("旧版演示画面不可用"); }
  async takeover() { throw new Error("旧版演示浏览器不可接管"); }
  async resume() { throw new Error("旧版演示浏览器不可恢复"); }
}
