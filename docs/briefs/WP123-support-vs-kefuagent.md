# WP123（只读调研，不改代码）客服岗对标 KefuAgent：差距清单与融入方案

worktree：`../agentsws-wt/wp123-support-gap`，分支 `wp/123-support-gap`。**这张单只产出文档**：不改任何源码、不跑 tsc / vitest / 模拟（省机器，别的代理正在并行干活），不需要 `pnpm install`。

## 为什么
Luoye：客服岗可以比对着 KefuAgent 开启测试了，**特别是在线聊天**；KefuAgent 后来有大量更新，要想办法**有机地融入**进来（不是照搬一个 SaaS，而是长进 Agents 工坊的岗位 / 职责 / 卡片 / 消息 / 知识 / 技能这套骨架里）。

## 读什么（只读；不读任何 `.env*`；不输出真实客户数据）
- KefuAgent 主仓 `/Users/yeluo/Documents/KefuAgent`：`specs/`（**按编号从新到旧读，重点是 2026-07 之后新增的**）、`docs/`、`src/lib/support/**`、`src/app/**`（后台与租户界面）、在线聊天相关（widget、会话、转人工、离线留言、主动邀请、访客识别、多语言、富消息、评价）、邮箱全流程、知识库与候选审核、影子测试、初稿直发率、边界 / 政策、Amazon 客服、计费科目。`git log --since=2026-07-01 --stat` 看近两个月改了什么。
- 相关仓（存在就读）：`/Users/yeluo/Documents/kefuagent-shopify-app`、`/Users/yeluo/Documents/kefuagent-flutter`。
- 本仓：`docs/48`（移植方案 v2，§4 L1–L6）、`docs/56`（社群管理）、`docs/63`（消息）、`docs/18`、`docs/37`、`docs/36`、`docs/54`；`packages/support-core/**`、`packages/standby/**`（在线值守与公共聊天挂件）、`packages/channels/src/chat/**`、`packages/roles/roles/support/**` 与 `positions/`、`packages/knowledge`、`apps/workstation/src` 里客服相关页面与卡片、`packs/dtc-3c-3p/scenarios/support/**`。

## 产出：`docs/72-客服岗对标KefuAgent-差距与融入方案-v1.md`
1. **功能对照表**（逐条）：KefuAgent 有什么（带它的 spec 编号 / 关键文件路径）｜Agents 工坊现状（有 / 部分 / 无，带文件路径）｜差距说明｜融入到我们骨架的哪一格（哪个职责、哪种卡片排版、消息页、知识、技能层、右栏面板、云端哪一块）｜工作量（S / M / L）｜对内测的重要度（P0 / P1 / P2）。在线聊天单列一大节，拆到：挂件外观与嵌入、访客会话生命周期、AI 自动答与置信度、转人工与接管（对应我们的 takeover 卡）、离线与邮件续聊、主动邀请、商品 / 订单卡片、多语言与逐句翻译、附件与图片理解、评价与复盘、Shopify 应用嵌入、移动端（Flutter）通知与回复、关机后的在线值守（与我们 `packages/standby`、Cloudflare 形态的关系）。
2. **KefuAgent 2026-07 之后的更新清单**：每条一句话 + 我们要不要、怎么融。
3. **不照搬的部分与理由**（它作为 SaaS 才需要、而我们本地优先不需要的；以及反过来我们有而它没有的）。
4. **融入方案**：按「岗位主入口、职责折叠、只有要人拍板的才是卡、消息页统一收件」这几条既有原则，画出客服岗的目标形态（文字版信息架构 + 一条客户对话从进来到结案的全流程）；在线聊天在 Cloudflare Workers 形态下怎么跑（挂件静态资源、访客 WebSocket / SSE、Durable Object 每会话一个、AI 走 `/v1/ai/*` 计费、关机时谁来答、与本地的同步），给出 2–3 个方案并推荐一个，写清取舍。
5. **拆成可派工的 WP 清单**（每张：目标、范围、依赖、验收、S / M / L），按 P0 → P2 排序；P0 控制在 3 张以内。
6. **亲测脚本**：给审核方一份可照着走的客服岗手动测试清单（邮件线 + 在线聊天线），每步写期望结果。

写作要求：中文、白话、表格为主、每个判断带证据路径；遵守通用约定里的「小步输出」（分节写、每节写完就 `git commit -s`）。结束时照常写 `REPORT.md`，并在 `docs/35` 末尾记「WP123 完成，待审」。
