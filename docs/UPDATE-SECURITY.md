# Windows 客户端内更新（手动可见安装）

本实现只支持已打包的 Windows x64 当前用户安装。Mac、开发态、全用户/HKLM 安装、非当前账户拥有或不可写的安装目录保持不支持。没有后台定时检查、自动下载、静默安装或自动回滚。

## 使用方式与事实

1. 设置 → 版本与更新 → 检查更新。默认正式版渠道。只有用户明确在面板选择测试版渠道并点击检查，才可包含 GitHub prerelease；显示当前真实版本、新版、发布说明、字节数、固定来源及未签名提示
2. 用户点击下载完整安装包，可取消或从头重试。文件仅写入当前账户私有 updates 缓存；大小、MZ、SHA-256、来源/重定向、目录权限和空间检查失败不会进入可安装状态
3. 点击请求安装后，主进程再次核对文件、当前用户安装及安装卷，显示原生确认。取消保持现有运行状态
4. 同意后后端原子暂停新任务、定时分发和修改请求。正在运行的模型任务、SMTP/IMAP、本机操作、正在接收的请求或任何存活的受控浏览器会话都阻止安装；不会强制终止并当作成功
5. 后端明确完成 engine/mail/browser/SQLite 关闭并正常退出，才由 Electron shell.openPath 通过正常 Windows Shell 打开带 Zone.Identifier Internet zone 的安装包。没有 /S、runas、自动提权或裸 EXE spawn；系统提示由用户决定
6. Shell 接受打开请求只代表向系统提交打开，界面不会显示安装成功。正常 NSIS 向导完成后由 runAfterFinish 启动新版；只有随后启动的 app.getVersion 与后端 /health.version 均等于目标版本，才报告更新已核对

安装器未签名。GitHub 同源 digest 与 HTTPS 只能验证下载/传输完整性，不能独立认证发布者。没有关闭 Authenticode 校验、绕过 SmartScreen、清除来源标记、修改系统安全策略、证书采购、账户或访问权限修改。

互联网标记/ACL/路径检查失败时停止安装并给出错误。Windows Shell 返回打开错误时清除待确认标记并重新启动本地后端；仅内存中的凭据需重填。关闭握手未成功绝不启动安装器。Shell/System UI 请求尚未完成时锁定重复安装，不超时启动第二份安装器。

保存数据、窗口状态、桌面偏好和用户明确保存的加密凭据仍在原 APPDATA/LuhengOfficeAgent；更新不会自动保存凭据。待审批、未知外部操作和队列不会因安装请求自动重放。数据库迁移与同账户 DPAPI 恢复仍须真实 Windows 两版本测试。内存 Key、未保存输入会随退出丢失。

下载空间门槛为 2×安装包大小 + 128 MiB；安装卷门槛为保守 2 GiB，并非精确解包空间保证。断电、NSIS 中途失败或新版启动失败没有可靠自动回滚保证；请从固定官方发布页重新安装修复，不自动降级数据库。

旧 0.5.1/0.5.2 安装包没有此更新功能，需先手动安装一次带更新器的新基线。之后在线更新的真实验收需要另一份更高版本且同样带更新器的完整安装包。

## 发布源与边界

- 固定 jobKKB/luheng-highway-agent，仓库 ID 1400818714；禁止仓库身份漂移/转移重定向
- 未认证 Release 列表最多 3 页，默认 stable 渠道，显式用户选择的 preview 渠道；stable 只接受数字标签且非 prerelease，preview 可接受严格 vN.N.N 或 vN.N.N-beta.2 类 SemVer 预发布标签（必须 GitHub prerelease=true），拒绝 build metadata，按 SemVer 比较最高适用版本、精确 uploaded EXE 资产名、大小、content_type、SHA-256 digest、URL/ID；本机版本可为严格 SemVer candidate，远端候选始终绑定渠道与固定源，切回正式版即使网络失败也使旧测试版候选失效
- `/releases/latest` 不用于检查；404、限流、无发布、坏元数据/网络错误与已是最新版区分
- 独立内存更新 session 不发送应用 Cookie、令牌、模型 Key、邮箱信息、referrer 或任务内容；ETag/冷却仅在内存。进度轮询只读取缓存
- 每跳 HTTPS 手动校验，最多 5 跳，只允许精确 GitHub 下载 URL 与已观测 CDN release-assets.githubusercontent.com/github-production-release-asset/1400818714/UUID。2026-10-03 HEAD 验证 GitHub302 → 此 CDN200，未转移二进制正文
- 超时：首字节15秒、空闲30秒、下载总30分钟；严格有界流式写入与背压，独占 partial、fsync、原子改名；不做 Range/断点续传
- 使用当前用户私有新目录的固定 DACL 脚本和读回，拒绝符号链接/junction/reparse/异常 hardlink。原生真实 DACL 与 MOTW 行为在 Linux 无法证明
- 设置面板独立更新文本、进度和按钮，不替换模型设置表单，不保存 Key 或用户草稿
- 只扩展 main ↔ utility 私有固定 RPC 与固定控制消息，没有 ipcMain/preload/renderer 任意文件执行接口

