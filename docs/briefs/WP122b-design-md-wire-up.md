# WP122b 品牌设计规范：把没通电的接上（WP122 的后半）

worktree：`../agentsws-wt/wp122b-design-wire` · 分支 `wp/122b-design-wire`（从 main 新起）。先读 `docs/71`（尤其 §9 九条留尾）、`docs/briefs/WP122-brand-design-md.md`（定论出处）与 `docs/briefs/reports/WP122.md`。

WP122 已合入的是地基（契约 / 存储版本 / 官网 CSS 令牌抽取 / PDF 手册抽取 / 设计规范页 + 右栏面板 / 出图一路的注入 / 规范自检）。这一张把「让它真的被用上」做完：
1. **三个注入口通电**：`site-core`（含 WP89 主题沙箱吃 `themeDesignVariables()`——三条里最值的一条，先做）、`social-core`、`ads-core` 统一走 `brandDesignContext()`；各加一条测试证明提示里真带上了令牌与要点。
2. **四类岗位能读设计规范**（Luoye 未回则按此默认）：给设计 / 建站 / 社媒 / 投放的职责加只读权限（只读这一份 DESIGN.md，不是整个 `policy.read workspace`）；改仍只有 owner。
3. **改一格的小铅笔接界面**；手改过的格子重新抓取时不覆盖（与品牌档案卡同一条规则）。
4. **成文接模型**（便宜档，只根据证据写，没证据的节写「未找到，请补充」；计入积分并封顶，与 WP121 同一套预估）。
5. **视觉档**：模型网关加图生文（`ChatMessage.content` 支持图片部件，只加不改；走用户配置的视觉模型，没有就跳过并如实标注）→ PDF 逐页转图、截图描述图片风格两处接上。
6. Shopify 已连接时读主题设置里的配色与字体；手册支持 docx / pptx（复用 WP99 的解析）。
7. 向导的品牌档案卡上那一行入口与「上传品牌手册」。
验证：`scripts/verify-changed.sh`；截图 `docs/assets/workstation/design-md-*.png` 重拍。
