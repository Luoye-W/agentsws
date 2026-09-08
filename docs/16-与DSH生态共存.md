# 与 DeepSeek Harness 生态共存

| | |
|---|---|
| 日期 | 2026-09-08 |
| 起因 | Luoye：dsh 官方演示有几种"模式"（极简、代码……），我们算一种模式吗？用户想装社区插件（如 PPT 生成）会不会和我们冲突？不放弃 dsh 庞大的插件社区，怎么有机结合？定位不变：跨境电商中控 |
| 核实（09-08） | dsh `SAFETY.md` 原话：experimental developer-preview、未经安全审计、不得视为 production-ready；"Sandboxing, approval prompts, and permission controls can reduce risk, but they do not guarantee isolation"；"Do not rely on DeepSeek Harness as the sole security control for untrusted workloads"。即：dsh 有针对**模型生成代码 / 命令**的沙箱与审批机制，但**插件仍是进程内加载**（SAFETY 明列"load third-party plugins"为风险源）。我们的结论不变且更严：dsh 不是安全边界，安全边界在交易控制模块与 OpenConnector 的 token 策略；公司端 v1 无第三方代码 |
| 前提 | 侦察报告 §1：dsh"一切皆插件"，插件经 `ctx.tools.register / skills / slots / systemPrompt.section` 注册；`tools/pre-execute` / `post-execute` 对**所有**工具生效；插件无沙箱；`dsh plugin add` 是 pnpm 转发无审核；preset = 一目录一 `agent.cordis.yml`，同进程多组合；`ctx.tools.restrict` 按 preset 限工具集 |
| 说明 | dsh 官方"模式"的确切名字以当前版本文档为准；下面按它的机制（profile / bundle / preset）来讲 |

---

## 1. 我们是什么："模式"在 dsh 里叫 profile 和 preset

dsh 的"模式"不是开关，是**组合**：

| dsh 机制 | 是什么 | 我们对应的东西 |
|---|---|---|
| bundle | 一组打包好的插件（如 `bundle/headless`、`bundle/web-app`） | 我们用两个：个人端用 web-app（原生 UI），公司端用 headless |
| profile | 一份 `package.json` 里 `dsh.profile.bundles` + `cordis.patch.yml`：装哪些包、锁什么版本、打什么补丁 | **`profiles/agentsws`**——这就是"我们这种模式"的技术实体 |
| preset | 一个目录一个 `agent.cordis.yml`，同一进程里多套差异化的 Agent 组合（工具集、skill、人设） | **每个职责一个 preset**（04 文档的 18 个职责 + 通用） |
| permission preset | 工具权限模板 | 我们的 role-read / role-apply 与 `tools.restrict` |

所以答案是：**我们不是 dsh 的一个"模式"，我们是一个 profile（发行版）加一组 preset（职责）。** 用户机器上可以同时有官方 profile 和我们的 profile，各自一个 `DSH_HOME`，互不影响（02 文档的 `~/.agentsws/` 就是我们的那份；`agentsws doctor` 检查不串）。

两个 profile：

| profile | 跑在哪 | 组成 | 社区插件 |
|---|---|---|---|
| `agentsws-personal` | 个人电脑；**界面用我们的工作台**（09-08 定，dsh 原生 UI 只作开发者调试面） | headless bundle + 门禁插件 + 个人渠道适配器 | 可装（§3 纪律生效；**不得持有共享工作区 token**） |
| `agentsws-executor` | 公司实例，headless，每次运行一进程 | headless bundle + 门禁插件（pre/post-execute、answerer、systemPrompt）+ 职责 preset | **v1 不装任何第三方代码**（31 §3.5）；verified 档在隔离验证后再开 |

---

## 2. 冲突在哪：五个具体点

| 冲突点 | 会发生什么 | 我们的处理 |
|---|---|---|
| 工具名撞名 | 社区插件注册的工具与我们的同名 | 我们的工具全带前缀 `aws_`；preset 的 allowlist 按全名；撞名在市场审核里就查出来 |
| 系统提示词分节 | 插件往 systemPrompt 加自己的段，变长、可能与人设矛盾 | 我们的 `deployment:persona` 是最后一段且遮蔽默认；插件段照常记事件日志（Model-visible ⟺ logged 让它可见可查）；公司端 preset 可 `systemPrompt` 白名单 |
| 工具集膨胀 | 插件一装十几个工具，模型分心、token 上涨 | **preset 的 `tools.restrict` 是默认拒绝**：社区工具只有列进某个职责的 allowlist 才对该职责可见 |
| 绕过我们的写门禁 | 社区插件的工具自己拿凭据直接发邮件、直接改店铺——不经 stage / 审批 | 这是唯一真正危险的点，见 §3 |
| 版本漂移 | 插件对着别的 dsh 版本写，我们锁的版本不一致 | 市场兼容矩阵（§4）；上游哨兵也盯我们包装过的插件 |

好消息：**`tools/pre-execute` 和 `post-execute` 对所有工具生效，不分谁注册的。** 社区工具调用照样过我们的 provenance、fencing、日志。冲突不在"能不能被管住"，只在"它自己有没有绕开 Backend 去写外部系统"。

