# WP223 设计岗加「视频剪辑」职责（调研 + 定义 + 落地第一版）

worktree `../agentsws-wt/wp223-video` · 分支 `wp/223-video`（从 main 新起）。先读 `_common.md`、`docs/50`（职责按人切）、`docs/69`（persona 六段与上限）、`docs/91` §7 #4、`packages/roles/positions/design.yml` 与 `packages/roles/roles/design/*.yml`（尤其 `social.yml`、`amazon.yml` 的写法——视频剪辑照它们的格式写）、`docs/58`（设计需求单从哪来）、记忆里「不打包重型本机方案」那条原则（本仓 docs 里 grep「重运行时」「按需下载」）。

## 背景（Luoye 10-05）
「加一个【视频剪辑】职责吧。」设计岗现在 5 条（广告 / 独立站 / Amazon / 社媒 / 展会）只出图，视频只做到封面。

## 要做
1. **调研**（写进 `docs/92-视频剪辑职责调研-v1.md`）：开源的视频剪辑 / 短视频生产项目与 Agent 技能（按 star 列，许可证写清），以及几篇讲短视频剪辑做法的文章（钩子前 3 秒、字幕、多比例、平台规格）。至少看：FFmpeg（注意 LGPL / GPL 构建区别）、MoviePy、auto-editor、Remotion（**许可证对公司有限制，查清能不能用**）、各家 Agent 技能仓里和视频剪辑相关的。另列「AI 生成视频」的接口（可灵 / Seedance / Veo 一类）只做调研、标「以后走接口中台」，这一单不接。
2. **职责定义** `design.video`（中「视频剪辑」/ 英 Video Editing）：
   - 管：用品牌给的素材、产品图、红人授权过的 UGC 剪短视频（TikTok / Reels / Shorts / Amazon 商品视频）；一个成片出多比例（9:16 / 1:1 / 16:9）、烧字幕 + 出 srt、封面、按各平台规格自检（时长、尺寸、大小）。
   - 不管：发布（转社媒 / 投放 / Amazon 运营那几条）；拍摄；写脚本里的卖点数字（只从事实卡取）。
   - 需求从社媒、投放、红人营销、Amazon 运营来，照现有设计需求单的入口。
   - 必须出卡：每个成片都是草稿，挑哪版、用不用人定。**配乐只用品牌自己有授权的或平台自带音乐库**，不往成片里塞来路不明的音乐；红人素材没授权记录不用。
   - persona 照六段写、过 checkPersona；技能写做法（钩子、节奏、字幕、多比例、平台规格表放公司层阈值 / 事实卡，不写进正文）。
3. **工具**：剪辑跑在本机，FFmpeg 不进安装包，**首次用到时按需下载**（照现有按需下载的写法，标出处与许可证，选 LGPL 构建），下好之前这条职责能出剪辑方案、不能出成片，照实说。Windows 和 mac 都要能跑（WP218 刚补了 Windows 子进程那几处，`windowsHide` 照着加）。
4. 卡片与界面：成片卡能直接预览视频（多比例切换）；状态用图标，少字（docs/36 §7）。
5. 种子数据 / demo / 模拟包里加一条视频需求的样例；评测集加几条。

## 纪律
新依赖先评估（许可证、体积、维护）写进报告；不跑批量清理命令；不读 .env*；本机 4317 服务别碰。并行中：WP222 在改 `packages/roles/roles/ads/*` 加 `request_design`——你给设计需求单加「视频」这一类时只加、不改它的结构，冲突留给 Fable。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub（有漂移逐条说明）+ `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `open-repo-boundary`（vitest）；用一段自己生成的测试素材（FFmpeg 合成色块 + 文字即可，不下载网上视频）真剪一次出三比例；截图：职责页、成片卡；报告 `docs/briefs/reports/WP223.md`。
