# 身份、工作区与 Join 规范 v1（契约 #1）

| | |
|---|---|
| 日期 | 2026-09-08 |
| 对应 | 03 §1.5 身份 provider、§7.4 生长式设计；05 Assignment；18 §4 连接迁移 |
| 原则 | ① 人的身份全局唯一，不绑工作区 ② 个人 = 成员数 1 的工作区，同一套代码 ③ Join 是唯一的生长原语 ④ 加入即明示退出条款 |

---

## 1. 对象

```ts
type Person = { id: string; email: string; name: string; identities: { provider: 'local' | 'feishu' | 'wecom' | 'dingtalk'; external_id: string }[]; created_at }

type Workspace = {                                // 52 O1 起：一个工作区 = 一个品牌
  id: string; schema_version: 1
  kind: 'personal' | 'shared'                    // shared = 部门 / 公司
  name: string; tz: string; base_currency: string
  org_id?: OrganizationId                        // 52 O1：这个品牌挂在哪个组织（公司）下；见 §7
  brand?: { name: string; logo?: string }        // 52 O1：品牌名默认 = name，迁移时回填
  parent_id?: string                             // 部门工作区 Join 进公司后指向公司；成为其一个 range
  runtime: { mode: 'local' | 'docker' | 'hosted'; endpoint: string }
  owner_id: person_id
  policy: WorkspacePolicy                        // 05 §3
  registries: string[]                           // 允许的应用源（11）
  status: 'active' | 'joined' | 'archived'      // joined = 已并入上级，只读
}

type Membership = { workspace_id; person_id; role: 'owner' | 'manager' | 'member'; ranges: RangeRef[]; joined_at; left_at? }

type RangeRef = { kind: 'store' | 'department' | 'account' | 'market'; id: string }   // 嵌套：department 可有 parent
```

---

## 2. 身份 provider

| provider | 登录 | 通讯录同步 | 卡片投递 |
|---|---|---|---|
| local（v1 基线） | 邮箱 magic link + 可选密码 | — | 邮件 |
| feishu | SSO | 部门 / 人 → Membership.ranges | 飞书卡片 |
| wecom / dingtalk | SSO | 同上 | 各自卡片 |

同一 Person 可绑多个 provider；工作区可要求某 provider（公司策略）。

---

## 3. 鉴权与 token

- 浏览器：一次性启动 token → HttpOnly cookie（照 dsh browser-auth）；托管档标准 session
- API / 插件：工作区级 API key（可撤销，绑 Membership 与范围）；浏览器插件配对 = 一次性配对码换 API key（13 §5）
- 运行时：RunRequest 里的 actor 由协同服务签发短期 token；Connect token 见 18 §1
- 所有 token 绑 `workspace_id`；跨工作区一律显式切换

---

## 4. Join（个人 → 部门，部门 → 公司）

### 4.1 前置

- 目标工作区 `kind: shared`；发起者是源工作区 owner；目标 manager 以上接受
- 源工作区先 `export`（02 文档四区）生成 Join 包；Join = 导入 + 映射确认

### 4.2 映射确认（`join_mapping` 审批项，14）

| 对象 | 规则 | 冲突处理 |
|---|---|---|
| Person | **目标侧重新验证**：email 相同不自动合并；导入的 identities 不信任，须由目标工作区按 issuer + subject 重新 SSO / magic link 验证账户控制权后才关联（09-08 改，评审 A18 导入攻击） | 未验证的保持独立 Person，标"待验证" |
| Role / Assignment | 源职责 → 目标岗位模板里的同 id 职责；不存在的 → 目标 manager 选映射或新建 | 未映射的进"未认领" |
| 客户 / 联系人 / 任务 | 按 email / 域名 / 外部 id 去重合并；owner 保留源创建者；重合 → 双 owner | 字段冲突 → FactCard 双值 |
| 知识 | 全部变 `knowledge_update` 提议（不直接发布）；policy 层不带入 | — |
| 技能 | 个人层保留；想共享走晋升 | — |
| 连接器 | `ownership: workspace` → transferConnection；`person` 留本地 | 目标已有同 service 连接 → 选主 |
| 定时任务 / 流程实例 | 随职责映射转移；无映射的暂停 | — |
| 事件日志 | 打包追加到目标（保留源 workspace_id 字段） | — |
| 应用 | 源已装的应用在目标不存在 → 建议安装（app_install 审批项） | — |
| **品牌（范围组）** | 唯一键 = 名字归一化；键相同 = 合并（公司那份成员取并集、记 `origin`），名字不同但成员重合 ≥ 50% = 相似 → 出对照卡让 owner 选（45 H2，WP50 落地） | 相似**一律给人选**，不自动合；公司没有的新建进公司 |
| **产品线** | 唯一键 = 父范围 + 判据平台 + 判据集合；判据有重叠不相等 = 相似 → 对照卡（45 H2） | 同上；父范围或平台不同 = 两条不相干的线 |
| **店铺 / 平台账号范围** | 唯一键 = 平台 + 归一化 id（Shopify 的 `myshopify` 域名 / 亚马逊的 `卖家id:站点`）。**只有"一样"与"没有"**——域名是身份证，不给"相似"（45 H2） | 公司没有的新建；有一边认不出平台时按原样 id 比 |

