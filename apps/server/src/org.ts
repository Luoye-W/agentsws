/**
 * 制度面的装配（WP28 交付 A / B）：把 05 的职责 / 岗位 / 分配 / 策略层与 20 的成员、邀请
 * 装成 `@agentsws/api` 的 `OrgPort`。网关那一层只做路由与权限，业务全在这里（28 §2）。
 *
 * 四条纪律：
 *
 * 1. **改职责模板与改策略层不直接生效**（14 §1 `policy_change`、§13.3「只有 owner 可决」）：
 *    这两件事只建一张卡 + 记一条待办的变更；批准之后才落库。落库发生在**下一次读**
 *    （每个端口方法先 `reconcile()` 一遍）——不需要往审批总线里插钩子，
 *    也就不会与 WP27 的调度、txn 的执行器抢同一个口子。
 * 2. **岗位不落在分配上**：Assignment 里没有 position_id（05 §2「岗位只在分配那一刻展开」）。
 *    所以"谁在做这个岗位" = 谁名下有这个岗位默认包里的全部职责，算出来的，不是存出来的。
 *    好处是撤销一条分配，岗位持有关系自动就没了，不会留下对不上的映射。
 * 3. **撤销即失效**：撤销分配走 `roles.assignments.revoke`（策略行同步摘掉）；
 *    移出成员再加一步 `identity.leaveWorkspace`（该人在本工作区的 token 立刻全废）。
 * 4. **token 不进日志**：邀请的明文 token 只出现在返回给 owner 的那一个链接里，
 *    事件日志与库里都只有它的 sha256。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  AcceptedInvitationView,
  AssignInput,
  AssignmentView,
  CopyRoleInput,
  InvitationView,
  InviteInput,
  LocalIdentityService,
  MemberView,
  OrgActor,
  OrgChangeReceipt,
  OrgDuplicateQuery,
  OrgPort,
  PolicyPatchInput,
  PositionInput,
  PositionView,
  ProductLineInput,
  ProductLineView,
  RangeGroupView,
  RoleDetailView,
  RolePatchInput,
  RoleSummaryView,
  UpdateAssignInput,
  WorkspacePolicyView,
} from '@agentsws/api'
import {
  deriveStoreRanges,
  findOrgSimilar,
  type OrgCandidate,
  type OrgExisting,
  platformOfRange,
} from '@agentsws/catalog'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  EventEnvelope,
  Level,
  Mandate,
  Person,
  PersonId,
  Position,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeRef,
  RoleId,
  WorkspaceId,
  WorkspacePolicy,
} from '@agentsws/contracts'
import { B2B_POSITION_ID, B2B_ROLES } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import {
  bundledPositionIcon,
  parseRole,
  type RangeExpanded,
  ROLE_ID_SPLITS,
  type RoleDefinitionFull,
  RoleError,
  type RoleStore,
  shopifyLineQuery,
} from '@agentsws/roles'
import type BetterSqlite3 from 'better-sqlite3'
import {
  belongsTo,
  createMemoryPlacements,
  createSqlitePlacements,
  holdersByPlacement,
  type PlacementStore,
  WORKSPACE_BASE_ROLES,
} from './position-placements.js'

/** 岗位模板的存储形状（契约 `Position` + 从哪来）。 */
interface StoredPosition extends Position {
  source: 'bundled' | 'custom'
}

/** 一条等审批的制度变更。 */
interface PendingChange {
  id: string
  approval_id: string
  /** 45 H5 加了 `range_group` / `product_line`：成员改不了组织结构，只能提议。 */
  kind: 'role' | 'policy' | 'range_group' | 'product_line'
  /**
   * kind=role 时是改完的整份职责定义；kind=policy 时是改完的整份策略层；
   * 两种范围对象时是一条 {@link PendingRangeChange}（只带真正要改的那几格）。
   */
  doc: string
  status: 'pending' | 'applied' | 'dropped'
}

/** 45 H5：一条批了才落地的「改品牌 / 改产品线」。 */
interface PendingRangeChange {
  /** 落在**真源**那一条上（提议时给的可能是被取代的那份别名）。 */
  id: string
  name?: string
  members?: RangeRef[]
  parent?: RangeRef
  rule?: ProductLineRule
}

interface OrgBackend {
  positions(): StoredPosition[]
  putPosition(p: StoredPosition): void
  deletePosition(id: string): void
  customRoles(): string[]
  putCustomRole(id: string, json: string): void
  pending(): PendingChange[]
  putPending(row: PendingChange): void
  /** WP234（docs/54 §6.1）：安放——一条分配归哪个岗位。 */
  placements: PlacementStore
  close(): void
}

