# WP130 插件采集范围补齐（移植）：YouTube 搜索页与相关视频栏、Instagram / TikTok 搜索列表与 hashtag 页

私有仓库 `/Users/yeluo/Documents/agentsws-extension`，分支 `wp/130-capture`；开源仓库若需加接口：worktree `../agentsws-wt/wp130-ext-capture` · 分支 `wp/130-ext-capture`。**许可证红线不变**：移植代码只进私有仓库。

## Luoye 定（09-23）
旧插件本来就有这几处采集，新插件没同步过来，要补上：① YouTube 搜索结果页；② YouTube 视频页右侧的相似视频列表；③ Instagram 搜索列表与 hashtag 页；④ TikTok 搜索列表与 hashtag 页。**按「移植优先于复刻」做**：从旧插件 `/Users/yeluo/Documents/Browser Extension - Influencer Assistant` 的 `src/lib/bulkCapture.ts`、`src/contents/*`（搜索页 FAB、列表解析）、各平台解析器与它们的 `__tests__` 整块搬，只改接口（本机服务）、品牌与文案。

## 先读
私有仓库 `parity.md`、`docs/`；开源 `docs/68`、`docs/76`；旧插件 `docs/TECHNICAL_SPEC.md` 里关于 list capture / hashtag 的章节。先逐页列一张表：旧插件在每种页面上采什么字段、有什么筛选（阈值、去重、上限）、怎么节流；新插件现状（有 / 部分 / 无）——这张表进报告与私有仓库 `parity.md`。

## 交付
1. YouTube 搜索结果页：核对新插件已有的批量采集是否与旧插件字段、阈值筛选、上限、节流一致；差的补齐。
2. YouTube 视频页相似视频列表：列表采集 + 每行小体检徽标 + 阈值筛选 + 批量收进红人库 / 内容库；来源标注「相关视频」。
3. Instagram：搜索列表与 hashtag 页（帖子网格 → 作者聚合 → 去重 → 阈值 → 批量收进）；帖子级数据进内容观测。
4. TikTok：同上（搜索列表 / hashtag 页 / 视频作者聚合）。
5. 采集全部**用户显式触发**（FAB 或按钮），不静默；节流与去重沿旧插件；登录了云账号的照默认规则共享公共库（窄行）；内容观测走 WP129 的内容路（若 WP129 已合入，接它；否则先落本机）。
6. 开源仓库如需新字段 / 新端点：只加不改，进 `docs/76`。
7. 验收：每种页面各一个本地 HTML 夹具（自造最小夹具，不拷对方页面全文），解析器与旧插件**同输入同输出**（把旧 `__tests__` 搬来对拍）；playwright 对四种页面各截一张新旧并排图进私有仓库 `docs/`。私有仓库 `pnpm test && pnpm build` 绿；开源仓库 `scripts/verify-changed.sh` 绿。