公开 Release 只读快照：2026-10-03 15:50:52 UTC 返回 v0.5.1，release 402471888，prerelease，asset 607666172，244044118 字节，sha256 ca6b08b01335de50ca8feab4df6dc41919e979bcd1d7497cdb57713663f62e14。当时公开列表没有 v0.5.2；不能由此推断私有 draft 是否存在。

## 验收层级（不要混称已上线）

已在 dot Linux 云端验证纯模块与协议夹具、状态机、真实文件读写、Node IPC 侧车关闭握手、认证 API/安装闸门及不重建 DOM 合同。所有 EXE 字节均为非可运行合成夹具；未真实下载或执行 Windows 安装器。

还需要由父发布任务安排隔离 Windows CI/云桌面，绑定两份真实带更新器产物：commit、version、release/asset id、bytes、SHA-256、asar 内 updater、appId/dataRoot、HKCU DisplayVersion。scripts/verify-windows-online-update.mjs 仅做两份产物的静态门禁，不运行安装器、不能证明在线闭环。

真实交互验收必须逐项记录：

- 当前标准用户、HKCU 安装、无自动提权；NSIS 当前用户选择被固定（v26 include customInstallMode/customInit）
- 当前账户缓存 DACL/owner、祖先 reparse 拒绝、NTFS Zone.Identifier=3，以及正常 Shell/Attachment Manager 实际安全提示。禁止 Unblock-File、策略调整或裸 EXE 启动来“通过”
- 确认取消无退出/安装；下载取消/错误/重试；任务/邮件/本机/网页活动拒绝安装；关闭超时从不打开安装器
- 真实在线 asset 精确 bytes/hash，后端正常关闭后才打开可见 NSIS；Shell/OS 拒绝不误报成功；重复点击只有一份安装器
- 覆盖安装完成、NSIS 启动新版、app/backend/HKCU版本一致；无旧 payload、只有一份卸载记录
- 原数据目录、SQLite integrity_check、已有文件、窗口/桌面偏好、同账户加密凭据恢复；队列/审批/未知动作没有重放
- 在尚未改 payload 前取消安装向导，当前版本仍能打开。安装过程中断/断电不作无损回滚承诺

GitHub-hosted runner 可能为管理员、没有普通桌面安全提示；静默安装脚本通过不能冒充本功能普通 Shell/SmartScreen/标准用户交互验收。

## 官方依据

- [Electron 44.5.1 ClientRequest](https://github.com/electron/electron/blob/v44.5.1/docs/api/client-request.md)
- [Electron 44.5.1 net transport implementation](https://github.com/electron/electron/blob/v44.5.1/lib/common/api/net-client-request.ts)
- [Electron Shell](https://www.electronjs.org/docs/latest/api/shell)
- [GitHub Releases REST](https://docs.github.com/en/rest/releases/releases?apiVersion=latest)
- [Windows IAttachmentExecute](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iattachmentexecute)
- [electron-builder v26 NSIS](https://www.electron.build/v26/docs/nsis/)

未使用 electron-updater/v27 签名 manifest。保留 electron-builder 26.15.3、publish:null 和 --publish never。

## 2026-10-03 通道修订

原第一片默认 preview 仅支持数字发布标签；本修订默认 stable，测试版必须用户明确选择，且选择本身不会发起检查。仅在点击检查时把确切 channel enum 传入 main。通道选择只在运行内存，不自动订阅、持久保存或打开安装器。严格 v0.6.0-beta.1 → v0.6.0-beta.2 为后续真实隔离 Windows 验收目标；本源码版本保持原 0.6.0-candidate.2，不擅改 publisher 发包版本，也不为验收发布未通过的正式版。

SemVer 的 beta 排在 candidate 前，所以 0.6.0-candidate.2 客户端拒绝在线降到 0.6.0-beta.2；实际验收需 publisher 分别产出版本元数据一致的 beta.1 与 beta.2。

修订时只读复查 v0.5.2：2026-10-03 16:26:47 UTC，Release 402587713 已公开、draft=false/prerelease=true，EXE asset 608106573，244046095 字节，GitHub digest 45510cbe8f3af129687d8ace267a5184ac64d4d273f63948996d1554a70acfe3。纯策略快照测试确认只在显式 preview 中可发现，stable/默认不会收此测试版；没有下载或执行二进制。
