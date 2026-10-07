# WP253 建站岗位端到端接通：AI 用工作台私有 Shopify CLI 改主题（以 agentsws-theme 为底）→ 未发布预览 → 发布走审批卡

worktree `../agentsws-wt/wp253-site` · 分支 `wp/253-site`（从 main 新起，含 WP245 / WP247）。先读 `_common.md`、docs/12（开发者路径、建站岗位）、docs/59（建站岗位四条职责）、`packages/roles/roles/site/*.yml`、`apps/server/src/shopify-theme.ts`（顶部那张「Agent 那条路负责改与看、这个模块负责发与长驻」的表、`proposePublish` / `ThemePublishProposal`、`PASSTHROUGH_ENV`）、WP245 报告（§「没做到」：Agent 沙箱终端里的 `shopify theme …` 还没用私有 CLI；`shopify-theme.ts` 还没装配进服务端，只留了注入口）、门禁 `gate.ts` 的 `materializePublish`、dsh 终端 / 沙箱相关（docs/55、WP179）、平台工具包（platform-kit：Shopify 官方技能、Shopify Dev MCP）。开源主题仓库：github.com/Luoye-W/agentsws-theme（Apache-2.0，公开）。

## 背景（Luoye 10-07）
Rollout（rolloutgear.com，正式店 6suegp-md.myshopify.com，现在是 Shopify 空店）要用工具里的建站职责 + 开源主题 agentsws-theme 把网站搭起来——**模拟普通用户怎么用我们的工具做 Shopify 建站，过程中反过来优化工具**。用户没有 IT 知识（不开终端、不敲命令）。Shopify CLI 现在能一键装、一键登录（WP245），但 AI 这一侧还没接通。

## 要做
1. **先摸清现状写进报告**：从「用户在建站岗位里说『用 agentsws-theme 给我搭个首页』」到「店里出现一个未发布主题可预览」，现在每一跳通不通、卡在哪（列表：职责 yml 的工具 / 连接要求、运行时有没有终端或主题工具、CLI 从哪找、登录态从哪来、店铺地址从哪来、门禁怎么拦 publish）。
2. **把断的接上**（以最少的新东西）：
   - `shopify-theme.ts` 装配进服务端，CLI 路径与 node 目录用 WP245 的私有安装（系统全局的也认）；店铺地址取本品牌连接 / 品牌档案（Rollout 是 `6suegp-md.myshopify.com`）；CLI 登录态用 WP245 那份（按品牌记）。
   - AI 侧给建站职责一组**受限的主题工具**（不是任意终端）：`theme_init_from_base`（从 agentsws-theme 指定版本拉一份到本品牌工作目录，Apache-2.0 照带 LICENSE / NOTICE）、`theme_list` / `theme_pull` / `theme_check`、编辑工作目录里的文件（只限该目录）、`theme_push_unpublished`（推成未发布主题，返回预览链接）。`publish` 一律经门禁物化成审批卡，人批了由服务端执行（照 shopify-theme.ts 头注的分工）。`dev` 长驻不给 AI。
   - 卡片 / 工作视图里：推好未发布主题时出一条「预览好了」+ 预览链接；发布卡上写清「将把主题 X 设为线上主题」、改了哪些文件。
3. **普通用户视角的引导**：建站岗位页如果 CLI 没装 / 没登录 / 没连店，在岗位页给一句话 + 按钮跳到对应一键操作（复用 WP245 卡片），不让 AI 跑到一半才报「没有 CLI」。
4. 测试：假 shopify CLI（脚本）+ 本地假主题仓库覆盖 init / pull / check / push_unpublished / publish 出卡 / 批后执行 / 未登录 / 未装；门禁确保 AI 直接 publish 被拦成卡；工作目录越界写被拒。
5. **不要真推到任何真实店铺**；真机上对 Rollout 店的首次推送由 Fable 和 Luoye 一起做。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不登录任何网站；不真去 Shopify（假 CLI）；读 agentsws-theme 公开仓库（`gh api` / git clone 到临时目录做夹具参考）可以，但测试夹具用最小假主题，不把整套主题复制进开源仓。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；岗位页引导与「预览好了」/ 发布卡出截图；报告 `docs/briefs/reports/WP253.md`（现状摸底表、给 Fable 的真机首推步骤、要 Luoye 定的事单列）。
