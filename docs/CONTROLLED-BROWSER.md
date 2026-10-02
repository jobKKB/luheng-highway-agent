# 受控通用浏览器服务（0.2）

## 能力和真实边界

`lib/controlled-browser.mjs` 实现按显式目标白名单运行的隔离 Chromium 服务。它根据实际页面读取控件，支持普通文本字段的 `fill` 和可见控件的 `click`；代码没有写死某一个 OA 的 DOM。

本版本用两个不同的自有虚构网站做功能验证：带自动保存的巡查列表/表单，以及不同结构的工单详情页。没有连接或验收真实 OA、真实账户或外部生产站点。`completed` 表示获批输入批次已派发并完成观察，**不等于业务保存成功**；调用方还要检查返回的页面证据。

原生 Chromium 功能回归不代替独立安全审计。本轮独立安全复核未完成，不能声称已经通过生产安全验收。

## 目标配置和网络约束

- 每个目标包含 `id`、`name`、`startUrl` 和可选的 `allowedOrigins`，默认只允许起始 URL 的 origin。无通配符。
- 真实模式只接受公网 HTTPS 443。用户信息、明显认证查询参数、回环/内网/保留地址和含私有地址的 DNS 结果被拒绝。
- 保存配置会解析域名检查，但不会打开目标页面。`open` 会再次检查 DNS。
- 每个会话独立启动 Chromium 进程、临时浏览器配置及 BrowserContext，不使用用户已有浏览器、Cookie 或登录资料。
- 每个进程使用自己的有随机认证的回环代理。目标 DNS 结果固定为经过校验的 IP；代理直接连接该 IP，防止会话内重新解析到私有地址。
- Chromium 禁止直接目标 DNS、关闭 QUIC，并限制非代理 WebRTC UDP。没有改动操作系统代理、网络设置或关闭 Chromium sandbox。
- Playwright 路由再次校验精确 origin，包含重定向、资源和 iframe。新窗口、WebSocket、Service Worker、下载、文件选择、权限请求和脚本对话框不作为受支持功能开放。
- 非读取 HTTP 方法在无获批输入窗口时被阻止，包括页面加载后自行发起的 POST。因此，依赖 POST/GraphQL 才能加载数据的网站可能无法工作；不能为兼容性直接放开所有写请求。
- 输入之后使用本会话请求活动计数，等待新的 350ms 网络安静期，最长 2.5s。仍未确认的写请求产生未知结果，不自动重试。更晚触发的延迟自动保存可能被阻止。
- `allowTestLocal:true` 仅供内部构造测试实例，允许 `http://127.0.0.1:端口`。它不是目标配置字段，也不能从 HTTP 请求或模型参数设置。生产对象即使读到持久化测试目标，也会拒绝打开。

这些措施是应用级边界，不是操作系统级出口防火墙或浏览器漏洞的防护证明。正式部署仍需独立代码审计、目标兼容性测试和单位网络策略。网页 GET 或页面自身脚本也可能有服务端副作用，不能仅根据方法名证明“纯读取”；应只配置用户明确授权且信任的目标。

## API 合同

```js
const service = new ControlledBrowserService(store, {
  dataDir,
  getExternalSecrets: () => activeGlobalRoleAndMailSecrets,
  // allowTestLocal 默认为 false，只能由内部测试构造函数启用
});

await service.configureTargets([
  { id: 'work', name: '授权工作站点', startUrl: 'https://approved.example.com/',
    allowedOrigins: ['https://approved.example.com'] }
]);
service.listTargets();
const { session, observation } = await service.open(taskId, 'work');
const fresh = await service.read(session.id);
const file = await service.screenshot(session.id); // 仅服务端使用的本地 PNG 路径

const approval = await service.proposeActions(session.id, {
  observationId: fresh.observationId,
  actions: [
    { type: 'fill', controlId: 'c0', value: '待用户确认的文字' },
    { type: 'click', controlId: 'c1' }
  ],
  reason: '说明目标和预期业务影响'
});
// 以下接口只能由经过认证的人类确认流程调用，不能注册为模型工具
const result = await service.decide(approval.id, {
  decision: 'approve', // 或 reject
  digest: approval.digest
});
```

`read` 返回 `sessionId`、`observationId`、`pageVersion`、`url`、`title`、`text`、`frames`、`controls`。控件包含可读名称、类型、当前安全值、是否可填写及是否敏感。`controlId` 只属于那一次观察，不是永久选择器。

模型和客户端不能提交任意 CSS/XPath/JavaScript。服务内部使用固定的只读 DOM 检查代码生成定位证据；未提供任意 JS、evaluate、shell、网络请求或本地文件工具。