function createMemoryBackend(): OrgBackend {
  const positions = new Map<string, StoredPosition>()
  const roles = new Map<string, string>()
  const pending = new Map<string, PendingChange>()
  return {
    placements: createMemoryPlacements(),
    positions: () => [...positions.values()].map((p) => structuredClone(p)),
    putPosition: (p) => {
      positions.set(p.id, structuredClone(p))
    },
    deletePosition: (id) => {
      positions.delete(id)
    },
    customRoles: () => [...roles.values()],
    putCustomRole: (id, json) => {
      roles.set(id, json)
    },
    pending: () => [...pending.values()].map((p) => ({ ...p })),
    putPending: (row) => {
      pending.set(row.id, { ...row })
    },
    close: () => {
      positions.clear()
      roles.clear()
      pending.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS org_positions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS org_roles (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS org_pending (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc TEXT NOT NULL,
  status TEXT NOT NULL
);
`

function createSqliteBackend(dbPath: string): OrgBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const upsert = (table: string) =>
    db.prepare(
      `INSERT INTO ${table} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    )
  const putPositionStmt = upsert('org_positions')
  const putRoleStmt = upsert('org_roles')
  const putPendingStmt = db.prepare(
    `INSERT INTO org_pending (id, approval_id, kind, doc, status) VALUES (@id,@approval_id,@kind,@doc,@status)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc = excluded.doc`,
  )
  return {
    placements: createSqlitePlacements(db as never),
    positions: () =>
      (db.prepare('SELECT json FROM org_positions ORDER BY id').all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as StoredPosition,
      ),
    putPosition: (p) => {
      putPositionStmt.run(p.id, JSON.stringify(p))
    },
    deletePosition: (id) => {
      db.prepare('DELETE FROM org_positions WHERE id = ?').run(id)
    },
    customRoles: () =>
      (db.prepare('SELECT json FROM org_roles ORDER BY id').all() as { json: string }[]).map(
        (r) => r.json,
      ),
    putCustomRole: (id, json) => {
      putRoleStmt.run(id, json)
    },
    pending: () => db.prepare('SELECT * FROM org_pending ORDER BY id').all() as PendingChange[],
    putPending: (row) => {
      putPendingStmt.run(row)
    },
    close: () => {
      db.close()
    },
  }
}

/** WP196：最高那个岗位（id `owner`）的默认名。 */
export const OWNER_POSITION_NAME = { zh: '负责人', en: 'Lead' } as const

/**
 * WP196：这个岗位以前出厂时叫过的名字。库里还是这几个之一 = 用户没改过，启动时换成新默认名；
 * 不在表里的（CEO、海外业务总监……）一律是用户自己起的，不动。中英各判各的。
 */
const OWNER_POSITION_OLD_NAMES = {
  zh: ['店主 / 负责人', '店主/负责人', '店主'],
  en: ['Owner', 'Shop Owner', 'Store Owner'],
} as const

/**
 * WP196：老工作区迁移——把「负责人」岗位上还停在旧出厂名的中文 / 英文名换成新默认名。
 *
 * 只看 id `owner` 这一个岗位、只换**逐字等于旧出厂名**的那一半；用户改过的名字一律不动。
 * 纯函数、可重复跑（跑第二遍什么都不变），改了返回新的那份，没改返回 `undefined`。
 */
export function migrateOwnerPositionName<
  T extends { id: string; name: { zh: string; en: string } },
>(position: T): T | undefined {
  if (position.id !== 'owner') return undefined
  const zhOld = (OWNER_POSITION_OLD_NAMES.zh as readonly string[]).includes(position.name.zh.trim())
  const enOld = (OWNER_POSITION_OLD_NAMES.en as readonly string[]).includes(position.name.en.trim())
  if (!zhOld && !enOld) return undefined
  return {
    ...position,
    name: {
      zh: zhOld ? OWNER_POSITION_NAME.zh : position.name.zh,
      en: enOld ? OWNER_POSITION_NAME.en : position.name.en,
    },
  }
}

/**
 * 首批岗位（27 §1 三人包那三行）。只保留"职责定义真的在这台机器上"的那些条目：
 * 默认包里一个职责都不剩的岗位不种——界面上出现一个点不动的卡片比没有它更糟。
 */
const SEED_POSITIONS: readonly {
  id: string
  zh: string
  en: string
  roles: [RoleId, boolean][]
}[] = [
  // WP196（Luoye 09-29）：最高那个岗位默认叫「负责人」（Lead）——不一定是 CEO，也可能是
  // 管海外业务的那位；用户在公司页可以自己改（CEO、海外业务总监……）。id 仍是 `owner`。
  {
    id: 'owner',
    zh: OWNER_POSITION_NAME.zh,
    en: OWNER_POSITION_NAME.en,
    roles: [
      ['common.owner', true],
      ['dtc.analytics', true],
    ],
  },
  // WP54（48 v2 L1 / 27 §1）+ WP72（56 §4）：**客服**岗位 = 四条职责，默认全勾。
  // 只做独立站的人去勾掉 Amazon 那条；还没上聊天 widget 的去勾掉在线客服那条。
  // 第四条「社群管理」（`dtc.community-support`）也默认勾上：群与私信里的客户问题
  // 不需要先有一个群才会发生——评论区与私信本来就有（56 §4）。
  // （`roles.roles.get` 解析不到的职责会在上面那一步被筛掉，所以装了几条就显示几条。）
  {
    id: 'customer-care',
    zh: '客服',
    en: 'Customer Care',
    roles: [
      ['dtc.support', true],
      ['dtc.live-chat', true],
      ['amz.support', true],
      ['dtc.community-support', true],
      ['common.member', false],
    ],
  },
  // WP62 / WP63 / WP64（51 §2 / 27 §1）：**网站运营**岗位，51 §2 定的四条职责齐了：
  // 店铺管理（`dtc.store`，旧 `dtc.ops` 迁过来的那一份）、内容与博客、邮件营销、订单履约。
  //
  // 默认全勾：一个人开店的时候这四件事本来就是他一个人做；分工是后来的事，
  // 界面上去勾比想起来该加一条容易。
  {
    id: 'web-ops',
    zh: '网站运营',
    en: 'Web Operations',
    roles: [
      ['dtc.store', true],
      ['dtc.content', true],
      ['dtc.email-marketing', true],
      ['dtc.fulfillment', true],
      ['common.member', false],
    ],
  },
  // WP67（48 §5.1 / 54）：**红人营销**岗位 = 五条渠道职责，
  // 默认只勾 YouTube 与 Instagram（48 §5.1：这两条占 KOLAgents 80% 用量）。
  // 其余三条在向导里勾得上——勾上一条比去掉一条容易（去掉之前他得先弄明白那条是干什么的）。
  {
    id: 'kol-marketing',
    zh: '红人营销',
    en: 'Creator Marketing',
    roles: [
      ['kol.youtube', true],
      ['kol.instagram', true],
      ['kol.tiktok', false],
      ['kol.facebook', false],
      ['kol.x', false],
      ['common.member', false],
    ],
  },
  // WP72（56 §2 / 54）：**社媒运营**岗位 = 九条渠道职责（内容组四条在前、社群组
  // 五条在后，顺序 = 契约 `SOCIAL_CHANNELS`）。默认只勾 Meta / TikTok / YouTube
  // （56 §6）：多数品牌一开始一个群都没有，先把内容发起来才是第一步。
  // 其余六条在向导里勾得上——勾上一条比去掉一条容易。
  {
    id: 'social-media',
    zh: '社媒运营',
    en: 'Social Media',
    // WP191（docs/86 §5 / §6，Luoye 09-29）：`social.meta` 拆成 FB 主页 + IG，不再出现在新建岗位里；
    // 另加 Threads 与 LinkedIn。顺序 = 契约 `ACTIVE_SOCIAL_CHANNELS`；默认勾 FB / IG / TikTok / YouTube。
    roles: [
      ['social.tiktok', true],
      ['social.x', false],
      ['social.youtube', true],
      ['social.facebook', true],
      ['social.instagram', true],
      ['social.threads', false],
      ['social.linkedin', false],
      ['social.facebook-group', false],
      ['social.reddit', false],
      ['social.discord', false],
      ['social.telegram-group', false],
      ['social.whatsapp', false],
      ['common.member', false],
    ],
  },
  // WP78（60 §1 / 54）：**公共关系**岗位 = 四条职责（顺序 = Luoye 09-17 手写
  // 那句话的顺序，也是契约 `PR_ROLES`）。**默认全勾**：公关这四件事在一家小公司
  // 里本来就是一个人做的一天——写稿的人顺手盯舆情，盯舆情的人顺手去 Reddit
  // 答一句。与社媒那九条只勾三条的差别是真实的：多数品牌一开始一个群都没有，
  // 而"外面有人说我们"从第一天就在发生。
  {
    id: 'pr',
    zh: '公共关系',
    en: 'Public Relations',
    roles: [
      ['pr.press', true],
      ['pr.reddit', true],
      ['pr.forums', true],
      ['pr.monitoring', true],
      ['common.member', false],
    ],
  },
  // WP75（57 §1 / 54）：**投放**岗位 = 四条平台职责（顺序 = 契约 `ADS_PLATFORMS`）。
  // 默认只勾 Meta / Google（57 §5）：不是"用得多"，是**只有这两条今天真连得上**
  // ——X 还在申请制、TikTok 要 Business Center 授权，勾上去就是两条永远显示
  // "还没接"的职责。批下来那天在向导里勾一下就有了。
  {
    id: 'ads',
    zh: '投放',
    en: 'Paid Ads',
    roles: [
      ['ads.meta', true],
      ['ads.google', true],
      ['ads.x', false],
      ['ads.tiktok', false],
      ['common.member', false],
    ],
  },
  // WP77（59 §1 / 54）：**建站**岗位 = 四条职责（Luoye 09-17 手写那一行）。
  // 顺序 = 一家新店真实的先后：先骨架、再壳、再那几封自动发的信、最后插件。
  // **默认全勾**——一个人开店的时候这四件事本来就是他一个人做；分工是后来的事，
  // 界面上去勾比想起来该加一条容易（与网站运营那条同一条理由）。
  {
    id: 'site',
    zh: '建站',
    en: 'Site Building',
    roles: [
      ['site.shopify-build', true],
      ['site.shopify-theme', true],
      ['site.shopify-email', true],
      ['site.shopify-apps', true],
      ['common.member', false],
    ],
  },
  // WP76（58 §1 / 54）：**设计**岗位 = 五条按用途拆的职责（独立站 / Amazon /
  // 社媒 / 广告 / 展会，顺序 = 契约 `DESIGN_DUTIES`）。**默认全勾**（58 §5）：
  // 与社媒 / 红人相反——那两个岗位的每一条对应一个真账号，这五条不对应任何
  // 账号，一个人做设计，这五样他本来就都会碰到。
  {
    id: 'design',
    zh: '设计',
    en: 'Design',
    roles: [
      ['design.dtc', true],
      ['design.amazon', true],
      ['design.social', true],
      ['design.ads', true],
      ['design.exhibition', true],
      ['common.member', false],
    ],
  },
  // WP171（docs/84 §11 / 54）：**B2B** 岗位 = 五条职责（顺序 = 契约 `B2B_ROLES`）。
  // 前四条默认全勾（小公司是一个业务员把这几摊都干了）；B2B 平台运营是第二批，默认不勾。
  // 默认勾不勾**读契约那一份**，不在这里再抄一遍。
  {
    id: B2B_POSITION_ID,
    zh: 'B2B',
    en: 'B2B',
    roles: [
      ...B2B_ROLES.map((r): [RoleId, boolean] => [r.role_id, r.default]),
      ['common.member', false],
    ],
  },
  { id: 'member', zh: '普通成员', en: 'Member', roles: [['common.member', true]] },
]

export interface OrgOptions {
  clock: Clock
  identity: LocalIdentityService
  roles: RoleStore
  approvals: ApprovalBus
  workspace_id: WorkspaceId
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 给了就落盘（`org.sqlite`）；不给就纯内存。 */
  dbDir?: string
  /** 邀请链接的前缀；缺省是相对路径（同源打开工作台就能用）。 */
  baseUrl?: string
  /** WP138：当前品牌的名字（「选范围」里「整个品牌」那一项显示它）；不给就说「整个品牌」。 */
  brandName?: () => string
  /**
   * WP174：上级离职时要去哪几个工作区把他手上的卡改派给老板（品牌各一个工作区，
   * 审批总线是同一条）。不给就只看本工作区。
   */
  workspaceIds?: () => WorkspaceId[] | Promise<WorkspaceId[]>
  /**
   * WP182：一个人离开工作区（被移出 / 走完离职编排）之后调——B2B 业务员的客户、商机、没回的询盘
   * 出一张交接卡给老板。出错不拦移出本身（交接卡可以事后再出，人已经走了）。
   */
  afterMemberLeft?: (person_id: PersonId, by: PersonId) => Promise<unknown>
  /**
   * WP234（docs/54 §6.4）：岗位合并 / 移动之后，事项与岗位层记忆跟着走。
   * 事项在各品牌的工作模型里、记忆在学习回路里，制度层够不着，所以由装配方给。
   * 不给就只动制度层（岗位行 + 安放），事项与记忆原地不动。
   */
  reshape?: PositionReshapeHooks
}

/** WP234：岗位合并 / 移动时制度层以外要跟着走的两样。 */
export interface PositionReshapeHooks {
  /** `position_template_id === from` 的事项改到 `to`；给了 `role_id` 只动走那条职责的。回改了几件。 */
  retargetMatters(input: { from: string; to: string; role_id?: RoleId }): number | Promise<number>
  /** 岗位层记忆 A 并进 B（docs/54 §6.4：没有的搬、一样的留一份、不一样的两版都留）。 */
  mergeMemory(input: {
    from: string
    into: string
    from_name: string
  }): Promise<{ moved: number; kept_both: number }>
}

/** WP234：一次合并 / 移动 / 拆出的回执。 */
export interface PositionReshapeResult {
  /** 动过的岗位（合并后被删的那个不在里面）。 */
  positions: PositionView[]
  /** 改了安放的分配条数。 */
  moved_assignments: number
  /** 跟着改了岗位的事项件数。 */
  moved_matters: number
  /** 合并时：岗位层记忆搬了几条、两版都留的几条。 */
  memory?: { moved: number; kept_both: number }
  /** 合并后被删掉的自建岗位。 */
  deleted?: string
}

export interface OrgAssembly {
  port: OrgPort
  /**
   * 岗位模板本身（27）。WP51 的首次设置向导要拿它列"你做什么"，
   * 而 `port.positions` 回的是**带持有人**的视图、还要一个 OrgActor——
   * 向导那一步只需要模板，不该为了读一张表先编一个 actor 出来。
   */
  positions(): Position[]
  /**
   * 44 G5：把它接到 `createRoleStore({ onRangeExpanded })` 上——品牌成员一变，
   * 挂它的岗位范围跟着变，这里记事件 + 给 owner 发一张 L3 卡。
   *
   * 为什么不直接在 `updateRangeGroup` 里做：职责层是唯一知道"哪几条分配受影响、
   * 各自多了少了什么"的地方，在这边重算一遍等于把同一条规则写两份。
   */
  onRangeExpanded(e: RangeExpanded): void
  /**
   * WP174：有人离开工作区（移出成员 / 离职编排）之后调一次。他是哪几个岗位的上级，
   * 那几个岗位的上级就清空（落回老板）、提醒老板重设，他手上还没批的「转上级」的卡改派给老板。
   * 回清掉了哪几个岗位。
   */
  onMemberLeft(person_id: PersonId, by?: PersonId): Promise<string[]>
  /**
   * WP234（docs/54 §6.1）：这条分配安放在哪个岗位（安放的岗位已经不在了 = 没安放）。
   * 岗位面（`positions.ts`）按它算「我的岗位」与起 Run 的岗位层。
   */
  placementOf(assignment_id: string): string | undefined
  /**
   * WP234（docs/54 §6.2）：首次设置第 ③ 步的一行岗位清单落成一个岗位行——
   * 带 `template_id` 且职责全在那个模板里就复用它（名字不同就改名），否则新建一个自建岗位。
   * 回岗位 id。
   */
  ensurePosition(
    input: { name: string; role_ids: RoleId[]; template_id?: string },
    by: PersonId,
  ): string
  /** WP234：把一条分配安放到一个岗位（首次设置建完分配之后调）。 */
  place(assignment_id: string, position_id: string): void
  /** WP234：类别目录（随软件带的岗位模板，按出厂的样子；不含「负责人」与底座职责）。 */
  catalog(): Position[]
  /** WP234：岗位合并 / 移动 / 拆出（与端口上那三个同一份实现，测试与模拟直接调）。 */
  reshape: {
    merge(by: PersonId, from: string, into: string): Promise<PositionReshapeResult>
    moveDuty(
      by: PersonId,
      from: string,
      role_id: RoleId,
      to: string,
    ): Promise<PositionReshapeResult>
    split(
      by: PersonId,
      from: string,
      input: { name: string; role_ids: RoleId[] },
    ): Promise<PositionReshapeResult>
  }
  close(): void
}

const ORG_ERROR = (code: 'not_found' | 'conflict' | 'invalid_input' | 'forbidden', msg: string) =>
  new RoleError(code, msg)

/**
 * 45 H5「提议修改」那句理由的最短长度。与 40 §5 E4 的"仍新建"同一个口径：
 * 一句话说不清的改动不该走这条路，owner 是照这句话点头的。
 */
export const MIN_PROPOSAL_REASON = 8

const APPROVED = new Set(['approved', 'approved_edited', 'auto_approved', 'applying', 'applied'])
const DEAD = new Set(['rejected', 'withdrawn', 'expired', 'superseded', 'blocked'])

/** 决定里选的是"维持现状"（deck 给 policy_change 生成的第二个选项）。 */
function keptAsIs(item: ApprovalItem): boolean {
  const edited = item.decision?.edited_payload
  if (edited === null || typeof edited !== 'object') return false
  return (edited as { selected_option_id?: unknown }).selected_option_id === 'before'
}

const capText = (value: Mandate['caps'][string]): string =>
  Array.isArray(value) ? value.join('、') : String(value)

export function createOrg(options: OrgOptions): OrgAssembly {
  const { clock, identity, roles, approvals, workspace_id, appendEvent } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'org.sqlite'))

  // 自定义职责在进程起来时就要挂回注册表，否则重启之后已分配的人解析不到定义
  const custom = new Set<RoleId>()
  for (const json of backend.customRoles()) {
    const role = parseRole(json, 'org:custom')
    roles.roles.register(role)
    custom.add(role.id)
  }

  // 首批岗位：库里空的时候种一次；之后用户怎么改就是怎么样
  if (backend.positions().length === 0) {
    for (const seed of SEED_POSITIONS) {
      const kept = seed.roles.filter(([id]) => roles.roles.get(id) !== undefined)
      if (!kept.some(([, isDefault]) => isDefault)) continue
      backend.putPosition({
        id: seed.id,
        version: '1.0.0',
        name: { zh: seed.zh, en: seed.en },
        roles: kept.map(([role, isDefault]) => ({ role, default: isDefault })),
        source: 'bundled',
      })
    }
  }
  // WP196：老工作区里「负责人」岗位还叫旧出厂名的，换成新默认名（用户改过的不动；可重复跑）
  for (const p of backend.positions()) {
    const renamed = migrateOwnerPositionName(p)
    if (renamed !== undefined) backend.putPosition(renamed)
  }

  const now = (): string => clock.now()
  const roleName = (id: RoleId): string => roles.roles.get(id)?.name.zh ?? id
  const positionOf = (id: string): StoredPosition | undefined =>
    backend.positions().find((p) => p.id === id)

  const activeAssignments = (person_id?: PersonId): Assignment[] => {
    const all = person_id === undefined ? [] : roles.assignments.listByPerson(person_id, {})
    return all.filter((a) => a.workspace_id === workspace_id && a.revoked_at === undefined)
  }

  const emit = (type: string, actor: PersonId, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: 'org' },
      payload,
    })
  }

  // ── 等审批的制度变更 ───────────────────────────────────────────────

  const applyPending = (row: PendingChange): void => {
    if (row.kind === 'role') {
      const role = parseRole(row.doc, 'org:approved-role')
      backend.putCustomRole(role.id, row.doc)
      roles.roles.register(role)
      custom.add(role.id)
      emit('policy_change.applied', 'system', { target: 'role', role_id: role.id })
      return
    }
    // 45 H5：批准之后，成员提的那条改动才真的落到公司那份上
    if (row.kind === 'range_group' || row.kind === 'product_line') {
      const change = JSON.parse(row.doc) as PendingRangeChange
      if (row.kind === 'range_group') {
        roles.rangeGroups.update(change.id, {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.members === undefined ? {} : { members: change.members }),
        })
        emit('range_group.updated', 'system', {
          range_group_id: change.id,
          from_proposal: true,
          ...(change.name === undefined ? {} : { name: change.name }),
        })
      } else {
        roles.productLines.update(change.id, {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.parent === undefined ? {} : { parent: change.parent }),
          ...(change.rule === undefined ? {} : { rule: change.rule }),
        })
        emit('product_line.updated', 'system', {
          product_line_id: change.id,
          from_proposal: true,
          ...(change.name === undefined ? {} : { name: change.name }),
        })
      }
      emit('policy_change.applied', 'system', { target: row.kind, object_id: change.id })
      return
    }
    const policy = JSON.parse(row.doc) as WorkspacePolicy
    roles.policies.set(policy)
    emit('policy_change.applied', 'system', { target: 'workspace_policy' })
  }

  /**
   * 把已经有结论的卡落地。**每个端口方法开头都跑一遍**——制度变更不多，
   * 一次几条 `approvals.get` 便宜过在审批总线上另开一个订阅口。
   */
  const reconcile = async (): Promise<void> => {
    for (const row of backend.pending()) {
      if (row.status !== 'pending') continue
      const item = await approvals.get(row.approval_id)
      if (item === undefined) continue
      if (APPROVED.has(item.state)) {
        // 36 §2.2：policy_change 是选择题卡，"维持现状"也是一次批准——
        // 状态同样是 approved_edited，得看他选的是哪一个（选 before 就是不改）
        if (keptAsIs(item)) backend.putPending({ ...row, status: 'dropped' })
        else {
          applyPending(row)
          backend.putPending({ ...row, status: 'applied' })
        }
      } else if (DEAD.has(item.state)) {
        backend.putPending({ ...row, status: 'dropped' })
      }
    }
  }

  const propose = async (
    actor: OrgActor,
    input: {
      kind: PendingChange['kind']
      doc: string
      title: string
      summary: string
      target: 'role' | 'workspace_policy' | 'range_group' | 'product_line'
      before: unknown
      after: unknown
      affected: string[]
    },
  ): Promise<OrgChangeReceipt> => {
    const workspace = await identity.getWorkspace(workspace_id)
    const owner = workspace?.owner_id ?? actor.person_id
    const fingerprint = sha256(canonicalJson({ kind: input.kind, doc: input.doc })).slice(0, 12)
    const item = (await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'policy', id: `${input.target}:${fingerprint}` } },
      dedupe_key: `${workspace_id}:policy_change:${input.target}:${fingerprint}`,
      title: input.title,
      summary: input.summary,
      payload: {
        target: input.target,
        before: input.before,
        after: input.after,
        affected_assignments: input.affected,
      },
      evidence: {
        source_events: [],
        diff: { before: input.before, after: input.after, summary: input.summary },
        provenance: { seen: [] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'person', id: actor.person_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        // 14 §13.3：policy_change 只有 owner 可决，范围管理者不可
        recipients: [{ person: owner, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })) as ApprovalItem
    if (item.state === 'blocked') throw ORG_ERROR('conflict', `这条改动没过预检：${item.summary}`)
    backend.putPending({
      id: `pnd_${fingerprint}`,
      approval_id: item.id,
      kind: input.kind,
      doc: input.doc,
      status: 'pending',
    })
    emit('policy_change.proposed', actor.person_id, {
      target: input.target,
      approval_item_id: item.id,
    })
    return {
      status: 'pending_approval',
      approval_item_id: item.id,
      summary: input.summary,
    }
  }

  // ── 视图拼装 ───────────────────────────────────────────────────────

  const summaryOf = (role: RoleDefinitionFull): RoleSummaryView => ({
    id: role.id,
    name: role.name.zh,
    name_en: role.name.en,
    description: role.description,
    domain: role.domain,
    version: role.version,
    source: custom.has(role.id) ? 'custom' : 'bundled',
    editable: custom.has(role.id),
    holders: roles.assignments.listByRole(role.id, { workspace_id }).length,
    home_blocks: role.home_blocks.map((b) => ({
      id: b.id,
      placement: b.placement,
      component: b.component,
    })),
    actions: role.actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      target: a.target,
      route_to: typeof a.route_to === 'string' ? a.route_to : `role:${a.route_to.role}`,
      review_cannot_be_disabled: a.review_cannot_be_disabled ?? false,
      caps: Object.entries(a.mandate.caps).map(([key, value]) => ({
        key,
        value: capText(value),
      })),
      ...(a.mandate.window === undefined
        ? {}
        : { window: { max_count: a.mandate.window.max_count, per: a.mandate.window.per } }),
    })),
    automation: Object.entries(role.automation).map(([action_id, spec]) => ({
      action_id,
      ceiling: spec.ceiling,
      initial: spec.initial,
      hard_ceiling: spec.hard_ceiling ?? false,
    })),
    connectors: role.connectors.map((c) => ({ kind: c.kind, required: c.required })),
    // WP202：拆过的老职责带上接手的那几条（勾选里据此不再列它）
    ...(ROLE_ID_SPLITS[role.id] === undefined
      ? {}
      : { superseded_by: [...(ROLE_ID_SPLITS[role.id] ?? [])] }),
  })

  const detailOf = (role: RoleDefinitionFull): RoleDetailView => ({
    ...summaryOf(role),
    scopes: role.scopes.map((s) => ({
      domain: s.domain,
      ops: [...s.ops],
      range: s.range,
      max_sensitivity: s.max_sensitivity,
    })),
    skills: role.skills.map((s) => ({ name: s.name, tier: s.tier, load: s.load })),
  })

  const personName = async (id: PersonId): Promise<string> =>
    (await identity.getPerson(id))?.name ?? id

  const viewOf = async (a: Assignment): Promise<AssignmentView> => {
    const role = roles.roles.get(a.role_id)
    const needsRanges = role?.scopes.some((s) => s.range === 'assigned') ?? false
    return {
      assignment_id: a.id,
      person_id: a.person_id,
      person_name: await personName(a.person_id),
      role_id: a.role_id,
      role_name: roleName(a.role_id),
      role_version: a.role_version,
      ranges: [...a.ranges],
      ...(a.range_groups === undefined || a.range_groups.length === 0
        ? {}
        : { range_groups: [...a.range_groups] }),
      granted_at: a.granted_at,
      ...(a.revoked_at === undefined ? {} : { revoked_at: a.revoked_at }),
      unassigned_range: needsRanges && a.ranges.length === 0,
    }
  }

  // ── 44 品牌与产品线的视图 ─────────────────────────────────────────

  const rangeGroupView = (g: RangeGroup, alias_of?: string): RangeGroupView => ({
    id: g.id,
    name: g.name,
    members: [...g.members],
    created_at: g.created_at,
    updated_at: g.updated_at,
    holders: roles.rangeGroups.assignments(g.id).length,
    // 45 H3：被取代的那一份只能看——改的是公司那条
    ...(g.superseded_by === undefined ? {} : { superseded_by: g.superseded_by, readonly: true }),
    ...(g.origin === undefined ? {} : { origin: { ...g.origin } }),
    ...(alias_of === undefined || alias_of === g.id ? {} : { alias_of }),
  })

  const productLineView = (l: ProductLine, alias_of?: string): ProductLineView => ({
    id: l.id,
    name: l.name,
    parent: { ...l.parent },
    rule: structuredClone(l.rule),
    created_at: l.created_at,
    updated_at: l.updated_at,
    holders: roles.productLines.assignments(l.id).length,
    ...(l.superseded_by === undefined ? {} : { superseded_by: l.superseded_by, readonly: true }),
    ...(l.origin === undefined ? {} : { origin: { ...l.origin } }),
    ...(alias_of === undefined || alias_of === l.id ? {} : { alias_of }),
    // 19 §3：这条判据交得出 `query:` 吗（界面上说"上游先切一刀"还是"拉回来本地切"）
    pushdown: shopifyLineQuery(l.rule) !== undefined,
  })

  /** zod 解出来的可选键带着 `undefined`，契约类型不收——存之前把它们去掉。 */
  const cleanRule = (rule: ProductLineInput['rule']): ProductLineRule => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rule)) if (v !== undefined) out[k] = v
    return out as unknown as ProductLineRule
  }

  /**
   * 44 G5：品牌成员变了 → 挂它的岗位范围自动跟上，**但要留痕**。
   *
   * 两件事：一条 `assignment.range_expanded` 事件（40 §1 数据归属的底线），
   * 加一张给 owner 的卡。卡按 **L3** 提（14：默认放行、只通知），因为品牌就是
   * 为了少一遍挨个改——真要拦，owner 在卡上驳回再去改岗位。
   */
  const onRangeExpanded = (e: RangeExpanded): void => {
    emit('assignment.range_expanded', 'system', {
      assignment_id: e.assignment_id,
      person_id: e.person_id,
      role_id: e.role_id,
      range_group: e.range_group,
      added: e.added,
      removed: e.removed,
    })
    pendingExpanded.push(e)
    void flushExpanded()
  }

  /** 攒一拍再发卡：一次改品牌常常影响好几个岗位，人只该看到一张卡。 */
  const pendingExpanded: RangeExpanded[] = []
  let flushing: Promise<void> | undefined
  const flushExpanded = async (): Promise<void> => {
    if (flushing !== undefined) return flushing
    flushing = (async () => {
      // 让同一次 `rangeGroups.update` 里的全部回调先落完，再攒成一张卡
      await Promise.resolve()
      const batch = pendingExpanded.splice(0)
      if (batch.length === 0) return
      const first = batch[0]
      if (first === undefined) return
      const workspace = await identity.getWorkspace(workspace_id)
      const owner = workspace?.owner_id
      if (owner === undefined) return
      const added = batch.flatMap((e) => e.added)
      const removed = batch.flatMap((e) => e.removed)
      const what =
        added.length > 0
          ? `新增了 ${[...new Set(added.map((r) => r.id))].join('、')}`
          : `去掉了 ${[...new Set(removed.map((r) => r.id))].join('、')}`
      const summary = `「${first.range_group_name}」${what}，这 ${batch.length} 个岗位现在跟着看得到 / 看不到了。不想这样就改岗位的范围。`
      const fingerprint = sha256(
        canonicalJson({ group: first.range_group, batch: batch.map((e) => e.assignment_id), what }),
      ).slice(0, 12)
      try {
        await approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'policy_change',
          role_id: 'common.owner',
          subject: { object: { type: 'policy', id: `range_group:${first.range_group}` } },
          dedupe_key: `${workspace_id}:range_expanded:${fingerprint}`,
          title: `品牌「${first.range_group_name}」的范围变了`,
          summary,
          payload: {
            target: 'range_group',
            range_group: first.range_group,
            affected_assignments: batch.map((e) => e.assignment_id),
            added,
            removed,
          },
          evidence: {
            source_events: [],
            diff: { before: { removed }, after: { added }, summary },
            provenance: { seen: [] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'system', id: 'org.ranges' },
          // 14：L3 = 默认放行、只通知（44 G5「自动跟，但留痕」）
          automation: {
            level_at_creation: 'L3',
            auto_approved: true,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            recipients: [{ person: owner, via: 'owner' }],
            rule: 'owner',
            escalation: {
              after_hours: 48,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
      } catch {
        // 发不出卡不该把已经改好的范围回滚——事件已经记上了
      }
    })().finally(() => {
      flushing = undefined
      if (pendingExpanded.length > 0) void flushExpanded()
    })
    return flushing
  }

  /** WP234（docs/54 §6.1）：安放表的读口——安放的岗位已经不在了就当没安放。 */
  const placementOf = (assignment_id: string): string | undefined => {
    const placed = backend.placements.get(assignment_id)
    return placed !== undefined && positionOf(placed) !== undefined ? placed : undefined
  }

  /**
   * 谁在做这个岗位（WP234 起按安放算，docs/54 §6.1）：有分配**安放**在这里的人，
   * 加上老规则——未安放的分配凑齐默认包的人（05 §2）。老工作区一行安放都没有，结果与以前逐字相同。
   */
  const holdersOf = async (
    position: StoredPosition,
    people: PersonId[],
  ): Promise<PositionView['holders']> => {
    const ids = new Set(backend.positions().map((p) => p.id))
    const exists = (id: string): boolean => ids.has(id)
    const rawPlacement = (aid: string): string | undefined => backend.placements.get(aid)
    const rows = people.map((person_id) => ({ person_id, held: activeAssignments(person_id) }))
    const who = holdersByPlacement(position, rows, rawPlacement, exists)
    const out: PositionView['holders'] = []
    for (const person of who) {
      const held = (rows.find((r) => r.person_id === person)?.held ?? []).filter(
        (a) => !WORKSPACE_BASE_ROLES.has(a.role_id) && belongsTo(a, position, rawPlacement, exists),
      )
      const ranges = new Map<string, RangeRef>()
      for (const a of held) for (const r of a.ranges) ranges.set(`${r.kind}:${r.id}`, r)
      out.push({ person_id: person, name: await personName(person), ranges: [...ranges.values()] })
    }
    return out
  }

  const memberIds = async (): Promise<PersonId[]> =>
    (await identity.members(workspace_id))
      .filter((m) => m.left_at === undefined)
      .map((m) => m.person_id)

  /** WP213（docs/36 §8.3）：岗位图标——存的那份优先，没有就取同 id 内置模板 yml 里的。 */
  const iconOf = (p: StoredPosition): { icon?: string } => {
    const icon = p.icon ?? bundledPositionIcon(p.id)
    return icon === undefined ? {} : { icon }
  }

  const positionViews = async (): Promise<PositionView[]> => {
    const people = await memberIds()
    const out: PositionView[] = []
    for (const p of backend.positions()) {
      out.push({
        id: p.id,
        name: p.name.zh,
        name_en: p.name.en,
        version: p.version,
        source: p.source,
        roles: p.roles.map((r) => ({
          role_id: r.role,
          name: roleName(r.role),
          default: r.default,
          loaded: roles.roles.get(r.role) !== undefined,
        })),
        holders: await holdersOf(p, people),
        // WP213：图标——存的那份优先，没有就取同 id 内置模板 yml 里的
        ...iconOf(p),
        ...(p.supervisor_person_id === undefined
          ? {}
          : {
              supervisor: {
                person_id: p.supervisor_person_id,
                name: await personName(p.supervisor_person_id),
              },
            }),
      })
    }
    return out
  }

  // ── WP234（docs/54 §6.4）：岗位合并 / 移动 / 拆出 ───────────────────────

  /** 「负责人」是身份不是岗位（§6.5）：它不参与合并 / 移动 / 拆出。 */
  const OWNER_POSITION_ID = 'owner'

  const reshapeTarget = (id: string): StoredPosition => {
    const found = positionOf(id)
    if (found === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
    if (id === OWNER_POSITION_ID)
      throw ORG_ERROR('invalid_input', '「负责人」是身份，不是干活的岗位，不能合并或拆分')
    return found
  }

  /** 改岗位行的职责清单：与 `updatePosition` 同一条版本规则（改了职责 = 改模板，随软件带的变自建）。 */
  const putRoles = (existing: StoredPosition, roleList: StoredPosition['roles']): void => {
    if (canonicalJson(roleList) === canonicalJson(existing.roles)) return
    const [major = '1', minor = '0'] = existing.version.split('.')
    backend.putPosition({
      ...existing,
      roles: roleList,
      version: `${major}.${String(Number(minor) + 1)}.0`,
      source: existing.source === 'bundled' ? ('custom' as const) : existing.source,
    })
  }

  /**
   * 归属于 `from` 的分配（按 §6.1 归属规则）改安放到 `to`；给了 `only` 只动这几条职责。
   * 回改了几条。权限一点不动——安放不带权限。
   */
  const movePlacements = (from: StoredPosition, to: string, only?: ReadonlySet<RoleId>): number => {
    const ids = new Set(backend.positions().map((p) => p.id))
    const exists = (id: string): boolean => ids.has(id)
    const raw = (aid: string): string | undefined => backend.placements.get(aid)
    let moved = 0
    for (const a of roles.assignments.listByWorkspace(workspace_id)) {
      if (a.revoked_at !== undefined || WORKSPACE_BASE_ROLES.has(a.role_id)) continue
      if (only !== undefined && !only.has(a.role_id)) continue
      if (!belongsTo(a, from, raw, exists)) continue
      backend.placements.set(a.id, to)
      moved += 1
    }
    return moved
  }

  const viewsOf = async (ids: string[]): Promise<PositionView[]> =>
    (await positionViews()).filter((p) => ids.includes(p.id))

  const mergePositions = async (
    by: PersonId,
    fromId: string,
    intoId: string,
  ): Promise<PositionReshapeResult> => {
    await reconcile()
    if (fromId === intoId) throw ORG_ERROR('invalid_input', '不能把一个岗位合并到它自己')
    const from = reshapeTarget(fromId)
    const into = reshapeTarget(intoId)
    // 1. 职责清单：B ∪= A（底座职责不带过去；B 原有的在前）
    const roleList = [...into.roles]
    for (const r of from.roles)
      if (!WORKSPACE_BASE_ROLES.has(r.role) && !roleList.some((x) => x.role === r.role))
        roleList.push({ ...r })
    putRoles(into, roleList)
    // 2. 安放：归属于 A 的全部改到 B
    const moved_assignments = movePlacements(from, into.id)
    // 3. 事项 4. 岗位层记忆（职责层记忆与卡按职责 / 分配挂，本来就跟着走）
    const moved_matters =
      (await options.reshape?.retargetMatters({ from: from.id, to: into.id })) ?? 0
    const memory = await options.reshape?.mergeMemory({
      from: from.id,
      into: into.id,
      from_name: from.name.zh,
    })
    // 5. A：自建的删掉；随软件带的留着当类别目录（没人安放在它上面就不出现在任何人的左栏）
    const deleted = from.source === 'custom' ? from.id : undefined
    if (deleted !== undefined) backend.deletePosition(deleted)
    emit('position.merged', by, {
      from: from.id,
      into: into.id,
      role_ids: from.roles.map((r) => r.role).filter((r) => !WORKSPACE_BASE_ROLES.has(r)),
      moved_assignments,
      moved_matters,
      ...(memory === undefined ? {} : { memory }),
      ...(deleted === undefined ? {} : { deleted }),
    })
    return {
      positions: await viewsOf([into.id, ...(deleted === undefined ? [from.id] : [])]),
      moved_assignments,
      moved_matters,
      ...(memory === undefined ? {} : { memory }),
      ...(deleted === undefined ? {} : { deleted }),
    }
  }

  const moveDuty = async (
    by: PersonId,
    fromId: string,
    role_id: RoleId,
    toId: string,
    event: 'position.duty_moved' | 'none' = 'position.duty_moved',
  ): Promise<PositionReshapeResult> => {
    await reconcile()
    if (fromId === toId) throw ORG_ERROR('invalid_input', '移到的还是同一个岗位')
    const from = reshapeTarget(fromId)
    const to = reshapeTarget(toId)
    if (!from.roles.some((r) => r.role === role_id))
      throw ORG_ERROR('invalid_input', `「${roleName(role_id)}」不在「${from.name.zh}」里`)
    if (WORKSPACE_BASE_ROLES.has(role_id))
      throw ORG_ERROR('invalid_input', '工作区底座职责不归任何岗位，挪不动')
    const entry = from.roles.find((r) => r.role === role_id) ?? { role: role_id, default: true }
    // 先挪安放（要按挪之前的 A 判归属），再改两边的职责清单
    const moved_assignments = movePlacements(from, to.id, new Set([role_id]))
    if (!to.roles.some((r) => r.role === role_id)) putRoles(to, [...to.roles, { ...entry }])
    putRoles(
      from,
      from.roles.filter((r) => r.role !== role_id),
    )
    // 事项：A 下面走 R 的那几件跟过去；岗位层记忆留在 A（那是 A 的做事方式）
    const moved_matters =
      (await options.reshape?.retargetMatters({ from: from.id, to: to.id, role_id })) ?? 0
    if (event !== 'none')
      emit(event, by, { from: from.id, to: to.id, role_id, moved_assignments, moved_matters })
    return {
      positions: await viewsOf([from.id, to.id]),
      moved_assignments,
      moved_matters,
    }
  }

  const splitPosition = async (
    by: PersonId,
    fromId: string,
    input: { name: string; role_ids: RoleId[] },
  ): Promise<PositionReshapeResult> => {
    await reconcile()
    const from = reshapeTarget(fromId)
    const name = input.name.trim()
    if (name === '') throw ORG_ERROR('invalid_input', '新岗位要有个名字')
    const picked = [...new Set(input.role_ids)]
    if (picked.length === 0) throw ORG_ERROR('invalid_input', '至少拆出一条职责')
    const missing = picked.filter((r) => !from.roles.some((x) => x.role === r))
    if (missing.length > 0)
      throw ORG_ERROR(
        'invalid_input',
        `「${from.name.zh}」里没有：${missing.map(roleName).join('、')}`,
      )
    const id = `pos-${sha256(canonicalJson({ name, from: from.id, at: now() })).slice(0, 8)}`
    backend.putPosition({
      id,
      version: '1.0.0',
      name: { zh: name, en: name },
      roles: [],
      source: 'custom',
    })
    emit('position.created', by, { position_id: id })
    let moved_assignments = 0
    let moved_matters = 0
    for (const role_id of picked) {
      const out = await moveDuty(by, from.id, role_id, id, 'none')
      moved_assignments += out.moved_assignments
      moved_matters += out.moved_matters
    }
    emit('position.split', by, {
      from: from.id,
      to: id,
      role_ids: picked,
      moved_assignments,
      moved_matters,
    })
    return { positions: await viewsOf([from.id, id]), moved_assignments, moved_matters }
  }

  /** WP234（§6.2）：第 ③ 步一行岗位清单 → 一个岗位行。 */
  const ensurePosition = (
    input: { name: string; role_ids: RoleId[]; template_id?: string },
    by: PersonId,
  ): string => {
    const name = input.name.trim() === '' ? '我的岗位' : input.name.trim()
    const template = input.template_id === undefined ? undefined : positionOf(input.template_id)
    if (
      template !== undefined &&
      template.id !== OWNER_POSITION_ID &&
      input.role_ids.every((r) => template.roles.some((x) => x.role === r))
    ) {
      // 复用：名字不同就改名（WP196 那条路——只改名不算改模板，版本与来源都不动）
      if (template.name.zh !== name) {
        backend.putPosition({ ...template, name: { zh: name, en: template.name.en } })
        emit('position.renamed', by, {
          position_id: template.id,
          from: { ...template.name },
          to: { zh: name, en: template.name.en },
        })
      }
      return template.id
    }
    const id = `pos-${sha256(canonicalJson({ name, roles: input.role_ids, at: now() })).slice(0, 8)}`
    backend.putPosition({
      id,
      version: '1.0.0',
      name: { zh: name, en: name },
      roles: input.role_ids.map((role) => ({ role, default: true })),
      source: 'custom',
    })
    emit('position.created', by, { position_id: id, via: 'onboarding' })
    return id
  }

  /** WP234：类别目录——出厂的那几个模板（不含「负责人」与底座职责）。 */
  const catalog = (): Position[] =>
    SEED_POSITIONS.filter((seed) => seed.id !== OWNER_POSITION_ID)
      .map((seed) => ({
        id: seed.id,
        version: '1.0.0',
        name: { zh: seed.zh, en: seed.en },
        roles: seed.roles
          .filter(([id]) => !WORKSPACE_BASE_ROLES.has(id) && roles.roles.get(id) !== undefined)
          .map(([role, isDefault]) => ({ role, default: isDefault })),
      }))
      .filter((p) => p.roles.length > 0)

  /**
   * 离开工作区的人手上还没批的卡 → 各自工作区的老板。回改派了几张。
   *
   * 两种卡：以「上级」身份收到的（`via: 'scope_manager'`，WP174）；**被升级送到他手上的**
   * （`via: 'escalation'`，WP199）——后一种由审批总线在升级链上追加一步「从他交给老板」，
   * 留痕连续，老板批了照样能施行；离开的人手里那张旧 token 当场作废。
   */
  const handOverCards = async (left: PersonId): Promise<number> => {
    if (approvals.reroute === undefined) return 0
    const owner = (await identity.getWorkspace(workspace_id))?.owner_id
    const leftName = await personName(left)
    const spaces = (await options.workspaceIds?.()) ?? [workspace_id]
    let moved = 0
    for (const ws of spaces) {
      const wsOwner = (await identity.getWorkspace(ws))?.owner_id ?? owner
      if (wsOwner === undefined || wsOwner === left) continue
      const ownerName = await personName(wsOwner)
      const cards = await approvals.queue({ workspace_id: ws, person_id: left, lane: 'mine' })
      for (const card of cards) {
        const mine = card.routing.recipients.find((r) => r.person === left)
        if (mine?.via !== 'scope_manager' && mine?.via !== 'escalation') continue
        const done = await approvals.reroute(card.id, {
          from: left,
          to: wsOwner,
          via: 'owner',
          reason:
            mine.via === 'scope_manager'
              ? `上级${leftName}已经离开工作区，改派给老板${ownerName}`
              : `${leftName}已经离开工作区，升级到他手上的这一级改由老板${ownerName}接手`,
        })
        if (done !== undefined) moved += 1
      }
    }
    return moved
  }

  /**
   * WP174：上级离开了工作区——清空、提醒老板、改派他手上的卡。
   *
   * 三件事的顺序有讲究：先清空（之后新来的卡立刻按老板走），再改派旧卡，最后发提醒。
   * 提醒是一张 L3「只通知」卡（与品牌范围变了那张同一个形）：重设上级是老板自己的事，
   * 不用他点头，但他得知道。`only` 给了就只处理这个人（离职那一刻），不给就把
   * 所有已经不在工作区的上级一起扫掉（打开岗位页时兜一次底）。
   */
  const clearLeftSupervisors = async (by: PersonId, only?: PersonId): Promise<string[]> => {
    const active = new Set(await memberIds())
    const stale = backend
      .positions()
      .filter(
        (p) =>
          p.supervisor_person_id !== undefined &&
          (only === undefined || p.supervisor_person_id === only) &&
          !active.has(p.supervisor_person_id),
      )
    if (stale.length === 0) {
      // WP199：他不是谁的上级，但可能是被升级送到卡上的人——那几张卡照样交接
      if (only !== undefined && !active.has(only)) await handOverCards(only)
      return []
    }
    const workspace = await identity.getWorkspace(workspace_id)
    const owner = workspace?.owner_id
    const byLeft = new Map<PersonId, StoredPosition[]>()
    for (const p of stale) {
      const left = p.supervisor_person_id as PersonId
      const { supervisor_person_id: _gone, ...rest } = p
      backend.putPosition(rest)
      emit('position.supervisor_cleared', by, {
        position_id: p.id,
        previous: left,
        reason: 'left_workspace',
      })
      byLeft.set(left, [...(byLeft.get(left) ?? []), p])
    }
    for (const [left, positions] of byLeft) {
      const leftName = await personName(left)
      const names = positions.map((p) => `「${p.name.zh}」`).join('、')
      // 他手上还没批的「转上级」的卡、被升级送到他手上的卡 → 各自工作区的老板
      const moved = await handOverCards(left)
      if (owner === undefined) continue
      const summary = `${leftName}离开了工作区，他是${names}岗位的上级。这几个岗位现在没有上级，超授权的审批先落到你；${moved === 0 ? '' : `他手上还没批的 ${moved} 张卡已经改派给你。`}想换人就去「公司 → 岗位」重设上级。`
      try {
        await approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'policy_change',
          role_id: 'common.owner',
          subject: { object: { type: 'policy', id: `position_supervisor:${left}` } },
          dedupe_key: `${workspace_id}:supervisor_left:${left}`,
          title: `${names}岗位的上级空了`,
          summary,
          payload: {
            target: 'position_supervisor',
            positions: positions.map((p) => p.id),
            previous: left,
            rerouted: moved,
          },
          evidence: {
            source_events: [],
            diff: { before: { supervisor: leftName }, after: { supervisor: null }, summary },
            provenance: { seen: [] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'system', id: 'org.supervisor' },
          // L3 = 只通知：重设上级是老板自己的事，不用他点头
          automation: {
            level_at_creation: 'L3',
            auto_approved: true,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            recipients: [{ person: owner, via: 'owner' }],
            rule: 'owner',
            escalation: {
              after_hours: 48,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
      } catch {
        // 发不出提醒不该把已经清空的上级回滚——事件已经记上了
      }
    }
    return stale.map((p) => p.id)
  }

  const policyView = (): WorkspacePolicyView => {
    const policy = roles.policies.get(workspace_id) ?? {
      workspace_id,
      mandates: {},
      global_caps: {},
    }
    return {
      workspace_id,
      mandates: policy.mandates,
      global_caps: policy.global_caps,
      separation_of_duties: policy.separation_of_duties ?? [],
      ...(policy.sensitivity_overrides === undefined
        ? {}
        : { sensitivity_overrides: policy.sensitivity_overrides }),
    }
  }

  const invitationView = (
    inv: Awaited<ReturnType<LocalIdentityService['createInvitation']>>['invitation'],
    url?: string,
  ): InvitationView => ({
    id: inv.id,
    email: inv.email,
    ...(inv.name === undefined ? {} : { name: inv.name }),
    role: inv.role,
    ...(inv.position_id === undefined ? {} : { position_id: inv.position_id }),
    ranges: inv.ranges,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
    ...(inv.accepted_at === undefined ? {} : { accepted_at: inv.accepted_at }),
    used: inv.used,
    ...(url === undefined ? {} : { url }),
    delivered: 'link',
  })

  /** 一个人拿到一个岗位 = 拿到它默认包里的全部职责（已经在做的不重复给）。 */
  const grant = (input: {
    person_id: PersonId
    granted_by: PersonId
    roleIds: RoleId[]
    ranges: RangeRef[]
    /** 44 G1：挂的品牌（范围组）；判权限时展开成成员。 */
    range_groups?: string[]
  }): Assignment[] => {
    const held = activeAssignments(input.person_id)
    const created: Assignment[] = []
    for (const role_id of input.roleIds) {
      if (roles.roles.get(role_id) === undefined)
        throw ORG_ERROR('not_found', `这台机器上没装「${role_id}」这个职责的定义`)
      if (held.some((a) => a.role_id === role_id)) continue
      created.push(
        roles.assignments.create({
          person_id: input.person_id,
          workspace_id,
          role_id,
          granted_by: input.granted_by,
          ranges: input.ranges,
          ...(input.range_groups === undefined || input.range_groups.length === 0
            ? {}
            : { range_groups: input.range_groups }),
        }),
      )
    }
    return created
  }

  // ── 45 H4 建之前先查 ──────────────────────────────────────────────

  /** 问的那一条翻成 catalog 的判定形状（三类各填各的那几格）。 */
  const candidateOf = (query: OrgDuplicateQuery): OrgCandidate => {
    if (query.kind === 'range_group')
      return { kind: 'range_group', name: query.name, members: query.members ?? [] }
    if (query.kind === 'product_line') {
      if (query.parent === undefined || query.rule === undefined)
        throw ORG_ERROR('invalid_input', '查产品线要给"切在哪里面"与"按什么切"')
      return {
        kind: 'product_line',
        name: query.name,
        parent: query.parent,
        rule: cleanRule(query.rule),
      }
    }
    const external_id = query.external_id ?? query.name
    const platform = query.platform ?? platformOfRange({ kind: 'store', id: external_id })
    return { kind: 'store_range', name: query.name, platform, external_id }
  }

  /** 公司这边同类的东西（被取代的那些不算——它们是别名，不是第二份）。 */
  const existingOrgObjects = (kind: OrgDuplicateQuery['kind']): OrgExisting[] => {
    const groups = roles.rangeGroups.list(workspace_id).filter((g) => g.superseded_by === undefined)
    const lines = roles.productLines.list(workspace_id).filter((l) => l.superseded_by === undefined)
    if (kind === 'range_group')
      return groups.map((g) => ({
        kind: 'range_group' as const,
        id: g.id,
        name: g.name,
        members: g.members,
        holders: roles.rangeGroups.assignments(g.id).length,
        ...(g.created_by === undefined ? {} : { created_by: g.created_by }),
      }))
    if (kind === 'product_line')
      return lines.map((l) => ({
        kind: 'product_line' as const,
        id: l.id,
        name: l.name,
        parent: l.parent,
        rule: l.rule,
        holders: roles.productLines.assignments(l.id).length,
        ...(l.created_by === undefined ? {} : { created_by: l.created_by }),
      }))
    const live = roles.assignments
      .listByWorkspace(workspace_id, {})
      .filter((a) => a.revoked_at === undefined)
    return deriveStoreRanges({
      assignment_ranges: live.flatMap((a) => a.ranges),
      range_groups: groups,
      product_lines: lines,
    }).map((s) => ({
      kind: 'store_range' as const,
      id: s.range.id,
      name: s.name,
      platform: s.platform,
      external_id: s.external_id,
      holders: live.filter((a) => a.ranges.some((r) => r.id === s.range.id)).length,
    }))
  }

  // ── 端口 ───────────────────────────────────────────────────────────

  const port: OrgPort = {
    async roles(_actor) {
      await reconcile()
      return roles.roles.list().map(summaryOf)
    },

    async role(_actor, id) {
      await reconcile()
      const found = roles.roles.get(id)
      return found === undefined ? undefined : detailOf(found)
    },

    async copyRole(actor, input: CopyRoleInput) {
      await reconcile()
      const base = roles.roles.get(input.from)
      if (base === undefined) throw ORG_ERROR('not_found', `没有这个职责：${input.from}`)
      let id = `${base.id}-custom`
      for (let n = 2; roles.roles.get(id) !== undefined; n += 1) id = `${base.id}-custom-${n}`
      const next: RoleDefinitionFull = {
        ...structuredClone(base),
        id,
        version: '1.0.0',
        name: {
          zh: input.name ?? `${base.name.zh}（本公司）`,
          en: input.name ?? `${base.name.en} (custom)`,
        },
      }
      const json = JSON.stringify(next)
      // 存之前再过一遍 schema：库里永远只有校验过的定义（05 §0）
      parseRole(json, `org:copy:${id}`)
      backend.putCustomRole(id, json)
      roles.roles.register(next)
      custom.add(id)
      emit('role.copied', actor.person_id, { from: base.id, role_id: id })
      return detailOf(next)
    },

    async proposeRoleChange(actor, id, patch: RolePatchInput) {
      await reconcile()
      const base = roles.roles.get(id)
      if (base === undefined) throw ORG_ERROR('not_found', `没有这个职责：${id}`)
      if (!custom.has(id))
        throw ORG_ERROR(
          'conflict',
          '内置职责模板不给直接改。先「复制一份」，改自己那一份（05 §0：职责定义是配置，带版本）',
        )
      const next: RoleDefinitionFull = structuredClone(base)
      if (patch.name !== undefined) next.name = { ...next.name, zh: patch.name }
      if (patch.name_en !== undefined) next.name = { ...next.name, en: patch.name_en }
      if (patch.description !== undefined) next.description = patch.description
      for (const change of patch.actions ?? []) {
        const action = next.actions.find((a) => a.id === change.id)
        if (action === undefined)
          throw ORG_ERROR('invalid_input', `职责 ${id} 没有「${change.id}」这个动作`)
        for (const [key, value] of Object.entries(change.caps ?? {}))
          action.mandate.caps[key] = value
        if (change.window_max_count !== undefined)
          action.mandate.window = {
            per: action.mandate.window?.per ?? 'day',
            max_count: change.window_max_count,
          }
      }
      for (const change of patch.automation ?? []) {
        const spec = next.automation[change.action_id]
        if (spec === undefined)
          throw ORG_ERROR('invalid_input', `职责 ${id} 没有「${change.action_id}」的自动化设置`)
        if (spec.hard_ceiling === true && change.ceiling !== spec.ceiling)
          throw ORG_ERROR(
            'invalid_input',
            `「${change.action_id}」的自动化上限是写死的（05 §1.4 hard_ceiling），不能改`,
          )
        spec.ceiling = change.ceiling as Level
      }
      const [major = '1', minor = '0', bug = '0'] = next.version.split('.')
      next.version = `${major}.${minor}.${String(Number(bug) + 1)}`
      const json = JSON.stringify(next)
      parseRole(json, `org:patch:${id}`)
      const affected = roles.assignments.listByRole(id, { workspace_id }).map((a) => a.id)
      return propose(actor, {
        kind: 'role',
        doc: json,
        title: `改职责：${base.name.zh}`,
        summary: `${base.name.zh} 的设置要改一处。批准后对这个职责的 ${affected.length} 位在岗同事生效。`,
        target: 'role',
        before: { name: base.name.zh, version: base.version, actions: base.actions },
        after: { name: next.name.zh, version: next.version, actions: next.actions },
        affected,
      })
    },

    async positions(actor) {
      await reconcile()
      // WP174 兜底：上级走了但没经过离职 / 移出那两条路（比如直接改了身份库）也清掉
      await clearLeftSupervisors(actor.person_id)
      return positionViews()
    },

    async setPositionSupervisor(actor, id, input) {
      await reconcile()
      const existing = positionOf(id)
      if (existing === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      const previous = existing.supervisor_person_id
      if (input.person_id === null) {
        const { supervisor_person_id: _gone, ...rest } = existing
        backend.putPosition(rest)
        if (previous !== undefined)
          emit('position.supervisor_cleared', actor.person_id, {
            position_id: id,
            previous,
            reason: 'manual',
          })
      } else {
        if (!(await memberIds()).includes(input.person_id))
          throw ORG_ERROR('invalid_input', '上级得是工作区里还在的人')
        // 只动这一格：改上级不是改模板，版本号与来源都不变（05 §2 那条规矩管的是职责包）
        backend.putPosition({ ...existing, supervisor_person_id: input.person_id })
        if (previous !== input.person_id)
          emit('position.supervisor_set', actor.person_id, {
            position_id: id,
            supervisor: input.person_id,
            ...(previous === undefined ? {} : { previous }),
          })
      }
      const found = (await positionViews()).find((p) => p.id === id)
      if (found === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      return found
    },

    async createPosition(actor, input: PositionInput) {
      await reconcile()
      const id =
        input.id ?? `pos-${sha256(canonicalJson({ name: input.name, at: now() })).slice(0, 8)}`
      if (positionOf(id) !== undefined) throw ORG_ERROR('conflict', `岗位 ${id} 已经有了`)
      const stored: StoredPosition = {
        id,
        version: '1.0.0',
        name: { zh: input.name, en: input.name_en ?? input.name },
        roles: input.roles.map((r) => ({ role: r.role_id, default: r.default ?? true })),
        source: 'custom',
      }
      backend.putPosition(stored)
      emit('position.created', actor.person_id, { position_id: id })
      const found = (await positionViews()).find((p) => p.id === id)
      if (found === undefined) throw ORG_ERROR('conflict', '岗位没存住')
      return found
    },

    async updatePosition(actor, id, input: PositionInput) {
      await reconcile()
      const existing = positionOf(id)
      if (existing === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      const [major = '1', minor = '0'] = existing.version.split('.')
      const zh = input.name.trim()
      if (zh === '') throw ORG_ERROR('invalid_input', '岗位名不能是空的')
      const en = input.name_en?.trim() ?? ''
      const name = { zh, en: en === '' ? existing.name.en : en }
      const roleList = input.roles.map((r) => ({ role: r.role_id, default: r.default ?? true }))
      // WP196：只改了名字（职责一条没动）不算改模板——版本号与来源都不变；改名另记一条审计。
      // 路由看的是职责、不看岗位显示名，所以改名不影响谁接什么活。
      const sameRoles = canonicalJson(roleList) === canonicalJson(existing.roles)
      const renamed = name.zh !== existing.name.zh || name.en !== existing.name.en
      backend.putPosition({
        ...existing,
        name,
        roles: roleList,
        ...(sameRoles
          ? {}
          : {
              version: `${major}.${String(Number(minor) + 1)}.0`,
              // 05 §2：改模板不影响已分配的人，所以这里只动模板，一条分配都不碰
              source: existing.source === 'bundled' ? ('custom' as const) : existing.source,
            }),
      })
      if (renamed)
        emit('position.renamed', actor.person_id, {
          position_id: id,
          from: { zh: existing.name.zh, en: existing.name.en },
          to: name,
        })
      emit('position.updated', actor.person_id, { position_id: id })
      const found = (await positionViews()).find((p) => p.id === id)
      if (found === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      return found
    },

    async deletePosition(actor, id) {
      await reconcile()
      const existing = positionOf(id)
      if (existing === undefined) throw ORG_ERROR('not_found', `没有这个岗位：${id}`)
      const holders = await holdersOf(existing, await memberIds())
      if (holders.length > 0)
        throw ORG_ERROR(
          'conflict',
          `还有 ${holders.length} 位同事在做这个岗位（${holders.map((h) => h.name).join('、')}）。先把他们的分配撤掉再删。`,
        )
      backend.deletePosition(id)
      emit('position.deleted', actor.person_id, { position_id: id })
    },

    // WP234（docs/54 §6.4）：公司页岗位卡上的三个动作
    mergePosition: (actor, id, input) => mergePositions(actor.person_id, id, input.into),
    movePositionDuty: (actor, id, input) => moveDuty(actor.person_id, id, input.role_id, input.to),
    splitPosition: (actor, id, input) => splitPosition(actor.person_id, id, input),

    /**
     * WP234（docs/54 §6.5）：负责人转交 = 把 `common.owner` 分给另一位成员。
     * 第一版**不收回自己那一条**（理由见 §6.5）；对方已经是负责人就原样回。
     */
    async transferOwner(actor, input) {
      await reconcile()
      const members = await memberIds()
      if (!members.includes(input.person_id))
        throw ORG_ERROR('not_found', '这个人还不是本工作区的成员，先邀请他加入')
      const existing = activeAssignments(input.person_id).find((a) => a.role_id === 'common.owner')
      const assignment =
        existing ??
        grant({
          person_id: input.person_id,
          granted_by: actor.person_id,
          roleIds: ['common.owner'],
          ranges: [],
        })[0]
      if (assignment === undefined) throw ORG_ERROR('conflict', '负责人身份没交出去')
      if (existing === undefined)
        emit('owner.transferred', actor.person_id, {
          from: actor.person_id,
          to: input.person_id,
          assignment_id: assignment.id,
          kept_own: true,
        })
      return {
        person_id: input.person_id,
        person_name: await personName(input.person_id),
        assignment_id: assignment.id,
        already: existing !== undefined,
      }
    },

    async assign(actor, input: AssignInput) {
      await reconcile()
      const members = await identity.members(workspace_id)
      if (!members.some((m) => m.person_id === input.person_id && m.left_at === undefined))
        throw ORG_ERROR('not_found', '这个人还不是本工作区的成员，先邀请他加入')
      let roleIds: RoleId[]
      if (input.position_id !== undefined) {
        const position = positionOf(input.position_id)
        if (position === undefined)
          throw ORG_ERROR('not_found', `没有这个岗位：${input.position_id}`)
        const extra = new Set(input.include ?? [])
        const unknown = [...extra].filter((r) => !position.roles.some((x) => x.role === r))
        if (unknown.length > 0)
          throw ORG_ERROR('invalid_input', `岗位 ${position.id} 里没有：${unknown.join('、')}`)
        roleIds = position.roles.filter((r) => r.default || extra.has(r.role)).map((r) => r.role)
      } else if (input.role_id !== undefined) {
        roleIds = [input.role_id]
      } else {
        throw ORG_ERROR('invalid_input', '要么给岗位，要么给一个职责')
      }
      const created = grant({
        person_id: input.person_id,
        granted_by: actor.person_id,
        roleIds,
        ranges: input.ranges,
        ...(input.range_groups === undefined ? {} : { range_groups: input.range_groups }),
      })
      // WP234（docs/54 §6.1）：按岗位分的，新建的那几条就安放在这个岗位上——
      // 这条职责同时挂在别的岗位里时，界面与岗位层记忆都不会再分不清它算哪个岗位的
      if (input.position_id !== undefined) {
        for (const a of created) backend.placements.set(a.id, input.position_id)
        // 这个人本来就有、但还没安放的那几条（老分配）：按这次说的岗位安放，左栏才不会出两份。
        // 已经安放在别处的不挪——挪职责走「移动职责」（§6.4），那里会把事项一起带过去。
        for (const a of activeAssignments(input.person_id))
          if (
            roleIds.includes(a.role_id) &&
            !created.some((c) => c.id === a.id) &&
            placementOf(a.id) === undefined
          )
            backend.placements.set(a.id, input.position_id)
      }
      for (const a of created)
        emit('assignment.granted', actor.person_id, {
          assignment_id: a.id,
          person_id: a.person_id,
          role_id: a.role_id,
          ranges: a.ranges,
          ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
        })
      return Promise.all(created.map(viewOf))
    },

    async updateAssignment(actor, id, input: UpdateAssignInput) {
      await reconcile()
      const found = roles.assignments.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条分配：${id}`)
      const overrides: Record<string, Partial<Mandate>> = {}
      for (const [actionId, value] of Object.entries(input.mandate_overrides ?? {}))
        overrides[actionId] = { caps: { ...(value.caps ?? {}) } }
      const next = roles.assignments.update(id, {
        ...(input.ranges === undefined ? {} : { ranges: input.ranges }),
        ...(input.range_groups === undefined ? {} : { range_groups: input.range_groups }),
        ...(input.mandate_overrides === undefined ? {} : { mandate_overrides: overrides }),
      })
      emit('assignment.updated', actor.person_id, { assignment_id: id, ranges: next.ranges })
      return viewOf(next)
    },

    async revokeAssignment(actor, id, input) {
      await reconcile()
      const found = roles.assignments.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条分配：${id}`)
      // WP234（docs/54 §6.5）：最后一位负责人卸不下——先转交给别人（审批默认收件、授权都靠它）
      if (found.role_id === 'common.owner' && found.revoked_at === undefined) {
        const others = roles.assignments
          .listByRole('common.owner', { workspace_id })
          .filter((a) => a.revoked_at === undefined && a.id !== id)
        if (others.length === 0)
          throw ORG_ERROR('conflict', '这是最后一位负责人，先在「公司」页转交给别人，再卸下自己的')
      }
      const revoked = roles.assignments.revoke(id, {
        ...(input.handover_to === undefined ? {} : { handover_to: input.handover_to }),
      })
      emit('assignment.revoked', actor.person_id, {
        assignment_id: id,
        person_id: revoked.person_id,
        role_id: revoked.role_id,
      })
      return viewOf(revoked)
    },

    async policy(_actor) {
      await reconcile()
      return policyView()
    },

    async proposePolicyChange(actor, input: PolicyPatchInput) {
      await reconcile()
      const before = policyView()
      const sod = input.separation_of_duties ?? before.separation_of_duties
      const next: WorkspacePolicy = {
        workspace_id,
        mandates: (input.mandates ?? before.mandates) as WorkspacePolicy['mandates'],
        global_caps: input.global_caps ?? before.global_caps,
        ...(sod.length === 0 ? {} : { separation_of_duties: sod }),
      }
      return propose(actor, {
        kind: 'policy',
        doc: JSON.stringify(next),
        title: '改公司策略层',
        summary: '公司的授权额度 / 总量上限 / 谁审谁要改一处。批准后对全工作区生效（05 §3）。',
        target: 'workspace_policy',
        before,
        after: next,
        affected: [],
      })
    },

    async members(_actor) {
      await reconcile()
      const list = await identity.members(workspace_id)
      const positions = await positionViews()
      const out: MemberView[] = []
      for (const m of list) {
        const person: Person | undefined = await identity.getPerson(m.person_id)
        const assignments = roles.assignments
          .listByPerson(m.person_id, { workspace_id })
          .filter((a) => a.revoked_at === undefined)
        out.push({
          person_id: m.person_id,
          name: person?.name ?? m.person_id,
          email: person?.email ?? '',
          role: m.role,
          joined_at: m.joined_at,
          ...(m.left_at === undefined ? {} : { left_at: m.left_at }),
          positions: positions
            .filter((p) => p.holders.some((h) => h.person_id === m.person_id))
            .map((p) => ({ id: p.id, name: p.name })),
          assignments: await Promise.all(assignments.map(viewOf)),
        })
      }
      return out
    },

    async removeMember(actor, person_id) {
      await reconcile()
      const workspace = await identity.getWorkspace(workspace_id)
      if (workspace?.owner_id === person_id)
        throw ORG_ERROR('conflict', '工作区所有者不能被移出（先把所有者换给别人）')
      const active = activeAssignments(person_id)
      for (const a of active) roles.assignments.revoke(a.id)
      await identity.leaveWorkspace(workspace_id, person_id)
      emit('membership.removed', actor.person_id, {
        person_id,
        revoked_assignments: active.length,
      })
      // WP174：他是哪几个岗位的上级，就清空、提醒老板、改派他手上的卡
      await clearLeftSupervisors(actor.person_id, person_id)
      // WP182：B2B 业务员的客户 / 商机 / 没回的询盘 → 交接卡给老板
      await options.afterMemberLeft?.(person_id, actor.person_id).catch(() => undefined)
      return { revoked_assignments: active.length }
    },

    async invitations(_actor) {
      await reconcile()
      return identity.listInvitations(workspace_id).map((inv) => invitationView(inv))
    },

    async invite(actor, input: InviteInput) {
      await reconcile()
      if (input.position_id !== undefined && positionOf(input.position_id) === undefined)
        throw ORG_ERROR('not_found', `没有这个岗位：${input.position_id}`)
      const issued = await identity.createInvitation({
        workspace_id,
        email: input.email,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
        ranges: input.ranges ?? [],
        invited_by: actor.person_id,
      })
      // 事件里只有邀请 id 与邮箱，**没有 token**（21 §5 秘密不落库、不进日志）
      emit('invitation.created', actor.person_id, {
        invitation_id: issued.invitation.id,
        email: issued.invitation.email,
      })
      const url = `${options.baseUrl ?? ''}/invite/${issued.token}`
      return invitationView(issued.invitation, url)
    },

    async accept(token, input) {
      const accepted = await identity.acceptInvitation(token, {
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      if (accepted.invitation.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', '邀请链接无效或已过期')
      const position =
        accepted.invitation.position_id === undefined
          ? undefined
          : positionOf(accepted.invitation.position_id)
      const roleIds: RoleId[] = position
        ? position.roles.filter((r) => r.default).map((r) => r.role)
        : []
      // 20 §1：加入工作区就有"工作区成员"这条通用职责，不属于任何岗位
      if (roles.roles.get('common.member') !== undefined) roleIds.unshift('common.member')
      const created = grant({
        person_id: accepted.person.id,
        granted_by: accepted.invitation.invited_by,
        roleIds,
        ranges: accepted.invitation.ranges,
      })
      emit('invitation.accepted', accepted.person.id, {
        invitation_id: accepted.invitation.id,
        person_id: accepted.person.id,
      })
      return {
        workspace_id,
        workspace_name: accepted.workspace.name,
        email: accepted.person.email,
        person_id: accepted.person.id,
        assignments: await Promise.all(created.map(viewOf)),
      } satisfies AcceptedInvitationView
    },

    // ── 44 品牌与产品线 ──────────────────────────────────────────────
    //
    // 这两组**不走审批**：品牌加一家店是组织结构的日常，不是改职责模板（14 §1
    // 的 `policy_change` 管的是后者）。留痕靠 `range_group.*` / `product_line.*`
    // 两类事件，加上成员变动时每条受影响分配一条 `assignment.range_expanded`（44 G5）。
    rangeGroups(_actor) {
      return Promise.resolve(roles.rangeGroups.list(workspace_id).map((g) => rangeGroupView(g)))
    },

    /**
     * 45 H3 别名解析的**读**那一侧：打开一条被并进公司的品牌，看到的是公司那份。
     *
     * 回的是真源那一条（`alias_of` 记着"你点进来的是哪一条"），`readonly` 让界面
     * 把"改"换成"提议修改"。链断了或成环就停在走得到的最后一条（读路径不该打不开）。
     */
    rangeGroup(_actor, id) {
      const found = roles.rangeGroups.resolve(id)
      return Promise.resolve(found === undefined ? undefined : rangeGroupView(found, id))
    },

    createRangeGroup(actor, input) {
      const created = roles.rangeGroups.create({
        workspace_id,
        name: input.name,
        members: input.members,
        created_by: actor.person_id,
      })
      emit('range_group.created', actor.person_id, {
        range_group_id: created.id,
        name: created.name,
        members: created.members.length,
        // 45 H4：查到像的还是建了的，那句为什么进日志——下次谁查到这一对看得见
        ...(input.duplicate_ack === undefined
          ? {}
          : {
              duplicate_reason: input.duplicate_ack.reason,
              duplicate_of: input.duplicate_ack.similar_to,
            }),
      })
      return Promise.resolve(rangeGroupView(created))
    },

    updateRangeGroup(actor, id, input) {
      const before = roles.rangeGroups.get(id)
      if (before === undefined || before.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这个品牌：${id}`)
      const next = roles.rangeGroups.update(id, { name: input.name, members: input.members })
      emit('range_group.updated', actor.person_id, {
        range_group_id: id,
        name: next.name,
        members: next.members.length,
        members_before: before.members.length,
      })
      return Promise.resolve(rangeGroupView(next))
    },

    deleteRangeGroup(actor, id) {
      const found = roles.rangeGroups.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这个品牌：${id}`)
      roles.rangeGroups.delete(id)
      emit('range_group.deleted', actor.person_id, { range_group_id: id, name: found.name })
      return Promise.resolve()
    },

    productLines(_actor) {
      return Promise.resolve(roles.productLines.list(workspace_id).map((l) => productLineView(l)))
    },

    /** 45 H3 别名解析（同 {@link OrgPort.rangeGroup}，产品线那一份）。 */
    productLine(_actor, id) {
      const found = roles.productLines.resolve(id)
      return Promise.resolve(found === undefined ? undefined : productLineView(found, id))
    },

    createProductLine(actor, input) {
      const created = roles.productLines.create({
        workspace_id,
        name: input.name,
        parent: input.parent,
        rule: cleanRule(input.rule),
        created_by: actor.person_id,
      })
      emit('product_line.created', actor.person_id, {
        product_line_id: created.id,
        name: created.name,
        parent: created.parent,
        platform: created.rule.platform,
        ...(input.duplicate_ack === undefined
          ? {}
          : {
              duplicate_reason: input.duplicate_ack.reason,
              duplicate_of: input.duplicate_ack.similar_to,
            }),
      })
      return Promise.resolve(productLineView(created))
    },

    updateProductLine(actor, id, input) {
      const found = roles.productLines.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条产品线：${id}`)
      const next = roles.productLines.update(id, {
        name: input.name,
        parent: input.parent,
        rule: cleanRule(input.rule),
      })
      emit('product_line.updated', actor.person_id, {
        product_line_id: id,
        name: next.name,
        platform: next.rule.platform,
      })
      return Promise.resolve(productLineView(next))
    },

    deleteProductLine(actor, id) {
      const found = roles.productLines.get(id)
      if (found === undefined || found.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这条产品线：${id}`)
      roles.productLines.delete(id)
      emit('product_line.deleted', actor.person_id, { product_line_id: id, name: found.name })
      return Promise.resolve()
    },

    /**
     * 45 H4「建之前先查」：查同唯一键或相似的三类组织对象。**只读，不改任何东西**。
     *
     * 公司这边的"店铺 / 平台账号范围"是**推**出来的（没有店铺表）：岗位范围、
     * 品牌成员、产品线归属里出现过的那些 id 就是它——与 Join 那条路用同一个
     * `deriveStoreRanges`，不然同一家店在两条路上会长出两把不同的钥匙。
     */
    async checkDuplicate(_actor, query) {
      await reconcile()
      const hits = findOrgSimilar(
        candidateOf(query),
        existingOrgObjects(query.kind),
        query.exclude_id === undefined ? {} : { exclude_id: query.exclude_id },
      )
      return Promise.all(
        hits.map(async (h) => ({
          ...h,
          ...(h.created_by === undefined
            ? {}
            : { created_by_name: await personName(h.created_by) }),
        })),
      )
    },

    /**
     * 45 H5 / H3：**提议修改**一条品牌 / 产品线。
     *
     * 两种人走这条路：公司里的普通成员（组织结构对他只读，44 里范围直接决定
     * 谁看得到什么，让他随手改等于让他自己给自己扩权限），以及打开了被取代的
     * 那份个人对象的本人（那一份是别名，改的是公司那条）。
     *
     * 给的 id 是别名时，卡落在**真源**那一条上——不然批下来会去改一份没人读的副本。
     */
    async proposeRangeChange(actor, input) {
      await reconcile()
      const isGroup = input.target === 'range_group'
      const target = isGroup
        ? roles.rangeGroups.resolve(input.id)
        : roles.productLines.resolve(input.id)
      if (target === undefined || target.workspace_id !== workspace_id)
        throw ORG_ERROR('not_found', `没有这一条：${input.id}`)
      const reason = input.reason.trim()
      if (reason.length < MIN_PROPOSAL_REASON)
        throw ORG_ERROR(
          'invalid_input',
          `提议修改要写一句为什么（至少 ${MIN_PROPOSAL_REASON} 个字）——owner 是照这句话点头的`,
        )
      const group = isGroup ? (target as RangeGroup) : undefined
      const line = isGroup ? undefined : (target as ProductLine)
      const change: PendingRangeChange = {
        id: target.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.members === undefined || !isGroup ? {} : { members: input.members }),
        ...(input.parent === undefined || isGroup ? {} : { parent: input.parent }),
        ...(input.rule === undefined || isGroup ? {} : { rule: cleanRule(input.rule) }),
      }
      const what = isGroup ? '品牌' : '产品线'
      const alias = target.id === input.id ? '' : `（他点开的是自己那份 ${input.id}）`
      return propose(actor, {
        kind: input.target,
        doc: JSON.stringify(change),
        target: input.target,
        title: `${actor.person_id} 想改${what}「${target.name}」`,
        summary: `${reason}${alias}。批了才改；不批就维持现状。`,
        before: isGroup
          ? { name: group?.name, members: group?.members }
          : { name: line?.name, parent: line?.parent, rule: line?.rule },
        after: change,
        affected: (isGroup
          ? roles.rangeGroups.assignments(target.id)
          : roles.productLines.assignments(target.id)
        ).map((a) => a.id),
      })
    },

    async rangeOptions(_actor) {
      await reconcile()
      // 候选就是这个工作区里已经用过的那些范围；第一次分配时允许手填一个新的
      const seen = new Map<string, { kind: RangeRef['kind']; id: string; label: string }>()
      // WP138：「整个品牌」永远是一个候选（红人 / 在线客服不按店划，没连店也能挂）
      const brand = { kind: 'brand' as const, id: workspace_id }
      const brandName = options.brandName?.()
      seen.set(`brand:${workspace_id}`, {
        ...brand,
        label: brandName === undefined ? '整个品牌' : `整个品牌（${brandName}）`,
      })
      for (const person of await memberIds())
        for (const a of activeAssignments(person))
          for (const r of a.ranges)
            if (!seen.has(`${r.kind}:${r.id}`)) seen.set(`${r.kind}:${r.id}`, { ...r, label: r.id })
      // 44 G2：建好的产品线也是候选，而且显示的是名字不是 id
      for (const line of roles.productLines.list(workspace_id))
        seen.set(`product_line:${line.id}`, {
          kind: 'product_line',
          id: line.id,
          label: line.name,
        })
      return [...seen.values()]
    },
  }

  return {
    port,
    positions: () => backend.positions(),
    placementOf,
    ensurePosition,
    place: (assignment_id, position_id) => {
      backend.placements.set(assignment_id, position_id)
    },
    catalog,
    reshape: {
      merge: mergePositions,
      moveDuty: (by, from, role_id, to) => moveDuty(by, from, role_id, to),
      split: splitPosition,
    },
    onRangeExpanded,
    onMemberLeft: async (person_id, by) => {
      const out = await clearLeftSupervisors(by ?? 'system', person_id)
      // WP182：离职编排那条路同样出 B2B 交接卡
      await options.afterMemberLeft?.(person_id, by ?? 'system').catch(() => undefined)
      return out
    },
    close() {
      backend.close()
    },
  }
}
