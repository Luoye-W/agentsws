# WP131 插件收尾六条 + 积分价目全面重算

开源仓库 worktree `../agentsws-wt/wp131-repricing` · 分支 `wp/131-repricing`；私有仓库 `/Users/yeluo/Documents/agentsws-extension` 分支 `wp/131-plugin`。许可证红线不变。

## Luoye 定（09-23，针对 WP130 报告 §3）
1. 旧插件仓库那批改动已提交——私有仓库里移植文件头的出处改成正式提交号（去旧仓 `git log -1` 取）。
2. **内容观测的「标题」改成可选**：契约里 `title?` 已是可选（`packages/contracts/src/kol-public.ts`），要改的是**云端与本机的校验**（现在空标题整批拒）和插件侧「没标题就不报」的判断——IG 网格 / TikTok hashtag 格子的帖子照样进内容观测，标题空着；界面上无标题的条目显示成「（无标题）」+ 平台 + 编号。
3. **列表页收的人也上公共库**：插件把「312K subscribers」「1.2M followers」这类原文换算成数字（英 / 中 / 德 / 法千分位与 K / M / 万 / 亿单位，旧插件云端有换算逻辑可参考），带上 `followers` 送；换算不了的照旧只进本机。
4. **「采集后自动评分」接上**：本机服务加一条「收进红人库后自动跑打分 / 体检」的开关（每工作区一个，默认关）；开着时收进即入队跑 `kol-core` 的打分（本机、不花积分）与（若已关联云账号）云端体检报告 `data.kol.audit`（花积分，按重算后的价，收进前面板上常显「每位约 N 积分」）；面板那个开关接这条，不再是摆设。
5. **「回作战室看这批」深链**：指向本地应用的对应页——`/influencer/creators?batch=<本次采集批次 id>`（工作台按批次筛出这一批；批次 id 由本机服务在批量收进时返回）；WP119c 的五条深链沿用。
6. 已发出去的贡献积分只停发不收回——确认，不用动。

## 积分价目全面重算（Luoye：「原先 KOLAgents 定的积分消耗数额，在 agentsws 里都要重新算一下」）
背景：KOLAgents 是 **1 积分 = $0.01** 的口径；agentsws 是 **1 积分 = ¥1**（docs/49），两边差约 7 倍，KOLAgents 的数字不能照搬。现在 `pricing.json` 里的数（`data.kol.lookup` 0.2、`data.kol.audit` 3、联系方式揭示、`ai.chat` 0.1 / 千 token、`ai.image` 0.5 / 张、`social.fetch` 0.05、`crawl.page` 0.02、`transcribe.minute` 0.1）大多是早期拍的，没有对过成本。
- 做一张**重算表**写进 `docs/77-积分价目重算-v1.md`：每条能力 → 我方成本（`cost-table.json` 的公开价 × 典型用量，含云端 Workers / DO / R2 的摊销）→ 目标毛利（数据接口与体检类 ≥ 60%、AI 转发 ≥ 40%、生图 ≥ 50%）→ 建议价（取整到 0.1 积分；单次 ≥ 1 积分的动作要二次确认，这条口径已定）→ 与 KOLAgents 同一动作的价换算成 ¥ 后对照一列（只作参考）。**联系方式揭示**单列：KOLAgents 是 12 积分（$0.12）、我们现在多少、建议多少。
- 建议价**先写进表，不改 `pricing.json`**——最终数字要 Luoye 定；但把 `pricing.json` 每条加 `basis`（怎么算出来的一句话）与 `reviewed_at`（空 = 未核）字段，运营后台价目页显示「未核」标记（与成本表的「未核对」同一套做法）。
- 顺带核对 WP127 换上的多模态默认型号在 `cost-table.json` 里有没有价，没有的按公开价补并标未核。

## 验证
开源：`scripts/verify-changed.sh` + dry-run（`--containers-rollout=none`）；私有：`pnpm test && pnpm test:parity && pnpm build`。
