# Windows x64 安装器构建尝试

日期：2026-10-01 UTC。使用开发侧已有的云 Linux x64，没有使用用户电脑、建立付费 CI 或发布仓库。

## 结果

当前未生成完整 Windows 安装器。Linux 交叉构建在技术上可行，实际阻碍是所需 Windows Chromium 的官方下载没有返回 ZIP。没有把 Linux Chromium 或不完整的外壳包作为 Windows 安装器交付。

## 已实际执行

1. 检查 Node 24.19.0、Electron 44.5.1、electron-builder 26.15.3、Playwright 1.58.2，以及现有 NSIS 配置。生产依赖未发现 `.node` 原生扩展；SQLite来自Electron内置Node。
2. 执行原 `npm run package:win`，确认旧脚本在下载前人为禁止跨平台。修复为独立 Windows staging 目录，并保留 Linux 路径。
3. 检查固定 Playwright 安装器的 Windows目标：Chromium revision1208 / Chrome for Testing145.0.7632.6，地址为 https://cdn.playwright.dev/builds/cft/145.0.7632.6/win64/chrome-win64.zip 。实际响应虽为HTTP200，却是195字节的“Site Unavailable / Unable to access this site”HTML，不能当作成功下载。
4. 一条旧的跨平台拒绝测试在脚本修复后进入了官方安装器，安装器自动重试相同下载，均报ZIP中心目录不存在。发现后已停止该路径，并将该测试改为不联网的纯本地目标校验。没有换镜像、代理或其他下载路由。
5. 从Electron官方GitHub release下载Windows x64 ZIP，获得157,998,329字节。对照同版本官方 `SHASUMS256.txt` 的摘要一致，ZIP所有条目CRC通过，electron.exe确认是x64 PE文件。SHA256：`9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db`。这只是Electron运行时，不是路衡安装包。
6. 打包工具相关桌面测试最终55/55通过；该轮只调整构建脚本、测试与文档，应用功能代码未变。

## 打包修复

- `npm --prefix desktop run package:win`统一调用跨平台构建入口
- Windows使用独立 `bundle-win32-x64`；下载和路径解析都显式使用固定Playwright的win64选择器，这是Playwright内部机制，版本升级需重新验证
- 失败staging撤销旧manifest；浏览器必须是Windows x64 PE，builder再次检查目标和架构，避免把Linux资源误打入Windows包
- 测试包不签名但保留版本资源。Linux标准NSIS流程需要Wine执行卸载器生成stub，即使不签名也需要
- 配置官方builder Wine11工具包（1.0.1）及NSIS3.12工具包（1.2.1）；下载器有固定校验摘要。尚未安装/验证这些工具包，因为完整包已被浏览器输入阻断
- 源码ZIP排除两个平台的staging、依赖、运行时、数据及日志

## 完成安装器还需要什么

继续使用当前开发侧Linux x64，前提是正常、获允许地取得固定Windows Chromium运行时，并能取得官方NSIS/Wine构建工具。也可以在之后经授权的Windows构建环境执行同一入口。本次不建立新外部环境。

依赖可用后，由开发侧继续打包，检查完整EXE、内置Electron/Node/浏览器/依赖、解包内容和文件摘要，再交给用户测试Windows安装、启动、后台/托盘、DPAPI、浏览器任务及卸载。用户承担运行测试，不要求用户自行构建。

本次没有Windows原生执行、安装/卸载、代码签名、SmartScreen信誉或真实账户验收。
