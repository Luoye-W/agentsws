# WP119 浏览器插件重做（本地优先）

worktree：`../agentsws-wt/wp119-extension`，分支 `wp/119-extension`。

## Luoye 定
参考 KOLAgents 最新插件（`/Users/yeluo/Documents/Browser Extension - Influencer Assistant`，0.9.20，Plasmo + React，只读参考，不读其 `.env*`）重做一个；**插件数据直接走本地**。

## 先读
那个仓的 `README.md`、`docs/PRD.md`、`docs/TECHNICAL_SPEC.md`、`src/lib/{pluginApi,pairing,backgroundFetch,localHealth,authenticity,valuation,bulkCapture,exportRow}.ts`、`src/contents/*`；本仓 `docs/48` §5 与「KOLAgents 插件」一节（旧定论「插件采集要托管档」**作废**，改为本地优先）、`docs/21`、`docs/36`、`packages/kol-core`、`packages/api`（鉴权与 CORS）、`packages/brand`。

## 定论
1. 新包 `apps/extension`（MV3；Plasmo 或 WXT 二选一取与本仓工具链更合的，理由写进报告；React + 复用 `--ws-*` 令牌与 `@agentsws/brand` 标记；名字「Agents 工坊 · 红人助手」）。
2. **数据走本地**：插件 background service worker 直连本机 `http://127.0.0.1:<端口>`（默认 4317，可在插件里改）的 Agents 工坊服务：
   - **配对**：工作台「连接 → 浏览器插件」显示 6 位配对码（5 分钟有效）→ 插件里输入 → 本机服务签发只给插件用的令牌（scope 仅 `kol.observe` / `kol.capture` / `kol.read`，可在工作台吊销、可见最近使用时间）；本机服务对 `chrome-extension://<id>` 做 Origin 白名单 + 令牌双校验，不开通配 CORS；只监听回环。
   - 采集（用户点了才采，绝不静默采浏览记录）：YouTube 频道 / 视频页观测、搜索结果页批量采集（阈值筛选）、联系方式（用户显式动作）；写进本地 `kol` 对象（观测快照、候选池、活动）。Instagram / TikTok 先做频道页卡片的最小版。
   - 桌面应用没开时：插件本地排队（`chrome.storage`，上限与过期），应用起来后补传；卡片上如实显示「已排队」。
   - 不登录也能用的本地档保留：页内即时体检（播放 / 订阅比、买粉防护）、复制一行、CSV。
   - **上云（Luoye 09-19 定）：只要用户登录（关联）了云账号，观测数据默认共享到公共红人库，不设「贡献」勾选项**。共享的是平台公开可见的红人数据（指标快照、公开联系方式及来源）；用户的私有备注、候选池、活动、往来邮件**不进公共库**。转发由本机服务做，插件自己不直连云端、不持有云令牌；贡献照旧换免费额度，邮箱 reveal 经本机服务走云端计费。未登录 = 纯本地，一条都不上传。
   - **必须如实告知**：首次关联云账号时、插件的隐私说明与 `STORE.md` 里，用一句人话写明「登录后，你浏览时采集到的红人公开数据会共享到公共红人库」——Chrome 应用商店政策要求对数据收集做显著披露，不写会被拒审。
3. 隐私页与权限最小化：host 权限只有三个平台 + `http://127.0.0.1/*`；商店合规文案草稿放 `apps/extension/STORE.md`。
4. 打包：`pnpm -F @agentsws/extension build` 出 `build/chrome-mv3-prod` 与 zip；`release.yml` 加一步把 zip 挂到 Release（只加，不改现有矩阵）。`docs/68-浏览器插件-v1.md` 给内测用户的一页纸（解压 → 开发者模式加载 → 配对）。
5. 测试：配对与令牌、Origin 白名单、排队补传、页面解析器用保存的 HTML 夹具（自己造最小夹具，不拷对方页面全文）、体检算法与 KOLAgents 同输入同输出。

## 验证
通用项 + `vitest run apps/extension packages/kol-core packages/api apps/server apps/workstation`；插件 build 过。
