# WP200 品牌标记两处小调（浅色主题光调淡、README 标记动起来）

worktree `../agentsws-wt/wp200-brand-tweaks` · 分支 `wp/200-brand-tweaks`（从 main 新起）。先读 `_common.md`、WP195 报告 `docs/briefs/reports/WP195.md`、`packages/brand`、`apps/workstation/src/components/design/brand-mark*.ts*`、`scripts/gen-brand-assets.py`、`scripts/gen-brand-motion-preview.mjs`、`docs/36` §12.6。

## 定了的（Luoye 09-29 同意 Fable 建议）
1. **浅色主题下「波 + 流光」的光扫过会短暂发白** → 浅色主题把流光调淡（降低光的不透明度 / 换成更贴近品牌色的淡光），保留效果，深色主题不变。对比截图（改前 / 改后，24 / 40 / 96 三个尺寸）。
2. **README 顶上的标记改成会动的**：出一份独立的动态 SVG（内联 CSS keyframes、不带脚本，GitHub 的 `<img>` 里能动），明暗两版用 `<picture>` + `prefers-color-scheme`；`prefers-reduced-motion` 时静态；README 引用它。

## 纪律
纯 SVG + CSS，零新依赖；不读 .env*；本机 4317 服务别碰。

## 验证
`scripts/verify-changed.sh` + `gen-ontology --check` + `open-repo-boundary`；预览页重生成；报告 `docs/briefs/reports/WP200.md`。
