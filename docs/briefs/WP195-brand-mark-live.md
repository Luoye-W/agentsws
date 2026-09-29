# WP195 品牌标记默认动起来（常驻待机动效 + 用处改动态）

worktree `../agentsws-wt/wp195-brand-live` · 分支 `wp/195-brand-live`（从 main 新起）。先读 `_common.md`、`docs/36` §12（标记四种姿态用在哪）、`packages/brand`、`apps/workstation/src/components/design/brand-mark.tsx` 与 `brand-mark.geometry.ts`（抬头写了母品牌规范出处与三条硬规矩）、`apps/workstation/src/index.css` 里标记的 keyframes、WP112 合并记录（docs/35）、`apps/workstation/src/components/{app-shell,boot-splash,brand-icons}.tsx`。

## 背景（Luoye 09-29）
「我们的 logo 静态的其实不好看，尽量用动态的 logo 方案。」
现状：WP112 做了四种姿态（`none` 静态 / `assemble` 集结 / `breathe` 呼吸 = Agent 正在干活 / `split` 一变一队），但**常驻位置全用静态**（左栏顶部、各处图标、favicon）。

## 要做
1. **新增常驻待机动效**（给一直挂在屏幕上的标记用，不能抢眼、不能和 `breathe`「Agent 正在干活」混淆）。先做 **3 个候选**，例如：隔一段时间方块依次轻微起伏一轮的「波」、渐变沿方块缓慢流动的「流光」、偶尔一块轻轻错位再归位的「眨眼」——以你的判断为准，但都要满足：周期长（≥ 6 秒一轮，大部分时间静止或极缓）、幅度小、CPU 省（只动 transform / opacity，SVG 里照 §4.1 坑 1 写 `transform-box`）、页面不在前台时停（`animation-play-state` 或 `document.hidden`）。
   - 做成 `motion="idle"` + `idleStyle` 三选一（默认挑你认为最好看的那个），参数进 `brand-mark.geometry.ts` / `packages/brand`；
   - 一页预览 `docs/design/brand-motion.html`（单文件、内联、不引外部脚本）：三个候选并排、明暗两套、大中小三个尺寸，另附四种原有姿态，方便 Luoye 挑；录一段 GIF 或几张连拍截图放 `docs/design/shots/`。
2. **交互**：鼠标悬停在左栏顶部标记上播一次 `split`（一变一队）再回待机；点击回首页不变。
3. **用处改动态**（docs/36 §12 同步改）：
   - 左栏顶部、登录 / 关联账号页、云端运营后台左上角（开源侧 `@agentsws/brand` 导出同一套，私有仓后台跟改列进报告交 Fable）、「随便聊」空态、关于页 → `idle`；
   - 冷启动 / 首次设置仍 `assemble`，Agent 在干活仍 `breathe`，完成回执仍 `split`；
   - 模型列表里的小图标（< 28px）保持静态单色（规范：太小方块会糊），悬停时可播一次；
   - favicon：做一版 SVG 动态 favicon（浏览器支持就动，不支持就是静态），桌面托盘图标保持静态。
4. `prefers-reduced-motion: reduce` 时一律静态（现有规矩不变）；加一个设置项「界面动效：跟随系统 / 开 / 关」（放「设置 → 外观」若有，没有就放通用），默认跟随系统。
5. 测试：待机类名挂上、reduce 时不挂、页面隐藏时暂停、悬停触发一次 split、<28px 不挂待机。

## 纪律
纯 SVG + CSS，零新依赖；不跑批量清理命令；不读 .env*；本机 4317 服务别碰；WP193（官网设计）在并行，会复用你的待机参数，改了参数名写进报告。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 stub 零漂移 + `gen-ontology --check` + `open-repo-boundary`（vitest）；报告 `docs/briefs/reports/WP195.md`，附预览页路径与截图。