---

## 3. 共存纪律：按副作用分类，不按来源分类

给每个社区工具打一个**副作用类别**（市场审核时标，未标的按最严处理）：

| 类别 | 例子 | 个人端 | 公司端 |
|---|---|---|---|
| `local` 本地生成 / 本地读 | PPT 生成、图表、文档转换、代码分析、本地文件读 | 允许 | 允许；产物经 post-execute 自动登记进素材库 |
| `read_external` 只读外部 | 搜索、抓网页、查天气、读公开 API | 允许 | 允许（受职责 allowlist 与预算） |
| `write_external` 写外部 | 发邮件、发帖、改店铺、传文件到网盘 | 允许但记事件并提示 | **默认 block**；要用就包成 `staged_action`（走审批）或改用 OpenConnector 的同名 Action |
| `credential` 自持凭据 | 插件自己存 API key | 允许（用户自己的） | **不允许**：凭据只在 OpenConnector 里 |
| `ui` 插槽 / 界面 | 聊天流卡片、侧栏、设置页 | 允许（原生 UI） | 无效（公司端无 dsh UI；工作台不渲染 dsh 插槽） |

PPT 生成那个例子：它是 `local`，设计职责的 allowlist 加上它就能用，产物进素材库；它要是想"直接上传到 Google Slides"，那一步是 `write_external`，公司端 block，用户看到的提示是"已生成 PPT，上传到 Google Drive 需要经审批"——然后 Agent 提一条 `staged_action(googledrive.upload)`。

判定副作用的办法：审核时静态看插件依赖（有没有 http 客户端、有没有读凭据）+ 在沙盒 dsh 里跑一遍工具并观察出网（模拟回路的合成 provider 能记录一切出站调用）。判定不了的按 `write_external` 处理。

---

## 4. 市场里的 dsh 插件：修正 11 文档的规则

11 §2.1 写的是"`dsh-plugin` 只有 official 能发"。改成三档：

| 档 | 谁发 | 审核 | 个人端 | 公司端 |
|---|---|---|---|---|
| official | 我们 | 内部 | ✅ | ✅ |
| verified | 社区插件，经我们审核并**包装**（wrapper package：引用上游 npm 包 + 锁版本 + 工具副作用分类 + 允许的职责 + 签名） | 自动（沙盒加载、撞名、出网观察）+ 人工 | ✅ | ✅（按分类与 allowlist） |
| community | 未审核的任何 dsh 插件 | 无 | ✅（`dsh plugin add` 照常，市场只做索引与一键装） | ❌ |

包装包（wrapper）是关键：**它不改插件代码**，只加一层元数据——这样社区作者不用为我们做任何事，我们也不用 fork。上游插件升级时，上游哨兵在沙盒里重跑分类，通过就更新 wrapper 版本。

兼容矩阵：市场卡片显示"与 agentsws profile x.y（dsh 0.1.z）兼容"，来源是沙盒加载测试，不是作者自述。

---

## 5. 反过来：把我们的东西给 dsh 社区

共存不只是"他们的进我们"，也是"我们的出去"：

| 我们的 | 以什么形式进 dsh 生态 |
|---|---|
| 门禁插件（provenance / fencing / guardrail 的 pre/post-execute） | 独立发布为 dsh 插件 `dsh-guardrails`：任何 dsh 用户都能装，不带我们的业务 |
| 知识库 MCP、Connect 的 MCP | 标准 MCP，任何 dsh / Claude Code 都能接 |
| 职责 preset | 发布为 dsh preset 包：用官方 dsh 也能"一个客服职责"跑起来（没有审批总线时降级为 fail-closed 人审） |
| 渠道适配器 | 贡献到 dsh-channels |
| 技能 | Agent Skills 格式，dsh / Claude Code / teamai 通吃 |

这就是"奔着中控去，但不放弃社区"的具体形态：**中控是我们的 profile，零件按 dsh 的规矩发布**。社区用我们的零件，我们用社区的零件，双方都不 fork 对方。

---

## 6. 对既有文档的改动

- 11 §2.1：`dsh-plugin` 改为三档（§4）；新增 wrapper 包形态
- 05 schema：`SkillRef` 旁加 `ToolRef { plugin, tool, side_effect }`，职责的 allowlist 可引用社区工具
- 08 §2.3：`write_external` 类社区工具在公司端的出路 = `staged_action`
- 09 契约 #6 运行协议：RunRequest 的 `preset` 字段包含"启用的插件列表"，模拟替身里有"假社区插件"（注册一个 local 工具和一个 write_external 工具，断言后者被 block）
- 10 上游哨兵：`upstreams.yml` 加 `kind: wrapped-plugin`

## 7. 待拍板（09-08 定案：全部按建议）

1. 社区插件三档如上；community 档在公司端一律不可装
2. 门禁插件独立发布为 `dsh-guardrails`（对生态的贡献，也是引流）
3. 工具副作用分类的默认：判定不了按 `write_external`
