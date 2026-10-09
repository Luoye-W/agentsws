# WP283 生图收尾：改图 / 生图带「谁」、OpenRouter 型号隐藏遮罩、gpt-image-1.5 指到 2（决策 300 / 301 / 310）

worktree `../agentsws-wt/wp283-imgfix` · 分支 `wp/283-imgfix`（从 main 新起，含 WP281 / WP282）。先读 `docs/briefs/reports/WP268.md`、`WP274.md`、`WP282.md`（§要 Luoye 定第 2 条）、私有云报告 `~/Documents/agentsws-cloud/docs/briefs/reports/WP280.md`（只读）、`_common.md`。

## 要做
1. **310（缺陷）**：`apps/server/src/models.ts` 等走官方云接口生图 / 改图的那条路径打云时没带 `X-Agentsws-Member`（及岗位，照对话 / 搜索数据那几条的做法），补上；加测试：生图、改图请求都带归属头。顺带全仓查一遍还有哪些打云路径没带归属头，一并补并在报告里列出。
2. **300**：经 OpenRouter 的型号（GPT Image 2.5 flare / sunburst、Nano Banana 2.1、gpt-image-2 / 1 / 1-mini）改图时不支持遮罩——这几个型号在工作台改图界面隐藏「圈区域 / 遮罩」入口（按型号能力表判，别写死名字散落各处）；Seedream 等支持的照旧。
3. **301**：本机设置里存的 `gpt-image-1.5` 读到时自动当 `gpt-image-2`（迁移或读时映射，二选一并说明），界面型号列表不再出现 1.5。
4. 测试 + 截图（`docs/assets/wp283/`：OpenRouter 型号改图无遮罩入口、Seedream 有）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真实付费 API；私有云只读。合并前若 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP283.md`，要 Luoye 定的事单列、每条附建议。
