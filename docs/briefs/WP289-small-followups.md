# WP289 几件小收尾（决策 293 / 307 / 313 / 318）

worktree `../agentsws-wt/wp289-smalls` · 分支 `wp/289-smalls`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP278.md`（退出断开个人连接）、`WP282.md`（§要 Luoye 定第 1 条）、`WP283.md`（遮罩进素材库）、`WP284.md`（职责规矩簿 `role-rules.json`、`GET/PUT/DELETE /v1/roles/:id/rules`）。

## Luoye 10-09 同意
- **293**：发起人「请他离开」时，也断开那个人自己接的「个人」连接并删本机凭据，确认框里同样列出名字（复用 WP278 退出那一套）。
- **307**：② 非发起人 / ③ 普通成员在设置 → 账号看到「还没关联」——余额、本月合计、价目、充值档对所有人**只读**开放，充值按钮仍只给有权限的人。
- **313**：素材库默认不显示用途为 `mask` 的图（遮罩），需要时筛选里能看到。
- **318**：聊天窗「教 AI」里的「以后都这样」接进同一本职责规矩簿（WP284）：不管从卡片指导还是聊天里教，都落进同一处、同一套权限（① 本人 / ② 谁都能改可撤回 / ③ 老板批）、同样进运行提示词；聊天自己那套沉淀若与之重复，收成一处。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真实付费 API。另有子代理在做 WP287（岗位入口：问一句答一句、路由、复盘卡、键盘提示、① 权限）——**不要动岗位页、路由、复盘卡相关文件**；合并前若 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。界面少字。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP289.md`，要 Luoye 定的事单列、每条附建议。
