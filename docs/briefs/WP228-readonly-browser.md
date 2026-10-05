# WP228 本机只读浏览器（给 Reddit 取数「浏览器只读」那一路，以及以后的只读研究）

worktree `../agentsws-wt/wp228-ro-browser` · 分支 `wp/228-ro-browser`（从 main 新起；WP220 合并后先合一次 main 再接口对接）。先读 `_common.md`、WP220 报告（`docs/briefs/reports/WP220.md`，§三「本机侧还缺一个能自己开页面的只读浏览器」与 Reddit 两路路由、限速设置、`read_reddit` 工具）、`docs/89`（Reddit 取数决定）、现有浏览器能力（官方 browser / computer use，docs/55、WP179）、记忆原则「不打包重型本机方案」（docs 里 grep 重运行时 / 按需下载）、WP218 报告里 Windows 子进程那几条（`windowsHide`、环境变量、8.3 路径）。

## 背景（Luoye 10-05 定「做」）
INMO 的 Reddit 取数两路目前都不通：接口中台要等云端渠道，浏览器只读那一路缺一个本机能自己开页面、只读、限速的浏览器，现在显示「没配」。

## 要做
1. **不打包浏览器**：用用户电脑上已有的 Chrome / Edge（Windows 一定有 Edge），经 CDP 驱动（`playwright-core` 或 `puppeteer-core` 之类**不带浏览器**的库，二选一，评估写进报告；已有依赖能用就不新增）。找不到就照实显示「没找到 Chrome / Edge」+ 一句怎么办。
2. **单独的只读会话**：独立用户数据目录（放 Agents 工坊数据目录下，每品牌一份），**不带任何登录态、不导入用户浏览器的 cookie**；默认无头运行；只允许 GET 打开页面与读 DOM / 文本，不点按钮、不填表、不提交（在驱动层拦，不靠提示词）。
3. **限速与白名单**：照 WP220 的设置（两页隔 20 秒、一小时 30 页、一天 200 页，每品牌可调，最快 5 秒）；只开白名单域名（先 `*.reddit.com`，结构上可扩）；遇到登录墙 / 验证码 / 429 就停下照实说，**不绕、不重试轰**。
4. **接上 WP220 的路由**：Reddit 「浏览器只读」那一路从「没配」变成能取数（帖子列表、帖子正文、评论），产出与接口中台那一路同一个结构；每次取数记来源与是否命中缓存。
5. **mac + Windows 都能跑**：Windows 上中文 / 空格路径、`windowsHide`、退出时关掉浏览器进程（不留孤儿，WP218 的 taskkill 整棵树那套）。
6. 连接页 Reddit 卡上显示这一路的状态（状态图标、少字，docs/36 §7）：可用 / 没找到浏览器 / 今天额度用完 / 被拦了。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；测试用本地假站点（起一个本地 http 服务模拟 Reddit 页面结构），**不真去访问 reddit.com**；不登录任何网站。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；用本机 Chrome 对本地假站点真跑一遍（限速、白名单、登录墙停下、退出无残留）；报告 `docs/briefs/reports/WP228.md`（要 Luoye 定的事单列）。Windows 真机验证由 Fable 远程做。
