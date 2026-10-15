# WP345 插件随工坊自动更新（不上架商店；Luoye 10-15 定，决策 871）

worktree `../agentsws-wt/wp345-extupdate` · 分支 `wp/345-extupdate`（从 main 拉；收尾前合一次最新 main）。先读 `_common.md`、`apps/extension/wxt.config.ts` 与 `README.md`、`docs/68`、`docs/help/browser-extension*.md`、`apps/desktop`（打包、WP327 版本目录与更新流程、WP337 更新暂停）、插件与本机服务的配对 / 动作通道（WP313、WP328、WP315 / WP316 的动作队列）、`apps/workstation/src/components/settings/browser-card.tsx`、WP324 / WP334 连接卡。

## 方案（Fable 10-15 给 Luoye、已同意）
1. **固定位置**：插件随安装包带上（已构建好的 `chrome-mv3` 目录），工坊首次需要插件时把它放到数据目录下一个固定文件夹（不随 `app-<版本>` 变；Windows `%LOCALAPPDATA%\agentsws\chrome-extension`、Mac `~/Library/Application Support/<现有数据目录名>/chrome-extension`，以现有数据目录约定为准）。
2. **固定身份**：manifest 写固定 `key`，扩展 id 不随路径变；配对、`chrome.storage`、已授予的可选权限都保住。key 的私钥不进仓库（只放公钥那一段即可固定 id），说明写进 README。
3. **首次装（只做一次）**：对话里 / 第三栏出一张连接卡（种类沿用 `extension`）：一句话 + 「打开插件文件夹」「打开 Chrome 扩展页」两个按钮 + 三步小字（开开发者模式 → 加载已解压 → 选这个文件夹）。装上并配对后卡自己收起、接着做（WP324 规则）。帮助文档同步改，不再让人下载 zip。
4. **随工坊更新**：新版工坊起来后比对版本；插件有变化就写到旁边的临时目录、校验完整后整体换掉旧目录（原子替换，失败保留旧版）。然后通过已配对的通道发「新版已到位」，插件在空闲时（动作队列没有正在执行的一步）调 `chrome.runtime.reload()`；Chrome 没开就等下次启动自然读新文件。插件重载后上报新版本号，工坊记一条事件。
5. **插件里**：收到通知 → 等空闲 → reload；面板 / 设置页显示当前版本；版本和工坊对不上且没换成功时，连接卡照实说一句。
6. **不做**：企业策略强制安装、自托管 crx、改系统设置。

## 测试 / 实测
- 单测：原子替换（中途失败保留旧版）、版本比对、空闲判断、重载后上报。
- 真 Chromium 端到端（`scripts/` 新脚本，参照 `e2e-ads-*.mjs`）：加载已解压 → 配对 → 工坊写入新版文件 → 通知 → 插件重载 → 版本号变了、配对还在、`chrome.storage` 还在、之前已授的可选权限还在、动作队列没丢。
- 要实测并写进报告的两点：新版 manifest 多要一条权限时重载会不会弹窗 / 被停用；开发者模式插件在当前稳定版 Chrome 启动时会不会弹「停用开发者模式扩展」提示（Mac 本机 + Windows CI 能测多少测多少，测不了写明）。
- Windows CI 加一段：beta 老版 → 新版更新后插件目录被换掉、版本对。

## 纪律
不读 .env*；不碰 key / token（扩展私钥除外的公钥可以进仓）；不调付费接口；不连远程机器；不碰本机 4317；不改用户系统设置 / 浏览器策略；不跑批量清理；不用 pkill。界面少字。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`；验证日志写独立文件。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 插件构建 + 模拟三包 + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP345.md`（决策号 873–877）。
