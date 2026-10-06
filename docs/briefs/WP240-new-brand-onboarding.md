# WP240 第二个品牌的首次设置走不通（Windows 真机，新建品牌 Rollout）

worktree `../agentsws-wt/wp240-brandonb` · 分支 `wp/240-brandonb`（从 main 新起）。先读 `_common.md`、`docs/52`（多品牌 O1 / O2：档案按品牌存）、`docs/46` §1、`docs/70`（首次设置）、`apps/server/src/onboarding.ts`（`state` / `plan` / `apply`、`profileOf(actor.workspace_id)`、`brandNameOf()`、`options.workspaceName()`、网站分析那条任务）、公司页「品牌」页签（品牌一览 / 加一个品牌 / 切到这个品牌）、品牌切换（`/v1/orgs/{id}/brands/{ws}/switch`）、WP215 / WP233 / WP234。

## 现象（Fable 10-06 在 Luoye 的 Windows 真机 ci.8 上，以普通用户身份新建第二个品牌）
已有品牌 INMO（工作区 ws_0llwvcm2，首次设置时「公司全称」填的是 INMO）。在公司页 → 品牌 → 「加一个品牌」填 Rollout、不复制设置 → 建好；点「切到这个品牌」→ 整页刷新。
1. 刷新后左下角写「所有者 · Rollout」，但公司页品牌一览里**仍标 INMO「当前」**，Rollout 卡上仍是「切到这个品牌」按钮——切换后显示不一致。
2. 品牌卡上有两个**没标签的数字**（INMO「27」、Rollout「16」），看不懂是什么。
3. 新品牌没有自动进首次设置；手动开 `/onboarding`：第 ① 步「接上 AI」又问一遍（公司已经关联了 Agents 工坊账号、模型跟随公司默认），多余。
4. 第 ② 步填店铺网址 `https://6suegp-md.myshopify.com`（正式店铺，**大概率开着店铺密码**；对脚本访问回 429）→「开始分析」后一直显示「正在读你的网站，已经读了 0 页」，75 秒以上没有任何变化、没有错误、没有提示「店铺有密码」——用户只能干等。
5. 以 Rollout 的负责人分配（ws_19cxxs7l）调 `GET /v1/onboarding/state` 返回：`needs_setup:false`、`workspace_name:"default"`、**`brand_name:"INMO"`**、`profile.legal_name:"INMO"`、`storefront_platform:"shopify"`、`set_at` 是建品牌那一刻——新品牌的品牌名取的是启动品牌（`brandNameOf()` 不按 actor 品牌）、档案像是从公司 / 启动品牌带过来的，导致「需要设置」判成 false。
   **要重点核实：** 在 Rollout 下做第 ② 步分析 / 保存时，写的是不是 Rollout 自己的档案，有没有写到 INMO 的档案上（数据串品牌是最严重的那种 bug）。

## 要做
1. 首次设置全程按**当前品牌**（actor 的工作区）读写：`state` / `plan` / `apply` / 网站分析 / 品牌名 / 平台推断，一律不碰别的品牌；加端到端测试：两个品牌各走一遍首次设置，档案、品牌名、岗位、分析结果互不串。
2. 新建品牌后：切过去自动进这个品牌的首次设置（从第 ② 步开始）；公司级已有的（AI 接法、公司全称、负责人）不再问，第 ① 步显示「已接上（跟随公司）」直接过。
3. 网站分析：读不到时**尽快照实说**——店铺开着密码（识别 Shopify 密码页）、429 / 被拦、域名还没解析——每种一句人话 + 下一步（「店铺有访问密码：填一下店铺密码再读」/「先跳过，手动填品牌资料」）；Shopify 密码店允许用户在原生表单里填一次店铺访问密码用于分析（不经 AI、不落日志、只用于这次抓取）；超过 30 秒还 0 页就给「先跳过」。
4. 切品牌后公司页「当前」标记、按钮立即跟着变；品牌卡上的数字补标签（是什么就写什么，例如「后台任务 27」），看不懂的就不放。
5. 修好后写一条迁移 / 自检：已经存在的品牌档案里 `brand_name` 与品牌实际名不一致的，按品牌名纠正（不碰用户改过的）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP240.md`（含第 5 条「有没有写到 INMO」的核实结论，要 Luoye 定的事单列）。
