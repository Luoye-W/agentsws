# WP122 品牌设计规范 `DESIGN.md`：从官网抓、从 PDF 读、让每个岗位都照着它出活

worktree：`../agentsws-wt/wp122-design-md`，分支 `wp/122-design-md`。**在 WP121 合并之后开工**（复用它的 `packages/brand-intake` 抓取结果与品牌档案卡）。

## Luoye 定（09-19）
每个品牌都有自己的一套设计规范。要有一份 **`design.md`**：可以从官网自动「抓」出来；用户也可以上传品牌手册 PDF 之类，让 AI 分析着写。根据网站自动写 design.md 已有开源项目，**借鉴后放进来**。

## 调研结论（Fable 已查，开工前你再核一遍许可证与活跃度，按 `docs/42` 的上游评估格式记一条）
- **文件格式用 Google Labs 开源的 DESIGN.md 规范**（`github.com/google-labs-code/design.md`，Apache-2.0，alpha）：YAML front matter 放机器可读的设计令牌（颜色、字体、字号、间距、圆角、组件样式），正文 Markdown 写给人和模型看的设计理由与用法。用通用格式的好处：用户拿这份文件去 Stitch / Claude Code / Cursor 也能直接用，我们不自造格式。
- **抓取思路可借鉴的开源项目**（多为 MIT）：`dembrandt/dembrandt`（一条命令抽 logo、颜色、字体、边框等令牌）、`sunil-dsb/design.md`（每个值带出处页、CSS 变量名、所在区域）、`jasonhnd/design-md-generator`（取计算后样式，按稳定度分类）、`jpoindexter/design-md-extractor`（含渐变、阴影、动效、交互状态；CLI + MCP）、`Manavarya09/design-extract`（designlang）。共同做法：无头浏览器打开页面 → 读**计算后样式**与 CSS 变量 → 按出现频次与所在区域聚类 → 交给模型写成文。
- 取舍：**不整包引入某个 CLI 当运行时依赖**（它们各带一套 Puppeteer / Playwright，体积与维护都重；桌面壳里已经有工作浏览器）。做法是借鉴算法、在我们自己的抓取器上实现；若某项目的核心抽取模块足够小、许可证干净，可按 `docs/42` 走依赖评估后引入并在 `THIRD_PARTY_NOTICES` 里署名。借鉴了谁，在 `docs/71` 与源码头注释里写明。

## 先读
`docs/58`（设计岗位）、`docs/59`（建站）、`docs/56`（社媒）、`docs/57`（投放）、`docs/36` §12（我们自己的品牌标记规范，别和用户品牌的 design.md 混为一谈）、`docs/42`、`docs/70`（WP121）、`docs/69`（WP120 persona，若已合）；代码 `packages/brand-intake`（WP121）、`packages/design-core`、`packages/site-core`、`packages/social-core`、`packages/ads-core`、`packages/knowledge`、`packages/model-gateway`（含 `images` / 视觉能力）、桌面壳工作浏览器 `apps/desktop/src/work-browser.ts` 与 `packages/dsh-adapter/src/browser.ts`、右栏 `components/rail/*`。

## 定论
1. **每个品牌（工作区）一份 `DESIGN.md`**，存本机（随品牌数据走，开了红人营销增值服务 / 云同步的照常同步），有版本历史、可导出下载、可整份粘贴替换。契约 `packages/contracts/src/brand-design.ts`（只加）：令牌结构对齐 DESIGN.md 规范，外加每个值的 `source`（网址 + 选择器 / PDF 页码）与 `confidence`。
2. **三条来路，可叠加**：
   - **从官网抓**：WP121 分析时顺带跑（同一次抓取，不多访问一遍）。取首页 + 商品页 + 集合页 + 博客页各一，读计算后样式与 CSS 变量：主色 / 辅色 / 中性色 / 语义色（按面积与出现位置判主次，不只按频次）、字体族与字重、字号阶梯、行高、间距阶梯、圆角、阴影、边框、按钮 / 输入框 / 卡片 / 导航 / 徽标的样式、logo（含深浅版）、图片风格（摄影 / 插画、色调、构图，用视觉模型看截图描述）、动效倾向。Shopify 站额外读主题设置里的配色与字体（有连接时）。
   - **上传文件**：品牌手册 PDF / 图片 / pptx / docx（复用 WP99 的知识上传与 Office 预览链路）。PDF 走「文字 + 逐页转图给视觉模型」双路，抽颜色值（HEX / RGB / CMYK / Pantone 原样保留并换算 HEX）、字体、logo 用法与禁用、留白、图像风格、语气。文件里写的规范**优先级高于**官网抓到的（官网可能没照手册做），冲突处在界面上并排标出让用户选。
   - **手改**：所有字段可改。
