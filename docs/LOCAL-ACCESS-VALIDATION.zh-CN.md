# 本机权限候选验证记录

验证日期：2026-10-02 UTC。平台：Linux，Node 24.19.0。应用版本暂保留0.4.0，本功能尚未作为新版本Windows安装包发布。

## 已完成

- 本机服务9项、后端集成15项、安全回归27项：51/51通过，无跳过
- UI状态机/生成DOM回归：1项测试覆盖15个交互检查，通过；使用真正的隔离本机后端，属于DOM与行为验证，不能代替实际画面验收
- 桌面端检查及测试：87/87通过，包含原生目录选择私有RPC的2项测试
- 修改文件的语法检查及git diff --check通过
- 真实无害闭环：指定临时目录中文本文件读取、完整内容审批后写入、直接Node命令stdout、审批拒绝、一次性并发审批、撤销停止执行、超时/输出上限、后续模型工具结果回传、明确请求的DOCX导出
- 仅使用临时资料、虚构模型协议响应和无Key实例；没有启用宿主全部文件授权，没有读取真实凭据，也没有修改操作系统安全设置

安全回归覆盖默认关闭、只读、范围和角色双重检查、路径穿越/同名前缀、符号链接/硬链接、审批快照不可变、绑定完整参数和权限版本、二次确认过期与复用、重启失效、已知凭据及迟到新增凭据、SQLite/WAL无本机内容回显、命令并发/时限/输出、普通子进程终止与服务关闭、启动后失败不能假称无副作用。

## 未通过或未执行

完整npm test不能标为通过：本次219项中200通过，19项现有Chromium依赖用例在启动时失败，错误为Unix socket权限拒绝（Operation not permitted）。普通执行与扩展执行均受此环境限制，没有关闭Chromium沙箱。明确排除这19个浏览器用例后，实际执行的200项用例通过、0失败。本记录已剔除runner占位；不能把排除浏览器后的结果当作219项完整通过。

新增权限UI的实际像素与截图验收未完成：隔离Chromium不能启动；独立云浏览器也拒绝临时环回QA地址。没有生成假截图，也没有操作正在使用的其他客户端窗口。可重复的真实浏览器脚本已保存为tests/ui-local-access.mjs，在允许Chromium沙箱与Unix socket的环境中应执行它并保留截图。

新增功能原生Windows安装后界面、非管理员命令终止、junction/reparse-point行为、系统目录选择器交互尚未验收。已有Windows构建成功或旧安装验收不能替代本候选的新功能验收。macOS隐私权限、真实模型与真实办公资料也未验收。

## 复现

聚焦检查：

```sh
node --test tests/local-access.test.mjs tests/local-access-integration.test.mjs tests/local-access-security-review.test.mjs tests/local-access-ui.test.mjs
npm --prefix desktop run check
```

完整检查（本环境有上述已披露的浏览器启动阻碍）：

```sh
npm test
```

明确排除已知19项浏览器用例的检查：

```sh
node --test --test-skip-pattern='^(controlled browser:|controlled engine:|model-requested mock OA approval|real Chromium OA|rejection never saves OA|takeover blocks approval|cancelling a waiting browser task|cancellation during in-flight OA observation)' tests/*.test.mjs
```

真实画面验收（输出目录须在源码目录外）：

```sh
node tests/ui-local-access.mjs --output-dir /tmp/luheng-permission-ui-proof
```

Windows使用当前用户有写入权限、位于源码目录外的输出路径替代示例/tmp路径。浏览器启动失败会明确失败，不会把未执行的画面验收记为成功。

## 发布判断

功能是带真实工具与后端授权的开发候选，未发现所声明应用层边界内未解决的阻断性授权绕过。不能称为生产验收、Codex等效OS隔离或“一个按钮授予所有系统权限”。发布前应补齐实际渲染UI、原生Windows与明确授权的无敏感数据真实模型闭环。
