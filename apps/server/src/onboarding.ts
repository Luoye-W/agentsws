/**
 * 首次设置向导的装配（WP51 交付 ②③，46 §1 §3）。
 *
 * 用户第一次打开工具时只被问三件事——**你们公司叫什么、你是谁、你做什么**——
 * 这个模块负责后两件里"机器该自己想明白"的部分：勾了哪几个岗位，就该连哪些平台、
 * 装哪些技能、建哪几条分配。
 *
 * 四条纪律：
 *
 * 1. **归一化是纯函数**（`normalizeCompanyName` / `companyKey`）。它决定"两台机器算不算
 *    同一家公司"，所以必须能表驱动地测、能在两台机器上算出同一个值，不许碰时钟、
 *    不许碰随机源、不许读库。
 * 2. **公司全称不进哈希以外的任何出口**（46 §2 I1）：局域网 TXT 里只有 `companyKey`，
 *    事件日志里也只有它，全称只活在本机的档案里。
 * 3. **`plan` 只算不写**（46 §3 I5）：向导第 ④ 步那张清单是勾选的去重汇总，点进去就是
 *    连接页 / 技能页已有的那张卡，不另做一套配置界面。真建分配的是 `apply`。
 * 4. **勾岗位 = 该岗位职责全勾**（46 §1 表 ③）。前后端同一套算法：`expandRoles` 是
 *    唯一的展开口子，工作台那一侧照着同样的规则算，于是"界面上勾了什么"与
 *    "服务端建了什么"不会两张皮。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  DiscoveryHelloView,
  DiscoveryStateView,
  InviteView,
  MembershipRequestInput,
  MembershipRequestView,
  OnboardingApplyView,
  OnboardingConnectorItem,
  OnboardingPlanInput,
  OnboardingPlanView,
  OnboardingPort,
  OnboardingPositionPlanItem,
  OnboardingPositionView,
  OnboardingSkillItem,
  OnboardingStateView,
  WorkspaceProfileInput,
  WorkspaceProfileView,
} from '@agentsws/api'
import type {
  ApprovalBus,
  Clock,
  EventEnvelope,
  PersonId,
  Position,
  RangeRef,
  RoleId,
  WorkspaceId,
  WorkspaceProfile,
} from '@agentsws/contracts'
import { companyKey, normalizeDomain } from '@agentsws/core'
import type { RoleStore } from '@agentsws/roles'
import type BetterSqlite3 from 'better-sqlite3'
import { catalogEntry, ROLE_CONNECTOR_KIND } from './catalog.js'
import { createDiscovery, type Discovery, type MdnsFactory } from './discovery.js'
import {
  createInvites,
  type InvitesAssembly,
  type InvitesIdentity,
  OnboardingError,
} from './invites.js'

export { OnboardingError } from './invites.js'

/* ------------------------------------------------------------------ */
/* 46 §2 I1：公司名归一化与 company_key                                  */
/* ------------------------------------------------------------------ */

/**
 * 真身在 `@agentsws/core`（`company.ts`）。搬过去是因为**模拟回路也要它**：
 * `packages/simulation` 演"两个人一个写全称、一个多打空格还加了有限公司"时，
 * 必须拿服务进程同一个函数算钥匙，不然那条题只是在测它自己。
 *
 * 这里照旧导出同样的三个名字——外面（测试、别的模块）的导入一个字都不用改。
 */
export { companyKey, normalizeCompanyName, normalizeDomain } from '@agentsws/core'

/* ------------------------------------------------------------------ */
/* 档案存储                                                             */
/* ------------------------------------------------------------------ */

interface ProfileBackend {
  get(): WorkspaceProfile | undefined
  put(p: WorkspaceProfile): void
  close(): void
}

