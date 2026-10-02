# 第三方依赖声明

本项目未包含或复用 Hermes 的代码、品牌、Logo 或 UI 素材。UI 和应用源码为本项目生成的独立实现。

| 组件       | 用途                                | 许可 / 官方资料                                                                                                                         |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 | 本地后端、内置 SQLite API           | MIT 及其第三方依赖许可，https://github.com/nodejs/node/blob/main/LICENSE                                                                |
| SQLite     | 持久数据库，经 Node.js 内置模块使用 | Public Domain，https://sqlite.org/copyright.html                                                                                        |
| Playwright | 模拟 OA 浏览器驱动                  | Apache-2.0，安装包 `node_modules/playwright/LICENSE` 及 `node_modules/playwright-core/LICENSE`，https://github.com/microsoft/playwright |
| Chromium   | 浏览器执行与 Electron 页面渲染      | BSD-style 及众多第三方许可，https://www.chromium.org/chromium-os/licenses/                                                              |
| Electron   | 独立桌面壳、utility process         | MIT，包内 LICENSE 和 LICENSES.chromium.html，https://github.com/electron/electron/blob/main/LICENSE                                     |

版本以根目录和 desktop/ 的 package-lock.json 为准。源码压缩包不捆绑 node_modules 或浏览器运行时，因此安装依赖时由官方包携带原始许可；后续完整离线安装器必须保留这些许可文件，且随签名发布流水线检查实际打包清单。此文件是依赖索引，不替代组件原始法律文本。

0.2 新增邮件依赖（实际版本以 package-lock.json 为准）：

- ImapFlow 2.2.1：MIT，https://github.com/postalsys/imapflow
- Nodemailer 10.0.13：MIT-0，https://github.com/nodemailer/nodemailer
- MailParser 3.9.33：MIT，https://github.com/nodemailer/mailparser

离线包构建脚本复制完整生产依赖树及其许可证，不能只复制最外层模块而遗漏传递依赖。OpenSSL仅用于生成测试夹具证书，不是本应用运行时依赖。