3. **正文由模型写成文**（用法、禁忌、什么场合用哪种色、logo 最小尺寸与留白……），只根据抓到 / 读到的证据写，没证据的节写「未找到，请补充」，不编。走模型便宜档 + 视觉档，计入积分并在开跑前给预估与封顶（与 WP121 同一套）。
4. **界面**：品牌设置里加「设计规范」页——上半**可视化**（色板色块带名字与用途、字体样张、字号阶梯、间距与圆角示意、按钮 / 卡片样例用这些令牌实时渲染、logo 深浅底预览），下半是 `DESIGN.md` 原文编辑器（左改右预览）；每个值点开能看出处（网页截图区域 / PDF 页）。右栏加「设计规范」面板（走 `registerPanelBody`）：设计 / 建站 / 社媒 / 投放岗位干活时随手可查。初始化向导（WP121 ②）的品牌档案卡上加一行「设计规范：已抓到 N 色 · N 字体 · logo」+「上传品牌手册」入口。
5. **让它真的被用上**（这是这件事的价值所在）：
   - `design-core` / `site-core` / `social-core` / `ads-core` 的出图、出页面、出邮件模板、出广告素材的提示与技能里，统一注入该品牌 DESIGN.md 的令牌与要点（做成一个共享的 `brandDesignContext()`，别四处各拼一遍）；WP89 的主题沙箱预览直接吃这些令牌。
   - 产出物过一道**规范自检**（颜色是否在色板内、字体是否在字体表内、logo 留白与最小尺寸、对比度是否达标），不合的在卡片上标出来（variants / publish 排版卡上的一行提示），不拦人。
   - 进岗位 persona 的品牌上下文（WP120）：语气与视觉气质那一两句。
6. **边界**：只抓用户自己填的网址的公开页面，遵守 robots 与频率；不把别人网站的图片素材存成我们的资产（只存 logo 与用于出处展示的截图区域缩略图，存本机）；用户上传的手册只在本机与用户选定的模型之间流动。
7. 文档 `docs/71-品牌设计规范DESIGN.md-v1.md`（格式对齐说明、三条来路与优先级、抽取算法与借鉴来源、自检规则、谁在用它）；`docs/58` / `docs/59` / `docs/70` 同步；`THIRD_PARTY_NOTICES` 视情况更新。

## 交付（每项一个 `git commit -s`，每项有测试；抓取与 PDF 全用本地夹具，模型用替身）
1 契约 + 存储 + 版本；2 官网抽取器（夹具：一个 Shopify 风格站、一个自建站，断言主次色判定、字体阶梯、出处）；3 文件抽取器（夹具：一份自造的两页品牌手册 PDF）+ 冲突合并；4 成文与积分封顶；5 设计规范页 + 右栏面板 + 向导入口 + i18n + 截图 `docs/assets/workstation/design-md-*.png`；6 `brandDesignContext()` 接四个 core + 规范自检 + 卡片提示；7 docs。

## 验证
通用项 + `vitest run packages/brand-intake packages/contracts packages/design-core packages/site-core packages/social-core packages/ads-core packages/knowledge packages/api apps/server apps/workstation packages/simulation` + 两个模拟包门禁。
