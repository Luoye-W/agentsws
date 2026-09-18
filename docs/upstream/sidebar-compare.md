# 官方侧边栏 ↔ 我们的第三栏（只读对照）

| | |
|---|---|
| 日期 | 2026-09-18 |
| 起因 | WP93 把 dsh 升到 `0.1.6-alpha.2`。这一版的 release notes 里**新增功能六条有五条是右侧边栏**（插件管理页、回合末文件改动卡 + 逐文件对比审阅、Office 预览、浏览器模式、Subagent 会话、提交计划预览）。它们全在官方 web 客户端里（`@deepseek-ai/dsh-client-ui-*`），**升级本身一个字都不碰它们**——我们的第三栏是自己的 React 轨（`apps/workstation/src/components/rail/*`），不引任何 `dsh-client-*`（docs/34「唯一 import dsh 处」）。 |
| 这份文档是什么 | **只读比较**。看完官方怎么做的，对着 docs/36 §9 的第三栏逐条标"借形 / 不借 / 待定"。**不写实现、不排期**——要做哪条由 Luoye 定，定了再开 WP。 |
| 出处 | 上游 `dsh-v0.1.6-alpha.2` tag 的源码，逐条落到具体 README 的具体小节（见每条的「出处」）。不是抄 release notes。 |

---

## 1. 官方那一侧是怎么做的

### 1.1 三层：kit / host / tab type

官方把侧边栏**拆成三层**，这是整件事里最值得先看清的一点：

| 层 | 包 | 负责什么 | 知不知道"这是 dsh" |
|---|---|---|---|
| 布局引擎 | `dsh-client-ui-dockkit` | 分屏树 + 标签页面板、可逆操作（`LayoutOp`）、拖拽手势、浮动面板 | **不知道**。README 第一句：「The Harness Web client is its first embedder; nothing in here knows that」 |
| 宿主 | `dsh-client-ui-sidebar-right` | 产品文案、`kind` 的含义、新窗格默认开哪个页、挂在哪、别的插件怎么够得着（`ctx.sidebarRight` / `ctx.sidebarRightTabs`） | 知道 |
| 面板 | `ui-sidebar-files` / `-terminal` / `-documentpreview` / `-browser`、`ui-plan`、`ui-subagent`、`ui-deliverables` | 一个 tab type 一个包 | 各自只知道自己 |

**一句话：布局是通用的，"这是哪个产品"只在中间那一层。** 面板作者既不碰布局算法，也不碰产品文案。

> 出处：`packages/client/ui-dockkit/README.md` Summary；`packages/client/ui-sidebar-right/README.md`
> §"What lives here, and what does not"。

### 1.2 slot 注册：两段式，面板是"类型 + 身体"

一个面板进侧边栏要注册两次，两次都在自己的 `ctx.effect` 里（插件卸载即注销）：

1. **类型**：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide? })`
   —— 纯静态声明，返回一个 disposer。
   - `id` 是**实现的身份**（惯例写包名），全局唯一，重复注册直接抛。
   - `patterns` 是 `dsh-resource://` 地址上的 glob（`dsh-resource://file/**`、`*.md`）。**没有 `patterns` 的就是"页"**（指南页、文件树），只能按 `kind` 打开。
   - `guide` 声明它要在指南页上占哪个入口格。
