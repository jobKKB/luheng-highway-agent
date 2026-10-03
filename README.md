# 路衡 · 通用工作空间 0.6.0-candidate.2

基于已发布0.5.2稳定DOM源码的独立开发候选。以通用对话为入口，工作流由用户选择的Skills与自定义角色定义，没有内置养护报告、业务思考模板、演示邮箱或模拟OA流程。

这是源码开发候选，尚未通过本版真实Windows界面与安装器验收；不是已经发布、签名或生产就绪的客户端。

## 功能

- 白底连续对话、用户/助手身份、独立文件卡片、固定底部宽圆角输入框
- 安全Markdown渲染；工具活动按需折叠，不显示模型隐秘推理
- 同角色已完成任务的真实跟进上下文，最多前三轮公开用户消息/最终答复；不传递工具历史或隐秘思考
- 始终可见工具与Skills入口；每项能力独立说明可用、未配置、权限受限或未实现，以及最近网络观察
- 用户只读SKILL.md文本包导入、list/view及会话自选启用；不运行脚本、不安装依赖、不扩大工具权限
- 新安装API-first且资料为空，模型未配置时引导连接；不会生成假业务结果
- 旧原始seed只在标题、内容、来源、版本与未编辑字段完全匹配时归档，可按条恢复；用户资料及已有角色权限不自动改变
- 真实受控网页、IMAP/SMTP、本机文件/命令与逐次精确审批；延续已有隐私、取消、预算、未知副作用禁止重放边界
- 首组真实公开搜索/网页提取工具与基于工具证据的completed/needs_attention判定。国内网络未验收，不能把配置就绪当实时可达

## 运行

Node.js24.5+：npm ci，然后npm start。服务只监听127.0.0.1。设置模型端点、名称和API Key后开始对话；任意附件解析、Skill脚本执行、市场与依赖管理尚未实现。

桌面壳：npm --prefix desktop ci、npm --prefix desktop run install:runtime、npm run desktop。

详细功能、限制与安全边界：docs/GENERIC-WORKSPACE.md、docs/LOCAL-ACCESS-PERMISSIONS.zh-CN.md、docs/RUNTIME-RELIABILITY.zh-CN.md。其他v0.3–v0.5文档是历史证据，不代表本版验收。

## 测试与验收

- npm test：完整后端/安全/迁移合同
- npm run test:ui：真实Chromium通用UI、Skills、能力、下载、多轮上下文、360px、键盘、输入法/选区/滚动、60秒idle
- npm run test:stability：保留并迁移的真实60秒轮询/native Range/权限更新验收
- npm --prefix desktop run check：桌面源码与打包合同
- .github/workflows/generic-workspace-acceptance.yml：自动push/PR Windows候选验收，不发布或安装；必须对精确候选commit执行

当前云环境的Chromium因Unix socket EPERM无法启动；云浏览器也拒绝loopback导航，因此本次未生成新UI截图，未完成真实桌面/360px像素验收。Node/合成DOM通过不能代替这些未测阶段。

本候选的原生安装器门禁已精确调整到0.6.0-candidate.2，并用明确合成API工具夹具替代旧业务demo、验证包内真实Chromium。代码合同通过不代表安装器已执行。旧升级验收锁/driver保留0.4/0.5历史输入，不被重新标注为本版升级通过；新版真实安装、升级和截图仍待对精确commit执行。旧浏览器UI脚本保留为历史，通用UI由新门禁覆盖。

## 安全限制

这是单用户本机应用，不是多人服务。API会发送任务、选定Skills与必要资料至配置的服务商；Key默认仅内存。默认本机权限关闭，完全访问仍需要明确确认。命令使用当前账户进程权限，应用不是OS级沙箱。任务次数预算不是金额上限。发送邮件与网页输入需要确切内容审批；重启后未知副作用不会自动重放。支持资料需遵守所属组织的数据外发规则。

许可证：MIT。公开网页适配器的第三方入口受各自条款与实际可达性限制；本实现没有复制Hermes源码。
