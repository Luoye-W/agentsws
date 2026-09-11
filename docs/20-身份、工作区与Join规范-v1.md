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
