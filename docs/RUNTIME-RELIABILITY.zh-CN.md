# 有界通用 Agent 运行时修复候选

基线：c6244b63439346287a5bd0dde2dac42a24baa2df。此候选只修复运行可靠性，不改变通用 Agent 的目标、现有权限或 Windows CI，也不代表真实模型、邮箱或单位网站验收。

## 行为变化

- 已开放且有权限的工具，仅显式 ToolInputError（JSON、schema、执行前文本/提醒输入校验）可返回 `{ok:false,code,recoverable,inputStarted:false}`。受控浏览器的类型化 OBSERVATION_STALE 也可重新观察。普通错误或仅带 recoverable 标志的错误不能进入恢复路径
- 同一工具连续两次可恢复失败即停止；成功执行清除计数。发生输入错误后，同批其他调用均标记未执行并回传，模型需重新规划。拒批、取消、关闭、未知工具、重复 ID、越权、可辨识跨任务/跨角色目标、凭据/网络策略和未知副作用仍硬停
- 达到 8 轮主调用或操作预算后，不追加模型请求。依据持久工具记录整理已做/未做、证据节选、真实文件下载地址和 SHA256。completionSummary v2 只存最多64条结果的状态、长度、SHA256、消息索引和文件元数据；completed/incomplete 仅存调用ID，完整证据不复制进摘要。未知历史证据列unknown，人工归还使旧审批失效的动作列未完成。正文证据节选合计最多6000字符，整体输出最多12000字符，超出明确标记截断。新工具ID上限200字符，无效ID硬停。任务保持 failed，不伪称全部完成，不开放失败任务新 DOCX/XLSX 导出
- 每次主/子模型调用在 modelRequest 入口记录独立请求身份、actor、类型和归一化数字 usage。task.usage 为累计值；字段缺失或不合法时为 null，known_* 仅表示已报告的下界，partial 表示不完整。失败请求的未知用量不按零计。历史仅有末次 usage 的任务保留该下界，并标记 legacy_history_unknown，不冒充完整总量。恢复不重新加算已有请求
- 关键词按空格/全角空格/标点分词，所有词均需匹配；较长汉字词可由相邻二元组匹配。NFKC、大小写归一化，相关性/标题/id 确定排序。仍先套用角色可读范围，保留来源/version，最多 12 条。不是语义或向量检索
- model、mail、browser 共享纯 IP 分类模块，逐字保留浏览器已有 BlockList 范围；literal、DNS 全部结果和连接前复查一致拒绝特殊/私网地址。公开 IPv6 literal 不送带括号 DNS；HTTPS/TLS/DNS pin、安全端口和显式测试回环例外不放宽
- workspace_save 保存 artifacts 数组，同时保留最后一个 artifact 字段。下载注册和界面列出所有文件；保留原认证及文件名验证，未登记文件不可下载。已有旧式 artifact 指针继续兼容

## 验证命令和限制

- node --test tests/runtime-reliability.test.mjs
- node --test tests/network-ip-policy.test.mjs tests/model-diagnostics.test.mjs tests/model-transport.test.mjs tests/mail-adapter.test.mjs
- npm test
- npm --prefix desktop run check

新增测试只使用假模型、临时 SQLite/文件、mock DNS/HTTPS/邮件工厂或无害 loopback 夹具，无真实模型调用和外发邮件。Linux 沙箱禁止 Chromium Unix socket 时，19 个旧浏览器用例无法进入产品流程；此环境失败不等于 Windows CI 或产品失败。最终计数及与未改基线的差异见候选验证记录。

发布前仍需合并其他候选、更新 SOURCE-MANIFEST、重新测试并独立审查。此前 c6244b 的 Windows 安装/启动/卸载验收不能自动代表此新候选的原生验收。没有修改网络/安全设置或扩大为 OS 沙箱。
