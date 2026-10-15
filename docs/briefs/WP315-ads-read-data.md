# WP315 广告看数据：插件点导出 → 入库 → 日报（docs/101 §5.1① / §5.4；决策 560）

worktree `../agentsws-wt/wp315-adsdata` · 分支 `wp/315-adsdata`。先读 `_common.md`、`docs/101-广告管理方案v2-插件与登录态.md`（全文，以文首 Luoye 定为准）、`docs/briefs/reports/WP313.md`（插件动作通道、`packages/browser-action`、下载回报）、`docs/briefs/reports/WP314.md`（`decodeExportBytes` / `parseAdsExport` / `exportEntities`）、`docs/57`、`docs/63`（邮箱）。

## 要做
1. 两家后台「工坊日报」保存报表的建立步骤（L3 告知卡）与每日导出步骤（只点导出、下 CSV，不解析页面数字），走插件动作通道；默认每天一次、本地 9 点后，电脑和 Chrome 开着才跑。
2. 桌面端读下载的文件 → 用 WP314 解析 → 按品牌入库（广告系列 / 广告组 / 广告 / 关键词 / 搜索字词，花费、展示、点击、转化、转化价值、ROAS）；WP314 报表列名对照（619）按真导出格式补全。
3. 日报（投放岗）：花了多少、哪条差、离总闸还有多少、要不要止损（止损建议按 docs/57 出卡）；用 WP331 的通用「发布报告」或现有卡种，不写死格式。
4. 备用：邮箱里的定时报表（docs/63 连接读附件 / 链接），插件不在时用。
5. 缺插件 / 缺连接走 WP324 连接卡。
6. 测试：本地假后台页面 + 手写样例导出文件；不打开真实广告后台。

## 纪律
不读 .env*；不碰 key / token / 账号；**不打开真实广告后台**；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字。不合 main、不打 tag、不发版。测试用 `--maxWorkers=2 --testTimeout=120000`。WP316 并行，别动它的主场。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 插件构建 + 装包前冒烟；报告 `docs/briefs/reports/WP315.md`（决策号 800–804）。
