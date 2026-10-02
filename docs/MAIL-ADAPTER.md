# 0.2 邮件适配器：协议、审批与恢复

## 已实现与验证

本模块连接真实 IMAP/SMTP 协议，不是演示收件箱。测试使用本机临时 TLS 服务器和虚构账户，没有连接外部邮箱、使用真实凭据或向第三方发送邮件。

本次独立协议套件：`node --test tests/mail-adapter.test.mjs`，17/17 通过。实际经过 TCP、TLS、认证、IMAP EXAMINE/UID SEARCH/UID FETCH、SMTP EHLO/AUTH/MAIL/RCPT/DATA 往返。TLS 证书验证始终启用，测试信任临时证书，不使用 `rejectUnauthorized:false`。同时验证隐式 TLS 与强制 STARTTLS，确认加密前没有发送认证命令。

依赖精确版本：

- imapflow 2.2.1
- nodemailer 10.0.13
- mailparser 3.9.33

实现依据：[ImapFlow API](https://imapflow.com/docs/api/imapflow-client/)、[IMAP 获取邮件](https://imapflow.com/docs/guides/fetching-messages/)、[Nodemailer SMTPConnection](https://nodemailer.com/extras/smtp-connection)。

## 集成 API

```js
import {MailService} from './lib/mail-adapter.mjs';
const mail = new MailService(store, {
  timeoutMs: 15000,
  getExternalSecrets: () => [/* global + role model keys, internal only */]
});

await mail.configure({
  accountId: 'main',
  from: 'sender@example.com',
  imap: {host: 'imap.example.com', port: 993, secure: true, user: 'sender@example.com', password: 'entered-in-local-settings'},
  smtp: {host: 'smtp.example.com', port: 465, secure: true, user: 'sender@example.com', password: 'entered-in-local-settings'}
});
const accounts = mail.getPublicConfig();
const inbox = await mail.readInbox({accountId: 'main', limit: 50, signal});
const draft = mail.createDraft({accountId: 'main', to: ['recipient@example.com'], subject: '待审核主题', text: '待审核正文', taskId: 'optional-task-id'});
const approval = mail.requestSend(draft.id);
// Only call after an explicit user decision reviewing this exact snapshot.
const result = await mail.decideSend(approval.id, 'approve', {signal});
// Alternative: await mail.decideSend(approval.id, 'reject');
// Alternative: await mail.cancelSend(draft.id);
await mail.close();
```

上述域名与密码是说明占位符，不是可使用的凭据。

其他方法：

- `getPublicConfig(accountId?)`：一个账户或账户数组，只有公开目标与 `hasCredentials: {imap, smtp}`，没有密码；这两个布尔值只表示当前内存有凭据，不证明服务器登录成功
- `getOutbox(id)` / `getApproval(id)`：取得对应持久化记录
- `updateDraft(id, {to?, subject?, text?})`：允许编辑未发送/未进入 DATA 的草稿，旧审批立即失效；新内容必须重新申请审批
- `sanitize(value)`：供服务端 DTO/模型响应清理使用
- `getSecrets()`：仅限服务端脱敏管道的内存读取；绝不能注册为 API 或模型工具，不能写入日志
- `close()`：中止并等待所有进行中的读信/发送操作，清除内存凭据与脱敏历史

需要 Store 提供 `get/put/all/audit/transaction/delete`。正常集成使用应用现有 Store。调用方负责 HTTP 会话、Origin、角色权限、账户归属及用户授权；本模块不会从模型参数自动配置账户，也不会后台自动拉信或发送。

## 持久化结构

使用独立 kind，不覆盖旧版演示邮件：

| kind | 内容 |
|---|---|
| `mail_accounts` | 账户 ID、from、IMAP/SMTP 的 host/port/secure/user、更新时间，不含密码 |
| `mail_inbox` | INBOX 邮件元数据、纯文本预览、UIDVALIDITY、UID、截断标记 |
| `mail_cursors` | accountId + INBOX 对应 UIDVALIDITY、lastUid、账户配置指纹 |
| `mail_outbox` | 草稿不可变内容、内容 hash、Message-ID、审批 ID、发送状态、阶段、尝试次数 |
| `mail_approvals` | 审批状态、完整内容快照、相同内容 hash、draftId、taskId |

审批快照包含 `accountId/from/to/subject/text/messageId/date/transport/transportHash`。`transport` 是当时 SMTP 的 `host/port/secure/user`，用于清楚显示批准的服务商。内容 hash 是固定字段顺序 JSON 的 SHA-256；内容、收件人、发件人、Message-ID 或传输目标改变均不能沿用旧审批。

`decideSend` 返回 outbox 记录本身。成功时含 `status: 'sent'`、accepted/rejected、partial、sentAt 和 SMTP 返回码，不返回原始服务器响应文本。此处 sent 指 SMTP 服务器确认接收，不表示收件人已经看到邮件，也不保证最终投递到收件箱。

## 发送状态与歧义处理

正常流程：

```text
draft → pending_approval → approved → sending → sent
                   └──────────────→ rejected
```

- 未批准不连接 SMTP；拒绝不发送
- 同一审批并发批准共用一次发送操作；完成后重复批准只返回既有终态
- 在 SMTP DATA 前失败/取消：`failed`。不会自动重试；需要用户重新请求并批准后才能再尝试
- DATA 已开始后断线、超时、取消或没有得到最终确认：`unknown`。即使服务器可能尚未投递，也保守视作结果不确定，禁止重试同一 outbox
- 收到最终成功响应：`sent`。取消无法撤回服务器已经确认接收的邮件
- 若部分收件人被拒绝、其余被服务器接收：记录 `sent` 且 `partial:true`，保留 accepted/rejected 列表；不会自动给任何人重发
- 重启发现 `sending`：改为 `unknown`，不猜测、不重新连接
- 重启发现尚未进入发送的 `approved`：改为 `failed/MAIL_INTERRUPTED_BEFORE_SEND`，需要新审批
- `pending_approval` 可跨重启保留，但凭据必须重新输入；重新输入相同目标的凭据不改变已批准内容

SMTP 本身无法在失去最后确认时保证端到端 exactly-once。稳定 Message-ID 有助于人工核查，但不把它当作服务器去重保证。若状态 unknown，应先到邮箱的已发送/服务商记录核查，不能自动换一个草稿重发。

实现采用 Nodemailer 的低层 SMTPConnection 与惰性内容流。只有服务器对 DATA 给出正响应且开始读取消息流时才持久化 `dataStarted`；认证或收件人拒绝后库对流的清理不会误认为 DATA 已发送。此阶段边界由真实协议用例覆盖。

## 读取与 UID 游标

- 只读 INBOX，使用 EXAMINE 与 BODY.PEEK，不设置已读、不删除、不移动邮件
- 持久化 UIDVALIDITY + UID；相同代次已读 UID 不会重复新增
- UIDVALIDITY 或账户配置指纹改变时从新代次重新同步，返回 `uidValidityChanged:true`
- 一页默认 50 封、最多 100 封；一次最多扫描 1000 个 UID 区间，返回 `hasMore`；调用方决定是否再读下一页
- 每封获取最多 65,536 字节原始消息，使用 MailParser 解码纯文本。大邮件返回 `truncated:true`；HTML/附件不渲染、不执行、不下载外部资源
- 游标与取得的消息在同一 SQLite 事务提交；失败或取消不前移游标
- 旧 UIDVALIDITY 代次的缓存保留独立 ID，不覆盖新代次。UI 应显示代次/重置提示，不把旧缓存当作新到邮件

## 凭据与网络边界

- 密码只保存在进程内存；重启后 `hasCredentials` 为 false
- 正常 DTO、审计、邮件记录和 SQLite 中不写密码；提供者回显内容也经过脱敏
- 通过构造器 `getExternalSecrets` 接收全局与各角色模型密钥，和邮件凭据统一脱敏。该回调不得暴露给 HTTP 或模型，不可递归调用本服务 `getSecrets()`
- 轮换前的凭据字符串仅在当前进程保留作脱敏，防止已发起请求迟到回显旧凭据；关闭服务后清空。不声称 JavaScript 字符串能被物理内存安全擦除
- 默认只允许公开网络地址，拒绝私有、回环与保留地址；连接时重新解析、检查全部结果，再固定选定 IP，并使用原始主机名验证 TLS
- IMAP 默认 993 隐式 TLS / 143 强制 STARTTLS；SMTP 默认 465 隐式 TLS / 587 强制 STARTTLS。不能退回明文认证
- TLS 最低 1.2，证书验证启用；生产配置没有关闭验证、代理、自定义 CA 或内网放行选项
- 单次操作有总超时及连接/握手/空闲超时；主动取消关闭对应连接
- IMAP 字面量/响应、SMTP 响应和本地草稿大小有上限

测试例外仅存在构造器：`allowTestLocal:true` 仅允许字面量 `127.0.0.1` 以及随机本机端口；`testTls:{ca: fixture.cert}` 只在该模式可用。不得把这些选项暴露给普通 HTTP 配置或模型工具。

## 测试覆盖

17 项真实协议及持久化测试覆盖：

1. TLS IMAP、MIME 中文文本、分页、UID 去重、重启与 UIDVALIDITY 变化
2. SMTP 审批前不发送、准确正文/主题/收件人、稳定 Message-ID、并发/重复审批去重
3. 内容篡改使审批失效；拒绝及等待审批时取消不连接 SMTP
4. DATA 后断开连接成为 unknown，重启与重复审批均不重发
5. DATA 前/后取消分别 failed/unknown
6. 密码/服务端回显不进入状态、审计、SQLite；不受信任证书被拒绝
7. 读信取消不推进游标；SMTP 超时不发送
8. 中断 sending 恢复 unknown；改账户不能沿用审批
9. 生产网络地址限制与头注入拒绝
10. IMAP/SMTP STARTTLS 握手与加密前无认证
11. 收件人拒绝没有 DATA；编辑草稿重新绑定快照
12. 关闭服务取消读信，轮换前后秘密都只参与内存脱敏
13. 待审批跨重启恢复；approved-before-send 中断后必须新审批
14. DATA 后超时成为 unknown；已取消的信号不启动连接
15. 公开账户字段不能含密码；返回的 taskId 元数据也会脱敏
16. 全局及其他角色模型密钥的 IMAP 回显会脱敏；新建/修改草稿阻止这些内容
17. 草稿创建后才加入的凭据，在批准发送前再次检查并阻止发送

运行条件：Node.js 24+、上述依赖、系统 `openssl`（仅用于测试生成临时证书），不需要外部邮箱账户。

## 尚未接入或验证

- 未使用 Gmail、Microsoft 365 或任何其他真实账户验证登录、策略、投递、限流和服务商兼容性
- 当前配置只暴露用户名/密码方式，可用于服务商允许的应用专用密码。OAuth2 授权/刷新、企业 SSO、2FA 交互尚未实现；不能以普通账户密码替代服务商强制要求的 OAuth2
- 不支持 HTML 发信、附件、CC/BCC、SMTPUTF8 国际化邮箱地址；正文支持 Unicode，地址使用 ASCII
- 不做后台 IMAP IDLE、全邮箱索引、邮件修改/删除、附件解析、自动回复或自动重试
- 不提供 DKIM 私钥、S/MIME、PGP 或邮件签名；这类安全/投递配置应由实际服务商处理
- 没有生产邮件系统渗透测试、长时运行/大邮箱压测或真实断电恢复测试。当前恢复测试验证持久化状态机和故障分支，不承诺第三方邮件系统幂等性
