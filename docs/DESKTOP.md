# 路衡桌面客户端 0.4

## 当前 v0.4 状态

- 源码版本为 0.4.0；新版聊天首页、原生可缩放窗口、几何持久化、会话刷新恢复与连接诊断已实现，变化见 `UI-v0.4-CHANGELOG.zh-CN.md`
- v0.4 Linux x64 目录包已单独构建并验证健康接口版本、DOCX/XLSX 生成、包内 Chromium 虚构 OA 流程和独立原生窗口启动；发行产物单独存放，不包含在此源码仓库。范围与已知窗口恢复限制见 `NATIVE-LINUX-v0.4-VALIDATION.zh-CN.md`
- Linux 稳定运行时代码记录为后端155/155、桌面81/81及故障恢复界面16/16；随后仅构建/源码启动脚本修复新增4项回归，桌面检查85/85通过。Linux发行包没有因这次脚本修复重新生成，不把源码修订与旧包当作逐字节相同
- Windows Office 权限修复候选已合入，原生 Windows DACL、完整构建与安装/启动/卸载仍待实际执行；要求见 `WINDOWS-PERMISSIONS.md`
- GitHub Actions 的绿色构建、静态 PE/摘要检查或合成测试夹具，都不能替代安装器载荷验证与目标 Windows 原生验收。当前没有在本文件宣称 Windows 安装包已经可交付

本次验证矩阵见 `UI-v0.4-VALIDATION.zh-CN.md`。下方 v0.3 记录保留为历史证据，不能自动代表 v0.4 或 Windows 验收。

## 历史 v0.3 Linux 交付

已构建并独立启动 Linux x64 目录发行包，发行产物单独存放，不包含在此源码仓库。

- 内含 Electron 44.5.1、Node.js 24.21.0、SQLite 3.53.4、前后端和全部生产邮件/浏览器依赖
- 内含固定的 Debian Chromium 151.0.7922.173，不借用系统 Node、npm 或浏览器运行任务
- 从发行目录直接启动 GUI，创建并批准一条内置虚构 OA 任务，实际新增记录恰好 1 条
- 已记录运行中浏览器进程，其可执行文件确实位于该包的 `resources/browser-runtime/debian-chromium/chromium`
- 明确开启后台后关闭窗口，真实本机周期任务仍完成；再次启动恢复隐藏窗口。之后已取消测试计划并恢复默认关闭设置
- 本机系统密钥库不可用，凭据保存正确禁用；未输入真实用户凭据。托盘菜单点击仍需在目标桌面验证
- 测试用户数据放在独立目录，没有打进发行包；0.2源码与发行包保留

该轮完整验证结果见 `TEST-REPORT.md`。受控浏览器 11 项与模型集成 4 项包含在后端总数中。未连接真实邮箱、真实 OA 或真实模型账户；独立安全复核未完成。这不是生产安全验收，也不是 Windows 验收。

## 运行 Linux 目录包

保留整个目录，不要只复制主程序。进入发行目录后运行：

```sh
./start-luheng.sh
```

也可直接运行 `./highway-agent-desktop`。推荐的脚本会使用版本隔离的数据目录，避免测试覆盖旧版本配置；可通过 `HIGHWAY_DESKTOP_DATA_DIR` 指定另一个绝对路径。

目录包不要求安装 Node.js、npm 或 Chromium。它仍需要兼容的 Linux 系统库、图形登录会话和 Chromium 用户命名空间 sandbox。**只验证了当前 Debian 13/trixie x64 主机，不承诺跨所有 Linux 发行版通用。** 依赖清单见包内 `LINUX-DEPENDENCIES.txt`。缺少依赖或 sandbox 不可用时应修复运行环境，不应加 `--no-sandbox`。

### Linux 浏览器来源（沿用已固定运行时）

官方 Playwright 下载地址在当前环境返回了 195 字节的 “Site Unavailable” HTML，未得到浏览器 ZIP。没有换代理或绕过访问限制。

本次经过明确选择，改为离线复制当前主机已经安装、且功能测试已经使用的 Debian Chromium 151.0.7922.173，保留发行版权说明并固定 SHA256：

`d387400aaf740ccb75e5e996a34aa0940e6e97683a4eabd6ae34c1eed6804723`

这**不是** Playwright 1.58.2 默认下载的 Chrome for Testing 145.0.7632.6 / revision 1208。Playwright API 依赖仍为 1.58.2，已与包内 Chromium 151 做本机实际任务验证。完整浏览器文件校验清单在 `resources/browser-runtime/runtime-sha256.json`，来源在 `BROWSER-SOURCE.txt`。

启动时主进程校验包内浏览器路径及可执行文件摘要，再传入独立后端。打包模式不继承系统浏览器路径覆盖项，也不静默回退到 `/usr/bin/chromium`。

## 桌面安全与运行边界

- 后端在 Electron utility process 中使用内置 Node.js，仅监听随机环回端口
- 会话 Cookie 之外，还要求本次启动随机生成的桌面令牌；经私有进程消息传递，由 Electron 为精确本机 origin 注入请求头，不暴露给页面 JS
- renderer 开启 sandbox、contextIsolation、webSecurity，禁用 Node integration、WebView、开发者工具；没有 preload 或通用 IPC 桥
- 主界面不加载远程资产、不允许外部导航/新窗口；第三方目标由受控浏览器服务处理，参见 `CONTROLLED-BROWSER.md`
- 只有本机 `/api/artifacts/{文件名}` 成果下载可打开系统保存对话框
- API Key、角色 Key 和邮件密码默认仅存在运行内存中。用户明确保存后通过 Electron safeStorage 生成系统加密快照，配置摘要绑定恢复；Windows使用DPAPI，macOS使用Keychain，Linux仅接受实际安全后端。未使用明文 basic_text 回退，未接收真实用户凭据进行验收
- 默认关闭窗口停止本机服务；用户明确开启托盘模式且托盘可用后关闭仅隐藏窗口。托盘菜单退出会关闭后端。没有系统自动启动、电脑关机后提醒或云端24小时服务
- 本地业务SQLite仍未静态加密；凭据快照加密不等于所有数据加密

