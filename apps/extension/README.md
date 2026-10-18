# @agentsws/extension（参考实现）

**这是「插件开放接口」的参考实现，功能精简。官方完整版不开源**——早期内测用户装的是私有 Release 里的 zip。

> 现在：随 Agents 工坊安装包带、跟着工坊更新的就是这一份（「Agents 工坊助手」，红人 + 广告 + Reddit），
> 不再让人下载 zip。见下面「随工坊安装与更新」。

它示范的是接口怎么用，不是功能上限：

- 本机直连 + 6 位配对码（配对时绑定扩展 Origin 与令牌）；
- 观测上报（幂等、离线队列补传）；
- 登录云账号即共享公开数据到公共红人库，如实告知（`hello` 里的 `shares_to_public_library`）；
- 广告动作通道（`src/lib/ads/*`）——可选权限连接两家广告后台，长轮询领批过的活，
  在看得见的后台标签页上按写死的步骤表执行（规矩在 `@agentsws/browser-action`），顶上「正在操作 · 停止」横条。
  真浏览器走法：`node scripts/e2e-ext-actions.mjs`（本地假后台，不碰真站）。

- **常驻侧边栏**（WP413，`src/entrypoints/sidepanel/`、`src/ui/side-panel.tsx`）：点工具栏图标打开 Chrome 侧边栏
  （YouTube / Instagram / TikTok 页面上照旧开 / 关页面面板）。三块：**要你处理**（「发出去」类卡：看 / 改 / 不发 /
  填进页面——插件新开标签页填好草稿，发送永远由人点）、**进度**（读了什么、几点、下次几点、起草中几条）、**记录**
  （发出记录、记录去处写进去没有）。接口是 `GET /v1/extension/panel` 与 `POST /v1/extension/panel/cards/:id/{fill,skip}`、
  `POST /v1/extension/panel/writes/:job/refill`（插件令牌；插件里批 = 工坊里批，决定记 `via: 'extension'`）。
  真浏览器走法：`node scripts/e2e-wp413-sidepanel.mjs`（真本机服务 + 替身 Reddit 页面，不碰真站）。

想自己写一个采集插件：只要做配对与上报两步（照 `src/lib/local-client.ts` 的写法），不需要整份代码。想看面板、打分、体检这些功能长什么样：用官方完整版。

## 开发

```sh
pnpm install
pnpm -F @agentsws/extension build   # wxt build + zip
pnpm -F @agentsws/extension test
```

## 随工坊安装与更新

插件**不上架商店**。工坊安装包里带着构建好的 `chrome-mv3`，桌面版每次启动把它放到数据目录下一个**固定文件夹**
（`<用户数据目录>/chrome-extension`：Mac `~/Library/Application Support/@agentsws/desktop/chrome-extension`，
Windows `%APPDATA%\@agentsws\desktop\chrome-extension`）。用户只在第一次「加载已解压」时动一次手（连接卡上
「打开插件文件夹」「打开 Chrome 扩展页」两个按钮）；之后：

1. 新版工坊起来后比对文件夹里那一版，变了就先写到旁边的临时目录、逐个文件校验完整，再**整体换掉**旧目录
   （换失败就保留旧版，记下原因；见 `apps/desktop/src/extension-sync.ts`）；
2. 插件每分钟问一次本机「文件夹里是哪一版」（`POST /v1/extension/version`，同时报自己正在跑的版本）；
   不一样就**等空闲**（广告 / Reddit 的领活与执行都停在一件做完之后，不再领新的）再 `chrome.runtime.reload()`；
3. 重载后插件报新版本号，工坊记一条事件（`extension.updated`）；重载了还是旧版（多半是从别的文件夹加载的）
   就不再重试，记 `extension.update_failed`，连接卡上照实说一句。Chrome 没开就等下次启动自然读新文件。

### 固定 id

`src/lib/identity.ts` 里的 `key` 是一把 RSA 公钥（只放公钥）。Chrome 对已解压插件默认按路径算 id，写了 `key`
就按公钥算：id 固定为 `mlbfinfiigagllemohnopbhfdghagijg`，配对（令牌绑扩展 id）、`chrome.storage`、
已授的可选权限都跟着 id 走，换文件夹、换电脑路径都不丢。私钥只在打 `.crx` 或上架时才用得到，两样都不做，没有留。

### 版本号

桌面打包（`apps/desktop/scripts/dist.mjs`）构建插件时给 `AGENTSWS_EXTENSION_VERSION` = 工坊版本；Chrome 的
`version` 只认数字（`0.2.0`），完整那串进 `version_name`（`0.2.0-beta.8`），比对用 `version_name`。

### 实测（`node scripts/probe-ext-chrome.mjs`，品牌版 Chrome、临时用户目录）

- 新版多要权限：已解压插件重载后**照常开着、新权限直接生效**，不弹窗、不停用；
- 开发者模式：Chrome 155 已经没有老的「停用开发者模式扩展程序」启动提示；但**关掉开发者模式，插件就被停用**
  （再打开就回来）。所以三步小字里只说「打开开发者模式」，帮助文档里多一句「别关」。
- 打开扩展页：Chrome 155 **不认命令行里的 `chrome://extensions`**（不管 Chrome 开没开着，都只开一个新标签页），
  网页也打不开 `chrome://`。所以「打开 Chrome 扩展页」= 把 Chrome 叫到前面开好新标签页 + 把地址复制好，请人粘贴回车。
