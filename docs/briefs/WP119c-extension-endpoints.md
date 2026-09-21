# WP119c 插件完整版要的本机接口（WP119b 交付 8）+ 收尾

两个仓库：开源仓库 worktree `../agentsws-wt/wp119c-ext-endpoints` · 分支 `wp/119c-ext-endpoints`；私有仓库 `/Users/yeluo/Documents/agentsws-extension`（分支 `wp/119c-wire`）。许可证红线不变：移植代码只在私有仓库。

先读 `docs/76`、`docs/briefs/reports/WP119b.md` 与私有仓库的 `parity.md` §六（端点清单）。完整版面板的界面已经搬进私有仓库，但它要调的一批本机接口还不存在——**没有这批接口，完整版面板大半是空壳**。
1. 开源仓库按清单逐条加（只加不改，进 `docs/76` 与 JSON Schema / openapi）：`GET setup`、`POST creators`、`GET creators/{p}/{id}/report`、`GET reveal-pricing`、`GET/POST creators/{p}/{id}/contact`（含 `/dispute`）、内容入库、品牌 / 活动 / 候选池列表、`workbench_url` 深链（跳到该红人的合作线程）等；reveal 经本机服务走云端公共库计费（价取 `pricing.json`，余额不足说人话）；鉴权沿用配对令牌的三个 scope，必要时只加新 scope。
2. 私有仓库把面板各区块接到这些接口上，逐区块对拍；`BioLinkCaptureStrip` 挂载（域名清单先用旧插件里已有的那份）；深色主题对齐 `--ws-*` 深色令牌；把截图脚本固化进 `scripts/`。
3. 验收：同一个频道夹具，新面板每个区块都有真数据（不是空态）；新旧并排截图放私有仓库 `docs/`；开源仓库 `scripts/verify-changed.sh` 绿，私有仓库 `pnpm test && pnpm build` 绿。
