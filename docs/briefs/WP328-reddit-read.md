# WP328 Reddit 读：插件读收件箱与自家版块 + 每日巡查 + 外部社区关键词监测（docs/102；决策 660–673 及文末 Luoye 10-14 定）

worktree `../agentsws-wt/wp328-redditread` · 分支 `wp/328-redditread`。先读 `_common.md`、`docs/102-INMO-Reddit运营自动化方案.md`（全文，**以文末两段「Luoye 10-14 定」为准**）、`docs/briefs/reports/WP313.md`（插件动作通道、`packages/browser-action`）、WP249 Reddit 官方号通道与 WP229 Reddit 读数据（Apify）现有代码、社媒运营岗位（docs/56）、`docs/96`、WP323 发出记录（`apps/server/src/outbound/`）、WP324 连接卡（`apps/server/src/setup-cards.ts`）。

## 已定（照做，别自作主张加规矩）
- 走**用户日常 Chrome 里的「Agents 工坊助手」插件**（品牌号单独一个 Chrome 个人资料，660），**不做程序登录**；只读、不改已读（`mark=false`）；读收件箱的 `.json`（comment replies / post replies / username mentions / messages），用消息编号判新。
- **频率一天一次起步**（收件箱、自家版块、外部关键词都是），用户可改；**每周五 17:00 左右做本周最后一次巡检**。不设任何冷却 / 身份声明 / 推广占比之类的规矩（664 被否）。
- 自家版块（INMO 是 r/inmoxr，版块名由用户配置）：新帖、新评论、我们帖子 / 回复下的新回复；统计帖子数、评论数；识别 VOC（用户声音）与 UGC（用户自发内容），只记有效的。
- 外部社区（除自家版块）：全站关键词监测走第三方数据渠道（现有 Reddit 读能力），每天一次；按话题归组、给出评估判断（日常讨论无需处理 / 相关度不高不建议回复 / 需跟进）。关键词清单由用户配置（缺就出配置卡，按 WP324）。
- Reddit Chat 与 modmail 第一版不读（靠邮件通知，662）。

## 要做
1. 插件侧：给 Reddit 加只读动作（同一会话取 `/message/inbox/.json?mark=false` 等、`/r/<sub>/new.json`、某帖评论 `.json`），复用 WP313 的公共执行模块（限速、被拦就停、读回）；插件没配对 / 没登录 Reddit 时回 `needs_connection: 'extension'` 让 WP324 出连接卡。
2. 服务端：每日巡查任务（社媒运营岗位下），结果入库（按品牌）：收件箱条目、自家版块帖子 / 评论、外部关键词命中；每条 AI 判断「要不要回 / 为什么」，要回的标出来交给 WP329 起草（本单只出「待处理」清单与卡，不起草不发）。
3. 统计与 VOC / UGC / 舆情结构化存储，给 WP330 周报用（周日—周五窗口）。
4. 测试：替身 Reddit JSON、替身插件、替身数据渠道；不打开真 Reddit。

## 纪律
不读 .env*；不碰 key / token / 账号；**不打开真实 Reddit**；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`。WP329 / WP330 并行，接口在报告里写清。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查（契约改了重出 cloud-openapi）+ 插件构建 + 装包前冒烟；报告 `docs/briefs/reports/WP328.md`（决策号 755–759）。
