# WP120 岗位与职责的角色定位（persona）

worktree：`../agentsws-wt/wp120-personas`，分支 `wp/120-personas`。

## 为什么
Luoye 看到亲测记录（docs/66 #1）：让红人营销岗位找红人，回出来的是客服的话。他的判断：「每个职责 / 每个岗位都应该有一个自己的角色定位，照理不会犯这样的错。」查证属实：`packages/contracts/src/roles.ts` 里有 `persona?: string`，但 `packages/roles/roles/**` 四十多条职责**一条都没填**，也**没有任何代码读它**；岗位模板（`packages/roles/positions/*.yml`）连这个字段都没有。Agent 的系统提示里没有「你是谁」。

## 先读
`docs/04`、`docs/27`、`docs/54`（岗位主入口；岗位 / 职责各有上下文与记忆；六层技能 `package → company → department → position → role → personal`）、`docs/17` §1（上下文装配顺序）、`docs/16` §2（dsh preset 的 systemPrompt 白名单）、`docs/36` §9–§10（右栏面板）、`docs/66`；代码 `packages/contracts/src/roles.ts`、`packages/roles/{roles,positions}/**`、`packages/runtime-direct/src/assemble.ts`、`packages/dsh-adapter/src/preset.ts`、`packages/stand-ins/src/runtime/{stub,dev-stub,support}.ts`、`packages/roles/src/route.ts`。
只读参考：`/Users/yeluo/Documents/KOLAgents` 与 `/Users/yeluo/Documents/KefuAgent` 里它们给 Agent 的系统提示（不读 `.env*`），口气与边界可借鉴。

## 定论
1. **两层 persona**：岗位模板加 `persona`（只加字段）；职责用已有的 `persona`。装配顺序：岗位 persona → 职责 persona → 技能索引 → 工具。都是中文写、英文界面有英文版（`{ zh, en }`，兼容旧的纯字符串）。
2. **每段 persona 的固定骨架**（短，每段 ≤ 200 字，不写空话）：你是谁（一句）；你负责什么（3–5 条）；**你不负责什么、遇到了转给哪个岗位**（这是防串岗的关键）；做事顺序与判断口径；口气；哪些事必须出卡让人拍板（与 guardrail 一致，不另起一套）。全部四十多条职责与全部岗位都要写，不许留空；`gen-ontology --check` 加一条校验：persona 为空即失败。
3. **接进三个运行时**：direct（`assemble.ts` 静态前缀的 persona 段）、dsh（preset 的 persona complete 段）、stub。**stub 改成认职责**：按 `role.domain` 选剧本；没有剧本的域回一句人话「这条职责在演示里还没有剧本」并不产生任何卡——绝不再拿客服剧本兜底。（红人域的剧本由 WP117 提供；本单在 main 合入 WP117 之后开工，接它的口。）
4. **用户可见可改**：右栏「记忆 / 技能 / 知识 / 额度」旁加「角色」面板（走 `registerPanelBody`，registry 接口不动）：看到岗位与当前职责的 persona，公司层可改写（存为 company 层覆盖，包里的原文保留可还原），改动记审计。
5. **串岗测试**：`packs/dtc-3c-3p` 加一组场景 + 单测：对每个岗位各发一句典型任务，断言 ① 路由到对的职责；② 产出的卡 / 回复的 `domain` 属于该岗位；③ 钉死几条跨岗位禁语（红人岗位不问退款窗口、客服不起草开发信、投放不改商品价…）。direct / dsh 用替身模型验证 persona 段确实进了系统提示（断言提示文本含岗位名与「不负责」段）。
6. 文档：`docs/69-岗位与职责的角色定位-v1.md`（骨架、写法规范、覆盖层、与 guardrail / 技能六层的关系）；`docs/27` / `docs/54` 同步；`docs/66` #1 改状态。

## 验证
通用项 + `vitest run packages/roles packages/contracts packages/runtime-direct packages/dsh-adapter packages/stand-ins packages/simulation apps/server apps/workstation` + 两个模拟包门禁（场景数变了按惯例重定三运行时基线；persona 进提示会让 token 指标上浮，基线重定并在报告里写明涨了多少）。
