# WP127 模型能力：文字模型必须多模态（能看图），生图单独一档

worktree：`../agentsws-wt/wp127-vision` · 分支 `wp/127-vision`（从 main 新起）。

## Luoye 定（09-23）
后面**只支持多模态模型**——文字模型必须看得懂图；**生图单独设置一档**。

## 先读
`packages/model-gateway/src/*`（`ModelPurpose`、`ImageProvider`、`ChatMessage`）、`apps/workstation/src/components/models/*`、设置页「模型」、初始化向导第 ① 步（WP121b，`POST /v1/models/providers/:id/test`）、`docs/70` §2.2、`docs/71` §9（WP122b 留的 vision 尾巴）、`docs/briefs/reports/WP122b.md`。

## 交付
1. **契约**：`ChatMessage.content` 正式支持图片部件（WP122b 已加、只加不改），`ModelProvider` 加能力声明 `capabilities: { vision: boolean; image_generation: boolean }`（只加）。
2. **模型验证改成三步**：连通 → 一次最小文字请求 → **一次带图的最小请求**（内置一张几 KB 的测试图，要求模型回一个约定的词）；看不了图的模型**不通过**，人话说明「这个模型看不了图，Agents 工坊要求模型能看图」并列出常见能看图的型号名（只列公开型号名，不列供应商推荐）。向导第 ① 步与设置页共用。官方接口那一侧默认型号必须过同一检验（测试钉住）。
3. **生图单独一档**：设置页「模型」分两块——「文字与看图」「生图」；生图可不配（相关岗位出图时人话提示去配）；用官方接口的生图走积分、按 `pricing.json` 单价常显。
4. **去掉「看不了就跳过」**：WP122b 里 PDF 逐页转图、截图描述图片风格两处改为必走视觉；`docs/71` §9 收口；`ModelPurpose` 不再需要单独的 vision 档（文字模型即多模态）——如果代码里已有 vision 档的半成品，收掉并写进偏离。
5. 老用户已配的不能看图的模型：升级后设置页顶部一条提示 + 岗位卡上不阻塞，但需要看图的动作明说「当前模型看不了图」。
6. 测试：三步验证各分支；能力声明进 SDK / openapi；模拟场景加一条「配了不能看图的模型 → 向导不放行」。docs/70 / 71 / 36 同步。

验证：`scripts/verify-changed.sh` + 两个模拟包门禁。
