# 原型发布前核对单

## 本次交付类型

- 可运行源码、Linux 本机部署、真实 Electron 独立窗口、可复现测试
- Windows NSIS 构建配置和手动 CI 模板
- 不是已签名 Windows 安装器，不是已经接入单位真实系统的生产产品

## 源码包检查

运行 `python3 scripts/package-source.py`。脚本仅打包明确允许的源码目录，排除：

- 所有 node_modules、浏览器/桌面运行时、构建产物
- data、SQLite、DB、日志、.env、版本库内部文件
- 实际运行截图和任务材料（单独选择演示截图交付）

压缩包内 `SOURCE-MANIFEST.json` 记录每个源码文件的 SHA-256。相邻 `.sha256` 文件记录整个压缩包的校验值。源包不提供离线运行依赖；完整离线安装器需要在 Windows 原生或 Linux 交叉构建阶段捆绑 Windows 运行时。此次尝试与阻碍见 `WINDOWS-BUILD-ATTEMPT.md`。

## 测试证据

以最终 `docs/TEST-REPORT.md` 和原生图形主机测试记录为准，禁止把旧日志或局部测试当作最后版本的全量结果。

- 核心持久化、授权、审批、取消、提醒、模型协议和凭据脱敏
- 周期任务时区/DST/错过合并/编辑暂停恢复取消/崩溃幂等
- 明确选择的凭据系统加密快照、不可用时拒绝保存、托盘关闭与真正退出
- 无宏DOCX/XLSX文件结构、公式边界、可读性与真实下载
- 真Chromium网页操作、完整输入审批与重启不重放；原有模拟OA可恢复待审批任务
- 独立 Electron 的同源限制、隔离窗口和私有令牌
- UI 表单与真实 API 交互、九个页面、移动宽度、浏览器接管

## 发布控制

- 未经用户确认目标，不创建公开仓库、不发布公共网站、不上传真实任务数据
- 模板 CI 只构建 artifact，不自动公开 Release，不自动配置更新服务器
- 最终单位品牌、域名、签名证书、模型服务和真实业务适配均另行确认
- 保留本项目 LICENSE 及运行时原始第三方许可；源包不删改依赖原始许可证

## 本次演示访问边界

Linux 原生 Electron 窗口与本机环回服务已运行。`127.0.0.1:4318` 不是公网链接；用户自己电脑访问同一地址不会连接到此云主机。当前云 CDP 浏览器拒绝打开该环回 URL（ERR_BLOCKED_BY_CLIENT），未绕过此限制或公开服务。因此先交付静态截图、测试证据与源码；公开/私有托管目的地待用户确认，不能把本机地址包装成可远程打开的在线演示。

## 带客户端更新器的新发布

- [ ] 根/desktop/lock/UI真实版本一致；不改 appId/dataRoot，正式版标签为严格 vN.N.N；测试版渠道可显式使用严格 vN.N.N-beta.2 类标签并标记 GitHub prerelease=true
- [ ] 在发布固定仓库前核实精确 EXE 名、uploaded、正整数 bytes、GitHub sha256 digest 与本地一致；不替换已发布同版本包
- [ ] updater 模块在 asar 内，current-user-install.nsh 进入构建输入；v26 配置固定当前用户且不打包 elevation helper
- [ ] Linux 模块/IPC/API/UI合同及全量回归通过；环境未跑或失败项明确列出
- [ ] 两份包含更新器的更高/更低不同版本产物完成 [UPDATE-SECURITY.md](UPDATE-SECURITY.md) 实际在线/可见安装/MOTW/DACL/安全提示/用户数据验收；不能用旧0.5.1首次手动安装代替
- [ ] Release notes 如实标注未签名测试版、首次手动基线安装、hash仅完整性、内存凭据退出后清空、无自动回滚，以及真实验收范围
- [ ] 重新生成最终 SOURCE-MANIFEST；签名、metadata、CI通过和发布分别核实，不把静态或模拟通过称作实际在线更新已完成
