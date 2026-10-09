# WP290 装包前真机冒烟（决策 332，docs/96 §6）

worktree `../agentsws-wt/wp290-smoke` · 分支 `wp/290-smoke`（从 main 新起）。先读 `_common.md`、`docs/96-卡片流与组件化复盘-v1.md` §1 / §6、`packages/dsh-adapter/test/tool-params-strict.test.ts`（10-09 热修的来龙去脉）、`.github/workflows/desktop-windows.yml`、`apps/desktop` 打包脚本、`apps/cli` 的 simulate / demo。

## 为什么
10-09 真机：店铺工具参数表 dsh 不认，**运行一启动就挂**，但单测与三包模拟全绿（模拟没摆这些工具、没走真 dsh 的工具编译），到了 Windows 才暴露。Luoye 定：每次给 Windows 装包前，必须先过一遍「真 dsh」的端到端冒烟，挂了不装。

## 要做
1. 一条命令 `node scripts/preinstall-smoke.mjs`（可指定已打好的产物目录，默认用当前构建）：
   - 用**真的 dsh 运行时**（不是 stub），模型换成本机起的假 OpenAI 兼容服务（按脚本回固定的工具调用 / 文字，不花钱、不联网）。
   - 起一个临时数据目录的本机服务（别用 4317，用随机端口，跑完删临时目录）。
   - **每个岗位模板**各建一个岗位，把它全部职责的工具都摆进运行（这一步就能抓到「参数表 dsh 不认」这类问题）。
   - 每个岗位走一遍：岗位入口问一句（当场答，WP287 合后）→ 交办一件（建事项、出一张卡）→ 点掉卡 → 事项状态正确；运行失败时界面要显示「没跑成」而不是「跑完了」（WP287 合后）。
   - 结果一张表：岗位 × 步骤，失败带原始错误；任一失败退出码非 0。
2. 接进打包流程：`desktop-windows.yml` 在 NSIS 打包前跑它（失败就不出安装包）；本机 Fable 装包脚本也先跑它。说明写进 `docs/35` 顶部的「装包流程」或相应文档一段。
3. 测试：脚本自身有一条测试证明它能抓住 10-09 那个错（把一个工具参数表故意改坏 → 冒烟红）。

## 纪律
不读 .env*；不碰 key；不跑批量清理命令；不碰本机 4317；不连远程机器；不调真实付费 API（模型一律假服务）。另有子代理在 wp287-entry / wp289-smalls 两个 worktree 收尾，别动它们的目录。合并前若 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。

## 验证
脚本在本机跑通（贴结果表）；`scripts/verify-changed.sh`；报告 `docs/briefs/reports/WP290.md`，要 Luoye 定的事单列、每条附建议。