上面三行的判定在 `@agentsws/catalog/org-keys`（纯函数），对照在 `join-compare.ts`，
落地在 `apps/server/src/join.ts`。合并之后**公司那份是真源**，个人那份打
`superseded_by` 变成指向它的别名（只读、可回退）——详见 45 H3。

### 4.3 完成后

- 源工作区 `status: joined`（数据归档只读，可回看）；**成员的个人运行容器继续存在**，新的个人事件写入本人的个人工作区（与已归档的旧工作区分离）；对共享数据的访问经目标 runtime 的 API 以本人身份进行
- 部门 → 公司：部门工作区变成公司的一个 `department` range，原 owner 变 manager

### 4.4 退出

- 人离开：Membership.left_at；个人渠道与个人技能随人；工作区内客户、知识、事件留下；其 Assignment 走交接（05 handover）
- 明示：Join 确认页固定一段"加入后哪些留下、哪些带走"，签字记事件
- **并进来的品牌 / 产品线：公司那份留下，别名断开**（45 H3）。他个人工作区里那一份
  的 `superseded_by` 清掉，恢复可编辑；挂在它上面的岗位范围重新展开回自己那份。
  路由是 `POST /v1/join/:id/leave`（WP50 落地）

---

## 5. API

`POST /auth/magic-link`、`POST /auth/sso/{provider}`、`GET /me`、`POST /workspaces`、`POST /workspaces/{id}/upgrade-to-shared`、`POST /workspaces/{id}/memberships`、`POST /join/export`、`POST /join/import`（生成 join_mapping 审批项）、`POST /join/{id}/complete`、`POST /workspaces/{id}/leave`。事件：`person.created`、`workspace.created / upgraded / joined / archived`、`membership.added / removed`、`join.started / mapped / completed`。

**首次设置与同事发现（46，WP51 实现）。** 一个人第一次打开工具时怎么说清"我们公司叫什么"，
以及同一家公司的两个人怎么互相看见、怎么连上——规范在 [46](46-首次设置与同事发现-v1.md)，
路由这一层多出这几条：

| 路由 | 做什么 | 46 |
|---|---|---|
| `GET /v1/onboarding/state` | 要不要走首次设置向导（公司档案没设过 **且** 除所有者外没有分配） | §1 |
| `PUT /v1/workspace/profile` | 写公司档案：全称、可选域名、"让同事找到我"开关 | §1 ① |
| `GET /v1/onboarding/positions` | 向导第 ③ 步的候选：岗位 → 职责，每条带一句"它会干什么" | §1 ③ |
| `POST /v1/onboarding/plan` | 勾选 → 要连的平台 / 要装的技能 / 要建的岗位（只算不写） | §3 I5 |
| `POST /v1/onboarding/apply` | 真建分配（一条职责一条 Assignment） | §3 I6 |
| `GET /v1/discovery/peers` | 局域网上同一家公司的同伴（开关关着时永远是空的） | §2 I2 |
| `GET /v1/discovery/hello` | **公开**：同伴问"你是谁"，只回一个展示名与人数 | §2 I2 |
| `POST /v1/discovery/superseded` | **公开**：同伴说"先批的那一边已经定了" | §2 I3 |
| `GET` / `POST /v1/invites` | 邀请码：8 位人类可读、24h、默认 5 次（owner） | §2 I2 |
| `GET /v1/memberships/requests` | 谁申请过加入这个工作区 | §2 I3 |
| `POST /v1/memberships/requests` | **公开**：贴码或挑一位局域网同伴申请加入 | §2 I3 |
| `POST /v1/memberships/requests/:id/decide` | 同意 / 拒绝（owner）；同意后建成员并交给本文 §4 的 Join | §2 I3 |

事件另加九条：`workspace.profile_set`、`discovery.enabled / disabled / peer_seen`、
`invite.created / redeemed`、`membership.requested / approved / rejected`。

两条与本规范的接口：**`membership` 审批卡通过之后，人就是这个工作区的成员**（本文 §1），
接着该走的是本文 §4 的 Join 导入与映射确认——`membership.approved` 的 payload 带
`next: 'join_import'` 就是那个交接点。**发现阶段不交换任何本文定义的对象**：
没有 Person、没有 Workspace、没有 Membership，只有一串 `sha256(归一化公司名 + '|' + 域名)`。

---

## 6. 一致性用例

1. 个人工作区成员 1：owner=member=同人，SoD 自动关闭
2. 同 email 两个 Person 在 Join 时合并为一
3. 两个源工作区都有客户 a@x.com → 目标一条客户、两个 owner
4. 源 policy 层知识不出现在目标（连提议都没有）
5. Join 后源工作区任何写 API → 409 joined
6. 人离开后 1 秒内其 token 全失效、其 Assignment 进交接
7. 部门 Join 公司后，公司 owner 的范围含该 department；原部门 owner 只是该 range 的 manager
8. 模拟：3 人合成工作区 Join 15 人合成工作区，断言去重数与未认领数
9. 同一个组织下两个品牌工作区：同一个人两边都有岗位，**四个库（分配 / 卡 / 事实卡 /
   店铺连接）各自按 `workspace_id` 切**，站在一边看另一边一条都查不到
   （52 O2；模拟题 `org/two-brands-cannot-see-each-other`）
