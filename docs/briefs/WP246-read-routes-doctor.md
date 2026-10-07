# WP246 取数路线「首选 → 备选 + 体检」推广到各平台；Reddit 浏览器备选用用户登录过的读号；补 YouTube 字幕与网页转文字

worktree `../agentsws-wt/wp246-routes` · 分支 `wp/246-routes`（从 main 新起）。先读 `_common.md`、WP220 / WP228 / WP229 / WP238 报告（Reddit 两路：接口中台 → 本机只读浏览器；`read-route.ts`、`CONNECTION_READ_ROUTES`、`firstUsableReadLevel`、`read_reddit`）、`docs/89`（Reddit 取数决定）、DECISIONS 87 / 88。参考（只看思路、不抄代码、不引依赖）：开源项目 Agent-Reach（MIT，github.com/Panniantong/Agent-Reach）的「每平台 = 首选 + 备选的有序后端列表」+ `doctor` 体检。

## 背景（Luoye 10-07 定 87 / 88）
- Windows 真机上本机只读浏览器读 reddit.com 被人机验证拦（无头、无登录）。Agent-Reach 实测结论也是：Reddit 没有免登录的路，匿名 .json 全 403，官方 API 2025-11 起停止自助申请；能用的只有「借已登录的浏览器会话」。
- 87：不整个集成 Agent-Reach（Python + 一串 CLI，和「用户不碰终端」相冲）；学它的路线表 + 体检。
- 88：Reddit 浏览器备选**不用 INMO 版主号**；版主号只做发帖 / 回复（走审批卡）。读用接口中台，或用户另登一个普通「读号」。

## 要做
1. **通用路线表 + 体检**：把 Reddit 那套「路由 = 有序级别列表」抽成各平台通用（先 Reddit、YouTube、网页三条；结构上能加 X / TikTok / Instagram），每级有统一的「体检」：通 / 不通 + 一句人话原因 + 怎么修。新增一个体检接口与连接页上一块少字的「取数路线」状态（每平台一行：现在走哪一级、哪级断了），一键「重新体检」。
2. **Reddit 浏览器备选改用登录过的读号**（改 WP228 的「不带任何登录态」）：
   - 每品牌的只读浏览器配置目录保留；新增「登录读号」：**有头**打开这个配置目录的浏览器到 reddit.com 登录页，用户自己在网页上登录（我们不碰密码、不读 cookie 内容），关掉后体检显示「已登录：u/xxx」（读页面上的用户名即可）。
   - 界面上明说「用一个普通号，别用版主号 / 品牌官方号」；若识别到登录的号是本品牌在「登记的号」里标为官方 / 版主的那个，就拦下并提示换号。
   - 自动读取时仍只读（驱动层拦点击 / 提交）、限速与白名单照旧；评估「有头最小化 / 新无头模式」哪个更不容易触发验证码，写进报告。遇到验证码照实停下，提示用户在「登录读号」窗口里手动过一次。
3. **YouTube 字幕**（零配置一级）：给红人调研 / 竞品分析读视频字幕与标题简介。优先不引新运行时（不要 yt-dlp / Python）：用页面里的字幕轨（timedtext）或接口中台已有能力；拿不到照实说。作为 `read_youtube_transcript` 工具挂到相关职责（红人营销、社媒运营）。
4. **网页转文字**（零配置一级）：任意网址 → 干净正文 markdown。优先本地抽取（已有 brand-intake 的正文抽取 / readability 思路，WP244 刚修过摘要去导航）；第三方服务（如 Jina Reader）只作可选备选、默认关，开时明说数据会经过第三方。
5. 测试：本地假站点覆盖各级通 / 不通 / 降级；读号是官方号被拦；体检接口与连接页状态。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；**不真去访问 reddit.com / youtube.com**（本地假站点）；不登录任何网站；不引入 Python 运行时。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；连接页「取数路线」与「登录读号」出截图；报告 `docs/briefs/reports/WP246.md`（要 Luoye 定的事单列）。Windows 真机验证由 Fable 远程做。