默认业务数据位于系统应用数据目录 `LuhengOfficeAgent/data`。v0.4 Linux 发行启动脚本默认改用 `${XDG_DATA_HOME:-$HOME/.local/share}/luheng-office-agent-v0.4` 作为版本隔离根目录；v0.3 发行脚本使用独立的 `luheng-office-agent-v0.3` 目录。工作内容、知识、日志及截图属于本地业务数据，应按单位要求保护和备份。

## 开发源码启动

开发机需要 Node.js 24.5+、npm 和图形桌面。首次安装需要网络：

```sh
npm ci
npx playwright install chromium
npm --prefix desktop ci
npm --prefix desktop run install:runtime
npm --prefix desktop start
```

安装完成后，Linux/macOS 可用 `./scripts/run-desktop.sh`，Windows 可用 `desktop\launch.cmd`。这些是源码开发入口，不是安装包。

## 构建与 Windows 路线

构建时通过官方 Playwright 安装器下载目标系统的 Chromium，再随应用打包；运行时不下载。打包脚本现支持 Windows x64 原生构建，及 Linux x64 到 Windows x64 交叉构建。Windows 命令示例：

```powershell
openssl version
npm ci
npx playwright install chromium
npm --prefix desktop ci
npm --prefix desktop run install:runtime
npm test
npm --prefix desktop run check
npm --prefix desktop run package:win
```

IMAP/SMTP TLS 测试夹具需要 OpenSSL CLI。它是开发/构建测试依赖，应用运行不依赖该命令。工作流有显式预检，尝试现有命令或已安装 Git for Windows 自带的 OpenSSL；缺少时明确失败。

- `.github/workflows/windows-build.yml` 在主分支推送或手动触发时运行 Windows 构建，产物保留14天；不会自动创建 GitHub Release
- 配置为当前用户 NSIS 安装，默认无需管理员权限，卸载保留用户数据
- 生产 `node_modules` 使用单独资源映射，确保 Playwright、IMAP、SMTP、解析器及其嵌套依赖一起进入包
- Windows 构建使用独立 `bundle-win32-x64`，不会覆盖 Linux bundle；使用固定 Playwright 的 win64 目标选择，打包前检查目标/架构及浏览器 x64 PE 头
- Linux 交叉构建使用官方 electron-builder Wine 11 工具包生成卸载器，以及 NSIS 3.12 工具包；自动校验工具包内置摘要。无需 Mono。Windows 原生构建不调用 Wine
- 测试安装器明确不签名，保留版本资源；实际签名、Windows安装/升级/卸载仍未验收
- 历史记录（2026-10-01云Linux交叉构建）：Windows Electron44.5.1下载及官方SHA256/ZIP CRC/x64 PE检查通过；Windows Chromium官方地址仅返回195字节“Site Unavailable”HTML，未获得浏览器ZIP。该阻碍使完整安装器未生成，详情见 `WINDOWS-BUILD-ATTEMPT.md`
- 上述 Linux 下载尝试遇阻后已停止，未改用镜像、代理或 Linux 浏览器冒充 Windows 运行时。后续由开发侧通过仓库 Windows Actions 继续构建，并以候选提交对应的实际结果为准；用户承担目标 Windows 运行验收，不要求用户自行构建

本次已验证的离线 Linux 构建命令为：

```sh
node desktop/stage-bundle.cjs linux --use-installed-chromium
cd desktop
./node_modules/.bin/electron-builder --config electron-builder.cjs --config.electronDist=node_modules/electron/dist --linux dir --x64 --publish never
```

离线选项只接受当前已审核的 Linux x64 Chromium 可执行文件摘要；其他版本必须重新明确审核/固定，不能冒充相同运行时。发行包位于 `desktop/dist/linux-unpacked`，应再复制到项目树外，使用独立用户数据做验证。本次交付是未压缩目录包，未生成 AppImage。

## 历史 v0.3 验证证据

- `artifacts/v03-final-backend.txt`、`v03-final-desktop.txt`、`v03-final-ui.txt`、`v03-new-ui.txt` 和对应退出码
- `artifacts/screenshots/ui-results.json` 与界面截图：既有界面回归与新增周期/托盘/导出界面记录
- `artifacts/linux-release-runtime.json`：包内 Node/SQLite、生产依赖解析路径、浏览器版本/摘要、0.3 health
- `artifacts/linux-release-gui-verification.json`：发行包 GUI 任务完成，虚构 OA 恰好保存 1 条
- `artifacts/linux-release-browser-processes.txt`：实际 Chromium 进程的发行目录路径
- `artifacts/linux-release-oa-saved.png`：由发行包内 Chromium 捕获的真实虚构 OA 保存后画面
- `artifacts/v03-source-snapshot.json`：最终源码摘要
- 发行目录内 `SHA256SUMS`：整个发行包的文件摘要

v0.4 证据及限制以本页开头链接的两份 v0.4 验证报告为准。仍需验证真实目标与账户兼容性、目标 Windows 系统、签名与更新、OS 密钥库真实后端和跨平台恢复、备份恢复及独立安全评审。不要从本地虚构站点通过推断真实单位系统也已验收。