10. 离职：组织成员写 `left_at`，两个品牌的成员关系、token 与分配一起收（40 E2）

---

## 7. 组织（公司）—— 工作区**上面**那一层（52 O1，WP65）

> 2026-09-15 Luoye 拍板 52 O1–O5：**品牌是顶层**。这一节把它落在本规范里。

### 7.1 一句话

**品牌 = 工作区，公司 = 组织。** 一个品牌一个工作区，连接、知识、职责分配、面板、卡片、
账本全部天然隔离——因为本文 §1 之后所有数据本来就按 `workspace_id` 切，不用再造一层
`brand_id`。公司变成工作区**上面**的一个对象：

```ts
type Organization = {
  id: string
  legal_name: string                              // 46 §1 ①，从工作区档案上提到这里
  domain?: string
  discoverable: boolean                           // 46 §2 的发现开关
  owner_id: person_id
  members: { person_id; role: 'owner' | 'admin' | 'member'; joined_at; left_at? }[]
  cloud_org_id?: string                           // 49 M1 的云侧组织（余额与订阅）
  created_at
}
```

### 7.2 组织级只放三样：人、钱、发现（52 O3）

| 放哪 | 是什么 | 为什么 |
|---|---|---|
| **组织** | 成员名单、云账号与余额、公司名归一化钥匙与发现开关 | 它们本来就是"一家公司一份"的东西：邀请一次进公司，余额一个账户，同事找的是公司不是某个品牌 |
| **品牌（工作区）** | 连接、知识、职责分配、面板、卡片、账本、事项、待办、复盘、模型设置、通知偏好 | 它们本来就按 `workspace_id` 切。隔离不是"加过滤器"得来的，是"根本不在同一个库里"得来的 |

三条边界：

1. **邀请进组织一次，品牌是勾出来的**。人进了公司但一个品牌都还没进，是一个正经的中间态。
2. **离职按组织一次撤全部品牌**（40 E2）：组织成员写 `left_at`（不删行），他在这个组织
   每一个品牌里的成员关系与 token 一起失效，分配由 roles 侧照单撤。
3. **切品牌 = 换一张绑目标工作区的会话 token**，整个工作台重载（52 O2）。
   它不改任何数据，所以**不发内核事件**——`brand.switched` 只是客户端的一次导航。

### 7.3 一次性迁移

每个没有 `org_id` 的工作区在启动时建一个组织（用 46 的公司档案三字段与 owner），
并把 `brand.name` 回填成工作区名；没设过档案的用工作区名占位（不留一个空公司）。
已经挂过的一个字节不动，跑第二遍什么都不做。

**公司级三字段的真源从此是组织**：`WorkspaceProfile.legal_name / domain / discoverable`
留着但已标 `@deprecated`（契约只加不删）——**读一律以组织为准，写的时候两边同步写**。

### 7.4 路由

| 路由 | 做什么 | 52 |
|---|---|---|
| `GET /v1/orgs` | 我在哪几家公司（个人用户 `solo: true`，界面上不显示组织） | O1 |
| `POST /v1/orgs` | 建一家公司（首次设置第 ① 步上半块） | O4 |
| `PATCH /v1/orgs/:id` | 改公司档案：全称 / 域名 / 发现开关 | O3 |
| `GET /v1/orgs/:id/brands` | 品牌一览（只回**本人有成员资格**的品牌） | O2 |
| `POST /v1/orgs/:id/brands` | 加一个品牌 = 建一个新工作区 | O4 |
| `GET` / `POST /v1/orgs/:id/members` | 公司成员；邀请进公司一次 + 勾进哪几个品牌 | O3 |
| `DELETE /v1/orgs/:id/members/:person_id` | 离职：按公司一次撤全部品牌 | O3 / 40 E2 |
| `POST /v1/orgs/:id/brands/:ws/copy-from` | 从某个品牌复制设置（只复制职责分配） | O4 |
| `POST /v1/orgs/:id/brands/:ws/switch` | 切到这个品牌：换一张绑它的会话 token | O2 |

事件另加两条：`organization.created`、`brand.created`（payload 与
`workspace.profile_set` 同一条纪律——只记归一化后的钥匙与有没有域名，全称与品牌名不进日志）。

### 7.5 与 §4 Join 的关系

45 H1 改写之后，**进公司的默认路径不是合并，是"把这个品牌工作区整个挂到组织下"**
（`attachWorkspaceToOrg`，一步，里面的东西一个字节不动）。只有"两个人各自建了同一个品牌"
（唯一键 = 品牌名归一化 + 店铺域名，契约的 `brandKey`）才走本文 §4 的对照合并。
