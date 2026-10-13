# WP304 建站先选主题：高级主题（付费）优先推荐 / 店里任意免费主题都能拉下来改（决策 445）

worktree `../agentsws-wt/wp304-themechoice` · 分支 `wp/304-themechoice`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP301.md`（Horizon 起底、`horizon-catalog.ts`、`site-theme.ts`、旧目录 legacy）、`docs/59-建站岗位-v1.md` §9、`docs/96`（卡片流 / 组件、界面少字）。

## Luoye 10-13（决策 445）
用户要做网站时第一步选主题：
- **① 我们的高级主题**（付费增值，**优先推荐、排第一**）：按店铺一次性买断 **$80（=560 积分）**；买了才从云端私有存储下载、推到他的店（云端那一半由私有云 WP305 做，本单只做工坊一侧的接口与界面，云端未就绪时卡上显示「即将开放」或按云端返回的状态）。
- **② 免费主题**：用户自己去 Shopify Theme Store 选一个免费主题装进店里（默认推荐 Horizon），工坊把它拉下来定制。

## 要做
1. **选主题卡**（建站岗位第一次起底、或人说「换主题」时出）：属于「选一个」卡家族（docs/96）；第一项高级主题（一句卖点 + 价格 + 预览图 / 示例店链接占位），第二项「用我店里已装的免费主题」（列出店里现有主题名，选一个；没有就说「去主题商店装一个，推荐 Horizon」并给链接）。
2. **任意免费主题都能改**：把 WP301 只认 Horizon 的起底 / 目录生成 / 规矩，泛化成「任何 Online Store 2.0 主题」：认主题时读 `settings_schema.json` 的 `theme_info`，按它自己的 section / block schema 现生成目录；规矩里 Horizon 专属的写法改成按主题能力判断（有没有 `@theme` 块、私有块、静态块等）；Horizon 仍是默认推荐与测试最全的那一个。不认识的老主题（非 2.0）如实说「这个主题太老，工坊改不了，建议换 Horizon」。
3. **高级主题一侧**：起底工具多一个来源 `premium`：调云端 `GET /v1/themes/premium/entitlement?shop=…`（有没有买）与 `GET /v1/themes/premium/download`（拿下载地址 / 包，需要登录令牌）——接口形状照私有云 WP305 报告为准（并行开发时先按本单写的约定、云端未就绪就显示「即将开放」）；买入走「花钱」家族卡（560 积分，人点了才扣），下载后核 sha256、推成未发布主题、出预览。主题文件只进用户自己的工作目录与他的店，不进安装包、不进日志。
4. 测试：选主题卡两条路径；任意 2.0 主题（用录制的非 Horizon 主题 schema 夹具，**不进 Horizon 或任何第三方主题代码**，只放我们自己手写的最小 schema）生成目录；老主题拒；高级主题未买 → 出花钱卡、已买 → 下载推送（替身云）。截图 `docs/assets/wp304/`。

## 纪律
不读 .env*；不碰 key / token；不跑批量清理；不碰本机 4317；不连远程机器；不碰真实店铺；不把任何主题代码（我们的闭源主题、Horizon、第三方）放进开源仓。不合 main、不打 tag、不发版。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + `open-repo-boundary` + 装包前冒烟；报告 `docs/briefs/reports/WP304.md`（决策号从 480 起）。
