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

type Workspace = {
  id: string; schema_version: 1
  kind: 'personal' | 'shared'                    // shared = 部门 / 公司
  name: string; tz: string; base_currency: string
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

### 4.3 完成后

- 源工作区 `status: joined`（数据归档只读，可回看）；**成员的个人运行容器继续存在**，新的个人事件写入本人的个人工作区（与已归档的旧工作区分离）；对共享数据的访问经目标 runtime 的 API 以本人身份进行
- 部门 → 公司：部门工作区变成公司的一个 `department` range，原 owner 变 manager

### 4.4 退出

- 人离开：Membership.left_at；个人渠道与个人技能随人；工作区内客户、知识、事件留下；其 Assignment 走交接（05 handover）
- 明示：Join 确认页固定一段"加入后哪些留下、哪些带走"，签字记事件

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
