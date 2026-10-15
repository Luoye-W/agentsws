# WP316 改广告与小改动接线：卡 → 插件执行 → 平台预览 → 再确认 → 提交 → 读回 → 账本（docs/101 §5.1② ③ / §5.3 / §5.4；决策 552–558）

worktree `../agentsws-wt/wp316-adswire` · 分支 `wp/316-adswire`。先读 `_common.md`、`docs/101`（全文，以文首 Luoye 定为准；557 默认不碰、可逐项放开、放开后 L1）、`docs/briefs/reports/WP313.md`（`buildAdsJob`、`deps.extensionActions.enqueue`、`onEvent`、`ActionEvidenceStore`、confirm / stop 接口）、`docs/briefs/reports/WP314.md`（`buildAdUploadBundle`、`readBackCheck`、`attachIdsFromExport`、`routeAdChange`）、`docs/briefs/reports/WP317.md`、`docs/57`、`packages/ads-core`、`ads-service`。

## 要做
1. `ads-service` 从「只出卡」接到完整执行：审批卡（L1，白话一句 + 表格预览 + 可下载原表）→ 插件上传 → 平台预览截屏 + 读出错误 / 警告 → 人再确认（卡上或横条）→ 提交 → 截屏 → 读回核对（再导出比对）→ 变更账本（上传表、改前 / 改后导出、截图、审批编号）。阻断错误不给提交，退回 AI 改。
2. 新增「激活 / 开始投放」类别（553，L1）；磨合期规则（554：每账户前 2 周 L2 升 L1）；撤销卡（L1，Google 一次性撤销 / 更改历史，Meta 用改前表反向导入）。
3. 小改动（暂停 / 启用、改预算）按白名单由插件点，前后截屏；3 条以上自动走上传表（552）；止损暂停 L3 自动 + 「已止损」卡；截不到图的止损先执行、账本记「没截到」用前后导出作证（600）。
4. 前后截图进账本存 180 天（556）；处理技能文本里「批量上传」禁用词的问题。
5. 插件没配对 / 没连回 `needs_connection: 'extension'`，走 WP324 连接卡。
6. 测试：本地假后台页面 + 替身插件全流程；不打开真实广告后台。

## 纪律
同 WP315。WP315 并行，别动它的主场。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 插件构建 + 真 Chromium 本地假页面端到端 + 装包前冒烟；报告 `docs/briefs/reports/WP316.md`（决策号 805–809）。