`getPublicState()` 返回 `{ targets, sessions, approvals }`。它不含人工控制租约。截图路径由服务端消费，不应直接返回磁盘路径给网页；HTTP 截图端点必须先检查会话和认证。

## 审批和幂等

- 规划动作不会触发输入；**首次 fill 也必须先批准**，因为填字可能立即触发自动保存。
- 审批摘要绑定目标版本、任务和会话、原始页面观察、控件定位/身份、链接或表单目标、动作顺序、值、理由、有效期。
- 批准时重新观察页面，DOM 或目标变化后旧提案失效。每个动作前再检查相同控件，不猜测替代控件。
- 并发批准同一提案只执行一次。完成、拒绝、取消、过期、未知结果都不会隐式重放。
- 服务在输入前持久化执行状态；重启时正在执行的操作标记为 `unknown`，旧浏览器会话标记为 `interrupted`。不自动重建登录态或重放输入。
- 取消可能发生在输入已经被页面接收之后。此时不能保证回滚，只能标记未知结果，让用户核实。
- 每批最多 8 个动作，文本值最多 4000 字符，最多 4 个运行中会话，最多 12 个目标。

## 人工独占控制

```js
const takeover = await service.takeover(sessionId);
// leaseToken 只保存在当前网页 JS 内存中，不保存到 localStorage/日志/数据库/模型消息
const manual = await service.manualAction(sessionId, {
  leaseToken: takeover.leaseToken,
  observationId: takeover.observation.observationId,
  action: { type: 'fill', controlId: 'c0', value: '用户手动指定的文字' }
});
const resumed = await service.resume(sessionId, { leaseToken: takeover.leaseToken });
await service.cancel(sessionId);
await service.close();
```

接管会等待当前已派发的动作结束，并停止余下批次；不会把同一个会话同时交给两个人工租约。人工状态下智能体批准请求返回 `blocked: 'MANUAL_LEASE'`。恢复时重新观察页面，接管前的待批提案全部失效，需基于新证据重新规划和批准。

人工操作仍是受控的普通 fill/click，而不是现有用户浏览器的无限远程控制；密码、验证码、API Key、付款信息或文件输入依然拒绝。丢失租约的页面不能恢复旧租约，应显式关闭该会话后重建。模型工具列表绝不能包含 `decide`、`takeover`、`manualAction` 或 `resume`。

## 凭据与截图

- `getExternalSecrets` 是服务端回调，动态提供当前全局/角色 API Key 及邮件密码；凭据历史只保留在进程内存，避免轮换后的旧值再次出现在观察结果中。
- 在持久化和返回页面观察之前进行脱敏。已知凭据不能作为目标配置、输入值或审批理由，也不能被浏览器请求 URL/请求体带出。
- 密码和识别到的敏感字段不返回值，并禁止自动输入。
- 截图前重新检查可读文本和普通输入值。如果含已知凭据，使用截图遮罩覆盖整个页面 body；否则遮盖识别到的敏感字段。不修改源页面文字。
- 不声称能识别图片、Canvas、OCR、任意编码或未知凭据。工作页面本身可能含其他业务隐私，截图和观察仍需按单位要求保管。
- SQLite 使用既有 Store；新增记录类别为 `browser_targets`、`controlled_sessions`、`browser_approvals`。截图在数据目录 `controlled-screenshots/`，文件权限为 0600。

## 验证和使用限制

```sh
node --test tests/controlled-browser.test.mjs
node --test tests/controlled-engine.test.mjs
```

真实 Chromium 测试必须在支持 Chromium sandbox 的正常开发/图形主机运行。受限 shell 的 Unix socket 错误不应该通过 `--no-sandbox` 解决。

功能测试覆盖两种不同 DOM 的真实输入和保存、填字自动保存审批、拒绝无输入、并发批准只保存一次、人工接管/恢复、会话 Cookie/localStorage 隔离、非白名单重定向/iframe/fetch/WebSocket 拦截、取消/未知不重放、凭据脱敏与截图遮罩像素、动作摘要篡改拒绝。具体执行结果以 `artifacts/controlled-browser-tests.txt`、`controlled-engine-tests.txt` 和 UI 测试报告为准。

目前没有验证真实公网 HTTPS 站点、企业 SSO、多因素认证、真实登录或内网 OA；不支持任意自定义控件、文件上传、下载、拖拽和无界长任务。首次正式接入一个新站点都应单独做兼容性和权限验收。

参考：[Playwright BrowserContext 路由和 Service Worker 说明](https://playwright.dev/docs/api/class-browsercontext)、[Chromium 代理与 DNS 设置](https://www.chromium.org/developers/design-documents/network-stack/socks-proxy/)、[WebRTC 代理要求 RFC8828](https://www.rfc-editor.org/rfc/rfc8828.html)。