function createMemoryProfileBackend(): ProfileBackend {
  let profile: WorkspaceProfile | undefined
  return {
    get: () => (profile === undefined ? undefined : { ...profile }),
    put: (p) => {
      profile = { ...p }
    },
    close: () => {
      profile = undefined
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS onboarding_profile (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
`

function createSqliteProfileBackend(dbPath: string): ProfileBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const put = db.prepare(
    'INSERT INTO onboarding_profile (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  )
  return {
    get: () => {
      const row = db.prepare('SELECT json FROM onboarding_profile WHERE id = 1').get() as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as WorkspaceProfile)
    },
    put: (p) => {
      put.run(JSON.stringify(p))
    },
    close: () => {
      db.close()
    },
  }
}

/* ------------------------------------------------------------------ */
/* 装配                                                                 */
/* ------------------------------------------------------------------ */

/** 岗位模板的最小面（真源在 `org.ts` 的库里，这里只读）。 */
export type PositionLike = Pick<Position, 'id' | 'name' | 'roles'>

export interface OnboardingOptions {
  clock: Clock
  random: () => number
  workspace_id: WorkspaceId
  owner: PersonId
  /** 工作区名字（人话）。 */
  workspaceName: () => string
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  roles: RoleStore
  approvals: ApprovalBus
  identity: InvitesIdentity
  /** 这个工作区现在有几个人（发现时对外只报这个数，不报名单）。 */
  members(): Promise<{ person_id: PersonId; name: string; email: string }[]>
  /** 岗位模板（27）——`org.ts` 的那一份。 */
  positions(): PositionLike[]
  /** 现在接上了哪些职责连接器 kind（email / shopify / ga4 …）。 */
  connectedKinds(): string[]
  /** 装了哪些技能包。 */
  installedSkills(): string[]
  /** 模型接没接（36 首页那条黄条问的就是它）。 */
  modelConfigured(): boolean
  /** 已连 Shopify 的店（46 I6：连上就自动挂，没连就挂空并在面板明说）。 */
  shopifyStores(): { id: string; label: string }[]
  /** 给了就落盘（`onboarding.sqlite`）；不给就纯内存。 */
  dbDir?: string
  /** 服务进程监听的端口（局域网广播要报它）。 */
  port?: () => number | undefined
  /** 测试注入的假 mDNS；不给就用 `bonjour-service`。 */
  mdns?: MdnsFactory
  /**
   * 同伴的 `/v1/discovery/hello`。默认用 `fetch`；测试注入一个内存实现，
   * 于是"两台机器互相看见"这件事在单元测试里也走得通。
   */
  helloFetch?: (url: string) => Promise<DiscoveryHelloView | undefined>
  /** 往同伴那边发一条请求（申请加入 / 告知失效）；默认 `fetch`，测试注入内存实现。 */
  post?: (url: string, body: unknown) => Promise<{ ok: boolean; data?: unknown }>
}

export interface OnboardingAssembly {
  port: OnboardingPort
  /** 46 §2 I1：这台机器的公司钥匙（没设过档案时是 undefined）。 */
  companyKey(): string | undefined
  discovery: Discovery
  invites: InvitesAssembly
  close(): void
}

export function createOnboarding(options: OnboardingOptions): OnboardingAssembly {
  const { clock, workspace_id, roles, appendEvent } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryProfileBackend()
      : createSqliteProfileBackend(join(options.dbDir, 'onboarding.sqlite'))

  const emit = (type: string, actor: PersonId, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: `tr_onboarding_${clock.now()}` },
      payload,
    })
  }

  const profileOf = (): WorkspaceProfile | undefined => backend.get()
  const keyOf = (): string | undefined => {
    const p = profileOf()
    return p === undefined ? undefined : companyKey(p.legal_name, p.domain)
  }

  /** 对外的展示名："王岚的工作区 · 3 人"。owner 的名字 + 人数，没有名单。 */
  const label = async (): Promise<{ text: string; members: number }> => {
    const members = await options.members()
    const owner = members.find((m) => m.person_id === options.owner)
    const who = owner?.name ?? options.workspaceName()
    return { text: `${who}的工作区 · ${members.length} 人`, members: members.length }
  }

  const discovery = createDiscovery({
    clock,
    workspace_id,
    appendEvent,
    companyKey: keyOf,
    enabled: () => profileOf()?.discoverable === true,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.mdns === undefined ? {} : { mdns: options.mdns }),
    ...(options.helloFetch === undefined ? {} : { helloFetch: options.helloFetch }),
  })

  const invites = createInvites({
    clock,
    random: options.random,
    workspace_id,
    owner: options.owner,
    appendEvent,
    roles,
    approvals: options.approvals,
    identity: options.identity,
    members: options.members,
    companyKey: keyOf,
    peerId: () => discovery.peerId(),
    peerAddress: (id) => discovery.peer(id),
    peerIds: () => discovery.peerIds(),
    ...(options.post === undefined ? {} : { post: options.post }),
    ...(options.dbDir === undefined ? {} : { dbDir: options.dbDir }),
  })

  const viewOf = (p: WorkspaceProfile): WorkspaceProfileView => ({
    legal_name: p.legal_name,
    ...(p.domain === undefined ? {} : { domain: p.domain }),
    discoverable: p.discoverable,
    set_at: p.set_at,
  })

  const activeOf = (person_id: PersonId) =>
    roles.assignments
      .listByPerson(person_id, { workspace_id })
      .filter((a) => a.revoked_at === undefined)

  /**
   * 46 §1 表 ③「勾岗位 = 它包含的职责全勾上」。
   *
   * 展开的是岗位模板里**全部**职责（不只是 `default: true` 的那些）——向导上勾的是
   * "我做这个岗位"，不是"我要这个岗位的默认包"；`applyPosition` 的默认包语义留给
   * 制度页的分配向导（05 §2）。展开结果去重，顺序稳定（岗位序 → 模板内的职责序）。
   */
  function expandRoles(input: OnboardingPlanInput, positions: PositionLike[]): RoleId[] {
    const out: RoleId[] = []
    const seen = new Set<RoleId>()
    const push = (id: RoleId): void => {
      if (seen.has(id)) return
      // 职责定义没加载到这台机器上的不进清单：界面上出现一条点不动的勾比没有它更糟
      if (roles.roles.get(id) === undefined) return
      seen.add(id)
      out.push(id)
    }
    for (const id of input.position_ids) {
      const position = positions.find((p) => p.id === id)
      if (position === undefined) throw new OnboardingError('not_found', `没有这个岗位：${id}`)
      for (const r of position.roles) push(r.role)
    }
    for (const id of input.role_ids) push(id)
    return out
  }

  /** 职责的 `connectors[]` → 连接目录的 provider（46 §3 I5 的那一步归并）。 */
  function providersOf(kind: string): string[] {
    const hits = Object.entries(ROLE_CONNECTOR_KIND)
      .filter(([, k]) => k === kind)
      .map(([service]) => service)
    // 同一个 kind 有多条接法时（邮箱 = 通用 IMAP / Gmail），只推第一条：
    // 目录里通用 IMAP 排在 Gmail 前面，31 §3 说过为什么
    return hits
  }

  function planOf(input: OnboardingPlanInput): OnboardingPlanView {
    const positions = options.positions()
    const roleIds = expandRoles(input, positions)
    const connected = new Set(options.connectedKinds())
    const installed = new Set(options.installedSkills())

    const connectors = new Map<string, OnboardingConnectorItem>()
    const skills = new Map<string, OnboardingSkillItem>()
    for (const id of roleIds) {
      const def = roles.roles.get(id)
      if (def === undefined) continue
      for (const c of def.connectors) {
        // 目录里没有对应 provider 的 kind（tracking / payment_dispute）不进清单——
        // 点进去无处可点的条目就是噪音。等目录里真有它们的那天自然会出现。
        const service = providersOf(c.kind)[0]
        if (service === undefined) continue
        const existing = connectors.get(service)
        if (existing === undefined) {
          connectors.set(service, {
            service,
            label: catalogEntry(service)?.label ?? service,
            required: c.required,
            connected: connected.has(c.kind),
            needed_by: [def.name.zh],
          })
        } else {
          existing.required = existing.required || c.required
          if (!existing.needed_by.includes(def.name.zh)) existing.needed_by.push(def.name.zh)
        }
      }
      for (const s of def.skills) {
        const existing = skills.get(s.name)
        if (existing === undefined)
          skills.set(s.name, {
            name: s.name,
            installed: installed.has(s.name),
            needed_by: [def.name.zh],
          })
        else if (!existing.needed_by.includes(def.name.zh)) existing.needed_by.push(def.name.zh)
      }
    }

    const held = new Set(activeOf(options.owner).map((a) => a.role_id))
    const plannedPositions: OnboardingPositionPlanItem[] = input.position_ids.map((id) => {
      const position = positions.find((p) => p.id === id)
      const ids = (position?.roles ?? [])
        .map((r) => r.role)
        .filter((r) => roles.roles.get(r) !== undefined)
      return {
        position_id: id,
        name: position?.name.zh ?? id,
        role_ids: ids,
        already_held: ids.length > 0 && ids.every((r) => held.has(r)),
      }
    })
    // 46 §3 I6：只勾职责不勾岗位 → 一个"自定义岗位"，名字用户填，默认"我的岗位"
    const extras = input.role_ids.filter(
      (r) => !plannedPositions.some((p) => p.role_ids.includes(r)) && roles.roles.get(r),
    )
    if (extras.length > 0) {
      plannedPositions.push({
        position_id: 'custom',
        name: input.custom_position_name ?? '我的岗位',
        role_ids: extras,
        already_held: extras.every((r) => held.has(r)),
      })
    }

    const model_configured = options.modelConfigured()
    return {
      connectors: [...connectors.values()].sort(
        (a, b) => Number(b.required) - Number(a.required) || a.service.localeCompare(b.service),
      ),
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      positions: plannedPositions,
      model_configured,
      // 模型没接的话清单第一条固定是"接模型"：平台连得再全也没人替你干活
      model_first: !model_configured,
      role_ids: roleIds,
    }
  }

  const port: OnboardingPort = {
    async state(actor) {
      const profile = profileOf()
      const members = await options.members()
      const me = members.find((m) => m.person_id === actor.person_id)
      // 46 §1 末段：向导只出现在"还没设过公司名"的时候；已经有别人的分配了就更不该弹
      const others = roles.assignments
        .listByWorkspace(workspace_id)
        .filter((a) => a.revoked_at === undefined && a.person_id !== options.owner).length
      const runtime = discovery.status()
      return {
        needs_setup: profile === undefined && others === 0,
        workspace_name: options.workspaceName(),
        ...(profile === undefined ? {} : { profile: viewOf(profile) }),
        person: { name: me?.name ?? '', email: me?.email ?? '' },
        other_assignments: others,
        is_owner: actor.person_id === options.owner,
        discovery: {
          available: runtime.available,
          enabled: profile?.discoverable === true,
          ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
        },
      } satisfies OnboardingStateView
    },

    setProfile(actor, input: WorkspaceProfileInput) {
      const legal_name = input.legal_name.trim()
      if (legal_name === '') throw new OnboardingError('invalid_input', '公司全称不能是空的')
      const previous = profileOf()
      const domain = normalizeDomain(input.domain)
      const next: WorkspaceProfile = {
        legal_name,
        ...(domain === '' ? {} : { domain }),
        discoverable: input.discoverable ?? previous?.discoverable ?? true,
        set_at: clock.now(),
      }
      backend.put(next)
      // 21 §5：日志里只有归一化后的哈希与"有没有域名"，**全称不进日志**
      emit('workspace.profile_set', actor.person_id, {
        company_key: companyKey(next.legal_name, next.domain),
        has_domain: next.domain !== undefined,
        discoverable: next.discoverable,
      })
      // 开关变了就真的开 / 关：关掉 = 停广播、停监听、清掉看见过的同伴
      if (previous?.discoverable !== next.discoverable || previous === undefined) {
        if (next.discoverable) discovery.enable(actor.person_id)
        else discovery.disable(actor.person_id)
      } else if (next.discoverable) {
        // 名字改了 → 钥匙变了 → 重新广播（否则还在用旧钥匙找同事）
        discovery.refresh()
      }
      return viewOf(next)
    },

    positions(): OnboardingPositionView[] {
      return options.positions().map((p) => ({
        id: p.id,
        name: p.name.zh,
        roles: p.roles.flatMap((r) => {
          const def = roles.roles.get(r.role)
          return def === undefined
            ? []
            : [
                {
                  id: def.id,
                  name: def.name.zh,
                  default: r.default,
                  // 46 §1 表 ③「每条职责旁有一句'它会干什么'」——就是 05 里的 description
                  what_it_does: def.description,
                },
              ]
        }),
      }))
    },

    plan(_actor, input) {
      return planOf(input)
    },

    apply(actor, input) {
      const plan = planOf(input)
      // 46 §3 I6：连上 Shopify 的店自动挂上；没连就挂空，面板上照 05 §4 明说
      const ranges: RangeRef[] = options
        .shopifyStores()
        .map((s) => ({ kind: 'store' as const, id: s.id }))
      const held = new Map(activeOf(actor.person_id).map((a) => [a.role_id, a]))
      const created: OnboardingApplyView['created_assignments'] = []
      const skipped: string[] = []
      for (const role_id of plan.role_ids) {
        if (held.has(role_id)) {
          skipped.push(role_id)
          continue
        }
        const assignment = roles.assignments.create({
          person_id: actor.person_id,
          workspace_id,
          role_id,
          ranges,
          granted_by: actor.person_id,
        })
        created.push({
          id: assignment.id,
          role_id,
          role_name: roles.roles.get(role_id)?.name.zh ?? role_id,
        })
      }
      return {
        created_assignments: created,
        skipped,
        ranges: ranges.map((r) => ({
          kind: r.kind,
          id: r.id,
          label: options.shopifyStores().find((s) => s.id === r.id)?.label ?? r.id,
        })),
        plan,
      } satisfies OnboardingApplyView
    },

    async peers(_actor): Promise<DiscoveryStateView> {
      return discovery.peers()
    },

    async hello(): Promise<DiscoveryHelloView> {
      const { text, members } = await label()
      return { peer_id: discovery.peerId(), workspace_label: text, members }
    },

    invites(_actor): InviteView[] {
      return invites.list()
    },

    createInvite(actor, input): InviteView {
      return invites.create(actor.person_id, input.uses)
    },

    requests(_actor): MembershipRequestView[] {
      return invites.requests()
    },

    request(input: MembershipRequestInput): Promise<MembershipRequestView> {
      return invites.request(input)
    },

    decideRequest(actor, id, input): Promise<MembershipRequestView> {
      return invites.decide(actor.person_id, id, input)
    },

    superseded(input) {
      return invites.supersede(input)
    },
  }

  return {
    port,
    companyKey: keyOf,
    discovery,
    invites,
    close() {
      discovery.close()
      invites.close()
      backend.close()
    },
  }
}
