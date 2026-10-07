# WP255 工作台「回复」按钮（自家版待处理、社群线程列表）+ 随包 Node / npm 登记上游名单（决策 144 / 145）

worktree `../agentsws-wt/wp255-reply` · 分支 `wp/255-reply`（从 main 新起，含 WP249 / WP254）。先读 `_common.md`、WP249 报告（自家版待处理快捷视图）、WP254 报告（`POST /v1/social/threads/:id/reply`、回帖卡、承诺话术打回、`social-executor`）、社群线程列表组件、`apps/desktop/node-runtime.lock.json`、`apps/desktop/scripts/fetch-node.mjs`、`upstreams.yml`、`scripts/check-upstreams.mjs`、docs/42。

## 要做（Luoye 10-07 同意）
1. **（144）回复按钮**：在「自家版待处理」每一条、社群线程列表每一条上加「回复」。点开一个小输入框（可让 AI 先起草一句，人改），提交走 `POST /v1/social/threads/:id/reply` → 出回帖卡进卡片流（不直接发）；承诺话术被打回时就地提示原因。界面少字：按钮一个词，说明进问号。
2. **（145）上游名单登记随包 Node / npm**：`upstreams.yml` 登记 node（22.x 钉的版本 + 每平台 sha256 来源）与 npm（10.9.8 + sha512），`check-upstreams.mjs` 能对账 `node-runtime.lock.json`；docs/42 补「Node 出安全版时连 npm 一起升」：`fetch-node.mjs --write-lock --all` → 测试 → 打包冒烟。
3. 测试：回复按钮出卡、承诺话术打回、AI 起草可改；upstreams 对账通过与不一致时报错。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不访问真实社媒站点；测试不真去下载 node / npm。另有子代理在做 WP253（shopify-theme、platform-cli-runner、建站岗位页）——不动那些文件。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary` + `node scripts/check-upstreams.mjs`；回复框出截图；报告 `docs/briefs/reports/WP255.md`（要 Luoye 定的事单列）。
