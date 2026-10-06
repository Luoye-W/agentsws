# WP242 第二个品牌调不通 Agents 工坊接口的模型（fetch failed）+ 首次设置第 ② / ③ 步的几处体验（Windows 真机）

worktree `../agentsws-wt/wp242-brandmodel` · 分支 `wp/242-brandmodel`（从 main 新起，含 WP240 / WP241）。先读 `_common.md`、WP66（每品牌一套连接与模型设置、「跟随公司默认」、**每品牌各一把云令牌**）、WP240 报告、`apps/server/src/cloud-account.ts`、模型网关 agentsws 云 provider（`packages/model-gateway`，`/v1/ai/chat/completions`）、`apps/server/src/onboarding-suggest.ts`、网站分析（brand-intake，经云抓取那条）、`apps/desktop/src/server-process.ts`（子进程环境白名单 / 代理变量）。

## 现象（Fable 10-06 Windows 真机 ci.9；已有品牌 INMO 昨晚用「Agents 工坊接口」跑通过真模型调研）
在第二个品牌 **Rollout**（WP240 修好后进了自己的首次设置，第 ① 步显示「已接上（跟随公司）」）里：
1. 第 ③ 步「帮我推荐」三次（14:24 / 14:26 / 重启应用后 14:29）都是 `model.provider_down {"message":"request to https://cloud.agentsws.com/v1/ai/chat/completions failed: fetch failed","model":{"model":"deepseek-flash","provider":"agentsws","region":"cn"}}` → 退回关键词匹配。
2. 第 ② 步网站分析（经云抓取）一直「已经读了 0 页」——可能同源（云调用失败），也可能是 Shopify 对脚本访问回 429（从 Windows / Mac 直接 curl 店铺都 429，见第 4 条）。
3. 同一台机器上，SSH 会话里用捆绑的 node.exe 直接 `fetch('https://cloud.agentsws.com/v1/cloud/health')` 200、POST `/v1/ai/chat/completions`（无令牌）401——网络通。机器走 Clash TUN（DNS 198.18.x 假 IP），系统代理 127.0.0.1:7897（WinINET），用户环境变量里没有 *_PROXY。
**Fable 的怀疑（请先在本机复现）**：第二个品牌「跟随公司默认」时，云 provider 用的是**这个品牌自己的云令牌 / 关联**（WP66 每品牌一把），而 Rollout 没有（公司关联只在启动品牌上），于是请求构造异常（空令牌 / 空 base / 抛错被包成 fetch failed）。本机复现路径：起一个工作区 → 关联云账号（用云替身）→ 加第二个品牌 → 在第二个品牌里调用模型（首次设置推荐 / 随便聊）。
4. 第 ② 步 UX：分析卡在 0 页时只给「先跳过，手动填品牌资料」，点了只说「品牌资料之后在设置里填」——**没有就地填的表单，也不能换个网址重读**；读到 429 / 被拦没有说出来。

## 要做
1. 复现并修好第二个品牌的云模型调用：「跟随公司」时用公司（或启动品牌）那把关联 / 令牌，或在加品牌 / 进向导时为它签一把；云余额是公司钱包，扣费照旧按品牌记账（核对 WP206 成员额度、WP224 不受影响）。`model.provider_down` 的错误要带上真实原因（cause.code / 401 / 无令牌），不要只有 fetch failed。端到端测试：两品牌都用 Agents 工坊接口调模型成功。
2. 网站分析：云抓取失败 / 429 / 被 Shopify 机器人保护拦 → 当场说人话（「这个网站拦了自动读取（429）」）+ 「换个网址再读」输入框 + 就地手动填品牌资料的小表单（品牌名、一句话、客服邮箱、币种、市场——与设置页同一个 ProfileForm 子集），不再只甩一句「之后去设置里填」。
3. 推荐失败退回关键词时，词表补全常见说法：「独立站 / Shopify / 建站 / 主题」→ 建站类；「社媒」→ 社媒运营；「红人 / 达人 / KOL」→ 红人营销；「广告 / 投放」→ 投放；「客服 / 售前售后」→ 客服（Amazon 客服只在提到 Amazon 时推）；「设计 / 出图」→ 设计。加测试（用本单那句 Rollout 描述做用例）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP242.md`（根因是否如怀疑、要 Luoye 定的事单列）。
