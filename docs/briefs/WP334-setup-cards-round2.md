# WP334 对话内连接 / 配置卡第二轮（决策 724 / 725 / 726，Luoye 10-15 同意）

worktree `../agentsws-wt/wp334-setup2` · 分支 `wp/334-setup2`。先读 `_common.md`、`docs/briefs/reports/WP324.md`（通用卡接口：`setupCardsOf(ws)`、`askConnect`、`askSetup`、`registerTarget`、`needs_connection` / `needs_setup`）、`docs/96`（「补一样」家族，决策 721）。

## 要做
1. **724 让 AI 自己要卡**：给所有职责一个通用工具（例如 `request_setup`）：AI 发现「要先连 X / 要先设 Y」时调用，参数是服务名或设置目标 + 一句为什么 + 建议值；运行时照 WP324 的规则出卡、去重、补完按原话接着做。三个运行时（stub / direct / dsh）都过工具参数表（dsh 严格 DSL）。
2. **725 企业微信表单与微信扫码放进卡里**：连接卡里能就地填企业微信的表单（凭据走本机原生表单，不进 AI）、个人微信扫码；连好自动接着做。
3. **726 剩下几类改成就地卡**：没接模型（模型 key 走连接卡的本机表单）、DeepSeek 没登录（连接卡里登录）、工坊账号没关联（连接卡里关联）、没有发信邮箱（连接卡）、公司档案没填（配置卡）。原来那几句「去设置页」改掉；设置页保留。
4. 测试：AI 自己要卡 → 出卡 → 补完接着跑；口令永不进 AI 上下文；去重。

## 纪律
不读 .env*；不碰 key / token；密码类只走本机原生表单；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP334.md`（决策号 790–794）。