2. **身体**：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`，
   组件里用框架注入的 `useTabInfo()` 读 `{ sidebar, panel, tab }`。

**谁来开某个资源**按"编辑器解析器"那套排序：先按 `priority` 分档
（`extension` > `builtin` > `fallback`），再按命中的 pattern 长度，再按注册顺序；
`canOpen(address)` 能一票否决。同一个 `kind` 最多一个 `builtin` + 一个 `extension`，
extension 在场时压过 builtin，它走了 builtin 自动回来。

**内置的指南页走的是和第三方一模一样的公开路**（README 点名 `ui-sidebar-documentpreview`
是活证据）——这是一条纪律，不是巧合：官方自己不许走后门。

> 出处：`ui-sidebar-right/README.md` §"Extension seats"。

### 1.3 布局持久化：一个会话一份，存 localStorage，**重启后内容自己找回来**

- 一个 session id 一份 `SurfaceState`：布局树、操作序列、已经发过多少个 id。
- 每个动作都是同一个形状：**铸 id → 问 kit 的 planner 要一串操作 → 记下来 → 把整个 surface 赋回去**。
  没有任何动作就地改布局——所以"算布局"这件事永远只有 kit 的纯函数在做。
- 铸号计数器**放进 surface 里**，所以记下来的操作序列是可重放的：从同一个初始状态重放
  一定得到同一棵树。展开、收起、切换全屏也都记一条。
- 落盘：`localStorage` 的 `dsh.sidebar-right.v1.<sessionId>`，存布局 / tab 身份 / 选中 /
  分屏比例 / 浮动矩形 / 呈现方式 / 计数器。**刷新时先恢复布局再渲染 tab 身体**；
  换会话各管各的。
- **"内容"不存**：导航参数、资源内容、活连接一律不存。刷新后由各面板**拿着留下来的
  tab 身份与资源地址自己把内容找回来**（终端的重连就是这么做的）。
- `sidebarRight.openTabs` 发布所有已打开 tab 的稳定元数据；启动时只读布局的 key，
  **不挂载休眠内容、不钉住文件、不激活 Agent**。
- 存坏了只清这一个会话的 key；存不进去就只在内存里活着，界面照用。

> 出处：`ui-sidebar-right/README.md` §"State"。

### 1.4 面板与会话的绑定

- `rightbar` 是 **root 作用域**的控制器，只在"对话"被选中时才挂 session 作用域的
  `rightbar.session` 子树。切到全局页面时侧边栏隐藏、让出布局轨，**但不删这个会话的 tab 状态**。
- 没有会话就没有按钮、没有面板。
- 收起时对话**一点代价都不付**：没有轨、没有宽度，正文的滚动条仍然贴着列边。
  展开靠的是对话头右角那一个按钮（`conversation.session.header.corner`）。
- 两种呈现（`push` 挤开正文 / `fullscreen` 盖住视口）**共用同一棵内容树**，切换不重挂 tab；
  < 768px 打开自动全屏。

### 1.5 四条新功能各自怎么落的

| 功能 | 谁做的 | 关键机制 |
|---|---|---|
| **回合末文件改动卡 + 逐文件对比审阅** | 宿主侧 `dsh-workspace-changes` 记账，客户端 `ui-deliverables` 画卡 | 回合开始 / 结束各对工作树做一次 **git 快照**（私有 index + 临时对象目录，仓库的 index / objects / worktree / refs 一个都不动），`diff-tree -r -M --numstat` 出每文件增删行数；git 盖不到的（被 ignore 的、仓库外的）用"文件工具改之前 + 回合末各抄一份整文件"补。会话一销毁，摘要与快照全没了 |
| **Office 预览** | `ui-sidebar-documentpreview` + 宿主 `dsh-office-to-pdf` | Word / Excel / PPT **本地转 PDF**（`@deepseek-ai/libreoffice-kit`，平台包里是整套 LibreOffice，本机那个 259 MB），再交给 PDF 渲染器。渲染器按文件类型注册进同一个元数据注册表，tab 自己管加载 / 状态 / 换渲染器 / 换行 / 重载 |
| **浏览器面板** | `ui-sidebar-browser` | 一个 tab 一个独立浏览会话，载体是 **iframe + 应用自己管的历史**（Web 与 Desktop 同一套）；README 明写"never injects Electron or Node access into visited content" |
| **Subagent 会话 / 提交计划预览** | `ui-subagent` / `ui-plan` | 都是"把一个已经存在的领域对象开成一个 tab"：子代理会话树（跑没跑完、token 用量、当前回合时长；一次性的开成只读执行记录）、`/plan` 提交的计划（批 / 拒 / 撤之后仍然能从回合末的成果区再打开，重开是聚焦已有 tab 而不是再开一个） |

---

## 2. 我们这一侧现在是什么（docs/36 §9 / §9.1）

- 44px 图标轨，默认收起；**一次只开一个**面板，宽 380（拖 320–520）；`]` 切换；< 1200 变抽屉。
- 上下文永远按**当前岗位 / 当前事项 / 当前卡片**取（`rail-scope.ts` 纯函数）——
  这一条是我们和官方最大的不同：官方绑的是 **session**，我们绑的是**岗位**（docs/54）。
- 图标轨十一个分三组；WP71 真做了的是中间四个：**记忆 / 技能 / 知识 / 额度**。
  上面四个（数据面板 / 运行中 / 定时任务 / 证据）与下面两个（浏览器 / 文件）是占位——
  点了照实说"还没做"，不给空面板。**问 AI** 是把已有的 `ask-ai-panel` 搬进来的。
- 开合态与宽度记在本机。

---

## 3. 逐条对照

标注口径：**借形** = 这个做法值得照着做一遍（不抄代码）；**不借** = 形与我们的模型冲突，或者代价明显大于收益；**待定** = 值得做但前置还没到，或者要 Luoye 先定一件事。

### 3.1 结构与机制

| # | 官方的做法 | 我们现在 | 判断 | 理由 |
|---|---|---|---|---|
| 1 | **布局 kit 与产品分层**（dockkit 不知道 dsh） | `rail-*` 五个组件里布局与产品文案是混在一起的 | **不借** | 我们一次只开一个面板、不分屏、不浮动——分屏树那套引擎对"一次一个"是纯负担。分层的收益要等真出现分屏需求 |
| 2 | **两段式 slot 注册**（类型声明 + 身体组件，各带 disposer） | 面板是写死在图标轨数组里的 | **借形** | 这是"第三方面板"与"面板生命周期"的前提。我们迟早要让应用包（docs/23）往第三栏塞面板，那时没有注册表就只能改核心代码 |
| 3 | **`priority` 三档 + pattern 长度 + 注册顺序**决定谁开某个资源，`canOpen` 一票否决 | 没有"按资源地址开面板"这回事 | **待定** | 要等 #7（证据面板按对象地址开）真做了才有意义。先记着这套排序规则，别自己发明一套 |
| 4 | **内置面板走与第三方一模一样的公开路** | — | **借形** | 纪律，不是功能。一旦有了 #2，这条要一起立：官方自己不走后门，我们也不许 |
| 5 | **布局持久化：存结构不存内容**，刷新后各面板拿 tab 身份 + 资源地址自己找回来 | 只存"开没开 + 宽度" | **借形** | 我们的面板只要多一个"打开哪个对象"（哪条记忆、哪个事项的证据）就立刻需要这条。**"不存内容"这一句是重点**——存了内容就等于在 localStorage 里放业务数据，和 31 §3「数据留本地但有主」对不上 |
| 6 | **启动时只读布局的 key，不挂载休眠内容、不激活 Agent** | — | **借形** | 同上，而且这条更硬：恢复布局**不许**顺手把上次那个 Run 又跑起来 |
| 7 | **操作可重放**（铸号计数器进状态、每个动作记一条、纯函数算布局） | — | **不借** | 这是给撤销 / 重做与分屏用的。一次只开一个面板没有可撤销的布局操作 |
| 8 | **面板绑 session**：切到全局页隐藏但不删这个会话的 tab 状态 | 面板绑**岗位 / 职责**（`rail-scope.ts`） | **不借**（形不一样，但那条"切走不删状态"要留） | docs/54 定了岗位是任务主入口。我们该照着做的是**那条语义**：从岗位 A 切到 B 再切回来，A 的面板状态还在 |
| 9 | **收起时零代价**（没有轨、没有宽度） | 我们收起是 44px 图标轨（一直在） | **不借** | 官方是"藏起来，用对话头角上一个按钮请回来"；我们的图标轨本身就是导航——十一个面板要是没有轨，人就不知道有什么可开。这是有意的不同 |
| 10 | **两种呈现共用一棵内容树**（push / fullscreen 切换不重挂） | 只有 push；< 1200 变抽屉 | **待定** | 全屏审阅（见 #11）真做了才需要。真做时这一条是硬要求——重挂等于把人正在看的 diff 滚回顶部 |

### 3.2 面板本身

| # | 官方的面板 | 我们对应的东西 | 判断 | 理由 |
|---|---|---|---|---|
| 11 | **文件改动逐文件审阅**（回合末改动卡 → 侧栏逐文件对比） | 我们的 **staged change 卡**（docs/15 变更账本；WP89 的主题副本改动现在只落成 `publish_theme` 一张卡） | **借形**（形借，体不借） | "回合结束给一张卡，点进去逐文件看改了什么"这个**形**正是建站职责最缺的一块：现在人只看得见"要不要发布"，看不见"这一轮到底改了哪几个 liquid 的哪几行"。**体不借**的三条实测理由见 §4 |
| 12 | **浏览器面板**（一 tab 一会话、iframe + 应用管历史） | WP82 的 playwright-mcp / WP92 的 BrowserSkill 会话，现在**只在事件流里看得见** | **借形** | docs/36 §9 的"自动弹"第三条（连接器要人接管浏览器）本来就要这个面板。官方那条"never injects Electron or Node access into visited content"要原样立成我们的红线 |
| 13 | **Office 预览**（本地转 PDF 再渲染） | 知识库上传的 Word / Excel（docs/19 知识对象） | **待定** | 形是对的：知识库里一份 Word，人现在只能下载下来看。但**体一定不借**——`libreoffice-kit` 的平台包本机就 259 MB，WP93 已经把它按 16 §3 最严解释 `ignoredOptionalDependencies` 掉了。真要做得先定用什么转（服务端转一次存起来？只渲染我们已经抽好的文本？），这是一个要 Luoye 拍的选择，不是实现细节 |
| 14 | **终端面板**（选一个已装的 shell、收起后命令继续跑、关 tab 才杀进程） | 无 | **不借** | 官方这条明写"用系统用户权限跑，不受 Agent 沙箱限制"。我们整条建站职责的价值就在那个只写得了主题副本目录的笼子里（WP89）。给人一个绕开笼子的终端，等于把 WP89 做的事拆掉 |
| 15 | **Subagent 会话开成 tab** | 我们的"运行中"面板（docs/36 §9 占位） | **借形** | 那三个字段值得直接拿：跑没跑完、token 用量、当前回合时长。"一次性的开成只读执行记录"这条也对——跑完的 Run 不该还能追问 |
| 16 | **提交计划预览**（`/plan` 的计划开成 tab，批 / 拒之后还能从回合末成果区再打开，重开是聚焦已有 tab） | 我们的审批项（docs/14）现在在中栏 | **待定** | "重开是聚焦已有 tab 而不是再开一个"这条细节值得记住。但审批项在中栏还是右栏是一个 IA 决定（docs/36 §9 明写"右栏里不放聊天流"），要 Luoye 定 |
| 17 | **插件管理页**（侧栏装 / 卸 / 开关插件，实时生效） | 无；我们的应用包是 docs/23 | **不借** | 见 UPGRADE.md 第三节 §6 第 2 条：它是"以宿主用户身份跑 pnpm 装任意包，装完的代码在沿进程里跑、在工作区沙箱之外"。与 16 §3 / 31 §3 正面冲突 |
| 18 | **工作区列表按目录层级分组** | 我们左栏是品牌 / 岗位（docs/52 / §54） | **不借** | 他们的工作区是目录，我们的是品牌。形一样、意思完全不同 |

---

## 4. #11 为什么"借形不借体"（三条实测理由）

`dsh-workspace-changes` 的做法很干净，但直接拿来盖我们的 staged change 卡有三个硬伤：

1. **存活期对不上。** 摘要与快照"活到 Session 销毁为止"，README 原话：
   「A conversation reopened after a Host restart therefore has no card, and no comparison,
   for its earlier turns」。而我们一次运行一棵树、结束即 dispose（17 §5.1），
   等于卡片在生成的那一刻就已经没有明天了。变更账本（docs/15）要的是**能回看、能追责**的持久记录。
2. **它要 git，而我们的笼子里不一定有。** 没有仓库或没有 git 时它只列"文件工具改的那些"，
   **shell 改的一概不记**（README：「Changes made only through shell commands outside the
   snapshot coverage are not recorded」）。WP89 的主题改动恰恰**全是 shell**（`shopify theme …`）——
   落到"没仓库"那一档就是一条都记不下来。
3. **它挂在 `turn/start` / `agent/turn-stopping` 上，并且每个 `tools/pre-execute` 都要等它的队列。**
   我们的 `tools/pre-execute` 是五道门禁的那一条（17 §4），在它前面插一个 git 队列，
   等于把每次工具调用的延迟绑到 `git add --all` 上。要借这个形，**记账那一侧得是我们自己的**
   （沙箱执行器本来就知道每条命令改了哪个目录），不是挂上游这个插件。

**能直接借的是它的三条设计约束**（这三条写下来比代码值钱）：
- 快照走**私有 index + 临时对象目录**，仓库的 index / objects / worktree / refs 一个都不动；
- git 走 `subprocess` 能力、环境清洗过、`GIT_CONFIG_COUNT=0` / `GIT_TERMINAL_PROMPT=0` /
  `GIT_OPTIONAL_LOCKS=0`、带超时、输出有界；
- 行对比有超时（`diffTimeoutMs`，默认 100ms），超了就**降级成"整文件替换"一个 hunk 并标 `coarse`**，
  而不是把界面卡住。

---

## 5. 一句话结论

官方这一版把右栏做成了**一个可扩展的 tab 宿主**，我们的第三栏是**一条跟着岗位走的面板轨**——
两者的骨架不该互抄（#1 / #7 / #8 / #9 都是"不借"）。真正值钱的是**四条机制**（#2 注册表、
#5 存结构不存内容、#6 启动不激活、#4 内置不走后门）和**三个面板的形**（#11 文件改动逐文件审阅、
#12 浏览器、#15 运行中的三个字段）。

**#11 是这里面唯一一条"现在就缺、而且缺得明显"的**：建站职责跑完一轮，人看得见"要不要发布"，
看不见"改了哪几行"。
