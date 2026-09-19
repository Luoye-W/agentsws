# 交接板：Fable（派活 + 终审）⇄ 实现方（现在是 Proma）

**实现方只要读这一个文件就能开工。** Fable 的额度很紧，所以交接全部走文件，不走对话。

## 你（实现方）怎么干
1. 读 `docs/briefs/_common.md`（通用约定，必须全部遵守；其中「小步输出」那条可忽略）。
2. 在下面「队列」里从上往下找第一条状态是 **待做** 或 **续做** 的，读它的派工单，把状态改成 **进行中**。
3. 在它指定的 worktree / 分支里干活（**续做**的 worktree 已存在，里面最后一个 `wip:` 提交是上一位的半成品，未验证——先 `git merge main`、`pnpm install`、跑 `scripts/verify-changed.sh` 看红在哪，能用的接着用；**待做**的自己建：`git worktree add <目录> -b <分支> main`）。**绝不在主仓目录 `/Users/yeluo/Documents/agentsws` 里改代码、绝不 push、绝不打 tag、绝不部署。**
4. 验证只用 `scripts/verify-changed.sh`（+ 派工单点名的门禁）；全量测试由 Fable 在合并关口跑。
5. 做完：`git merge main` → 在**分支上**写 `docs/briefs/reports/<WP编号>.md`（八节：实现清单 / 自主决定 / 需要 Luoye 定的事 / 测试结果 / 偏离 / 未完成 / 分支与提交 / 截图路径）并提交 → 回到这个文件把状态改成 **待审**（这一处改动直接改主仓的这个文件即可，这是唯一允许碰主仓的地方，改完不用提交）。
6. 接着做下一条。一次只做一条；每条之间不用等 Fable。
7. 拿不准的事：按派工单与 `_common.md` 自己判断，写进报告的「偏离」；真正要 Luoye 拍板的写进「需要 Luoye 定的事」，别停下来等。

## Luoye 怎么用
- 对 Proma 说一句：**「读 `~/Documents/agentsws/docs/briefs/HANDOFF.md`，照它做。」** 之后不用传话。
- Fable 那边有一个后台脚本（`scripts/watch-handoff.sh`，纯 shell、不花额度）每 2 分钟看一次这张表：某条变成 **待审**（或分支上出现了它的报告）就自动开始终审——读报告 → 查改动 → 跑全量 → 合并 → 把状态改成 **已合并** 或 **退回**（退回原因写在这张表下面的「退回」一节，实现方看到后接着改）。
- 只有需要 Luoye 拍板的事，Fable 才会找他。

## 分工（09-19 晚，Luoye 定）
- **Proma：只做完手上的 WP117b 就停**，不要再领新的。
- 其余由 **Qwen Code（百炼 qwen3.8-max）** 做，由 Fable 用 `scripts/qwen-wp.sh` 启动；状态写「进行中（Qwen）」的条目别人不要碰。

## 队列（从上往下做；「依赖」没合并的先跳过）
| 顺序 | WP | 派工单 | worktree（都在 `/Users/yeluo/Documents/agentsws-wt/` 下）· 分支 | 依赖 | 状态 |
|---|---|---|---|---|---|
| 1 | WP117b 红人主线在界面上走通 + 点击级证据 | `docs/66` 末尾「复测」#15–#20 + `WP117-kol-e2e-sandbox.md` | `wp117b-kol-mainline` · `wp/117b-kol-mainline` | — | 续做 |
| 2 | WP121b 初始化向导重排 | `WP121b-onboarding-wizard.md` | `wp121b-wizard` · `wp/121b-wizard` | — | 进行中（Qwen） |
| 3 | WP120 岗位与职责的角色定位 | `WP120-role-personas.md` | `wp120-personas` · `wp/120-personas` | — | 续做（22:00 后由 Qwen 并发） |
| 4 | WP118 红人营销增值服务 + 充值四档（订阅引擎做成通用的，客服增值服务只登记） | `WP118-kol-cloud-service.md` | `wp118-kol-cloud` · `wp/118-kol-cloud` | — | 续做（22:00 后由 Qwen 并发） |
| 5 | WP122 品牌设计规范 DESIGN.md | `WP122-brand-design-md.md` | `wp122-design-md` · `wp/122-design-md` | — | 续做 |
| 6 | WP119b 插件：A 私有仓库移植 + B 开源仓库插件开放接口 | `WP119b-extension-parity.md` | A：`/Users/yeluo/Documents/agentsws-extension`（分支 `wp/119b-port`）；B：`wp119b-open-api` · `wp/119b-open-api` | — | 待做 |
| 7 | WP126 数据接口路由 + 自带数据接口 + 官方接口命中也收费 | `WP126-data-routing-byo-source.md` | `wp126-data-routing` · `wp/126-data-routing` | WP117b 已合并 | 待做 |
| 8 | WP124 在线聊天三条路 | `WP124-live-chat-three-ways.md`（以文件里「修订」一节为准） | `wp124-live-chat` · `wp/124-live-chat` | WP118 已合并 | 待做 |

WP117b 的补充要求（派工单里没有，写在这）：demo 服务的是 `apps/workstation/dist`，测界面前先 `pnpm -F @agentsws/workstation exec vite build`；交付一个真实点击的 playwright 脚本 `scripts/e2e-kol-sandbox.mjs`（playwright 库在 `node_modules/.pnpm/playwright@1.63.0/node_modules/playwright`），走完「选合成红人 → 起草开发信 → 批准发送 → 已发 ≥ 1 → 跳到 N 天后 → 回信 ≥ 1 → 分类 → 议价卡 → 阶段推进 → 交付物 → 追踪链接」，每步截图到 `docs/assets/workstation/kol-e2e-NN.png`，脚本里断言计数确实变了；演练数据从真实漏斗 / 归因里排除，单独显示「演练漏斗」。

## 已合并（供参考）
WP110–116、117、119、121（前半）、123、125。细节见 `docs/35` 末尾。

## 退回（Fable 终审没过的，实现方优先处理这里的）
（暂无）
