/**
 * WP276（docs/95 §1 / §5 / §6.2，决策 237 / 243 / 274）：② 同事互联的几样装配。
 *
 * 1. **没主人的卡发给用到它的人**（决策 274 第 1 条）：AI / 系统提的、按老规矩发给所有者的卡
 *    （工具箱晋升、内容更新、插件升级、并进来对照表、有人申请加入），在 ② 里改发给做这条职责的
 *    那几个人——那条职责是底座（`common.*`）或没人做，就发给品牌里每个人。谁先点算谁的
 *    （审批总线本来就是「一张卡几个收件人，第一个决定的作数」）。① ③ 一个字节不动。
 * 2. **改了共用的东西给同事一张「知道了 / 撤回」**（决策 243、274 第 2 / 4 条）：形状与 WP275 改
 *    职责规矩那张一样（`policy_change`、`form: 'peer_change_notice'`），撤回要的东西放在卡上
 *    （`payload.undo`）；有人选「撤回」，按 `target` 找登记过的撤回办法执行。
 * 3. **连接谁接的谁管**（docs/95 §2.1）：② 里每人都能进连接页、接自己的连接；断开 / 重试一条
 *    连接只有接它的人（或发起人）能做。记「谁接的」只是一张 id → 人的小表，凭据一个字节不碰。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConnectionsActor, ConnectionsPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  ApprovalKind,
  CreateApprovalInput,
  OrganizationMode,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'

// ── 1. 没主人的卡 ──────────────────────────────────────────────────────

/** 这几种卡在 ③ 里「发给所有者」只是因为没有更合适的人；② 里改发给用到它的人。 */
export const OWNERLESS_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  'skill_promotion',
  'content_update',
  'content_conflict',
  'official_plugin',
  'app_install',
  'app_upgrade',
  'app_uninstall',
  'upstream_upgrade',
  'join_mapping',
  'membership',
  'policy_change',
] as ApprovalKind[])

export interface PeersRoutingOptions {
  /** 这个品牌现在是哪种用法（读不到按 ③，一个字节不动）。 */
  modeOf(workspace_id: WorkspaceId): Promise<OrganizationMode>
  /** 在做这条职责的人（这个品牌、没撤销）。 */
  holdersOf(workspace_id: WorkspaceId, role_id: RoleId): PersonId[]
  /** 品牌里还在的人。 */
  members(workspace_id: WorkspaceId): Promise<PersonId[]>
}

/** 「发给所有者、而且不是哪个人自己提的」——这张卡没有真正的主人。 */
function ownerless(input: CreateApprovalInput<unknown>): boolean {
  if (!OWNERLESS_KINDS.has(input.kind)) return false
  if (input.proposer.kind === 'person') return false
  const r = input.routing.recipients
  return r.length === 1 && r[0]?.via === 'owner'
}

/**
 * 审批总线外面套一层：② 里没主人的卡改发给用到它的人。用 Proxy（总线是类实例，方法在原型上）。
 */
export function peersRouting<B extends ApprovalBus>(bus: B, options: PeersRoutingOptions): B {
  return new Proxy(bus, {
    get(target, prop, receiver) {
      if (prop !== 'create') {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async <P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>> => {
        if (!ownerless(input as CreateApprovalInput<unknown>))
          return target.create(input) as Promise<ApprovalItem<P>>
        if ((await options.modeOf(input.workspace_id)) !== 'peers')
          return target.create(input) as Promise<ApprovalItem<P>>
        const holders = input.role_id.startsWith('common.')
          ? []
          : options.holdersOf(input.workspace_id, input.role_id)
        const people = [
          ...new Set(holders.length > 0 ? holders : await options.members(input.workspace_id)),
        ].sort()
        if (people.length === 0) return target.create(input) as Promise<ApprovalItem<P>>
        return target.create({
          ...input,
          routing: {
            ...input.routing,
            // 谁先点算谁的：几个收件人，第一个决定的作数；② 没有升级链
            recipients: people.map((person) => ({ person, via: 'role_holder' as const })),
            rule: 'role_holder',
            escalation: { ...input.routing.escalation, chain: [] },
          },
        }) as Promise<ApprovalItem<P>>
      }
    },
  })
}

// ── 2. 「知道了 / 撤回」通知 ─────────────────────────────────────────────

/** 撤回要的东西（放在卡上，`target` 决定谁来执行）。 */
export interface PeerUndo {
  target: string
  [key: string]: unknown
}

export async function notifyPeers(
  approvals: ApprovalBus,
  input: {
    workspace_id: WorkspaceId
    by: PersonId
    by_name: string
    /** 收通知的人（发起改动的本人会被去掉）。 */
    to: readonly PersonId[]
    role_id: RoleId
    /** 「改了 X」里的 X（人话）。 */
    what: string
    /** 卡的对象（去重用）。 */
    object: { type: string; id: string }
    before: unknown
    after: unknown
    undo: PeerUndo
    at: string
  },
): Promise<ApprovalItem | undefined> {
  const people = [...new Set(input.to)].filter((p) => p !== input.by).sort()
  if (people.length === 0) return undefined
  const item = (await approvals.create({
    workspace_id: input.workspace_id,
    schema_version: 1,
    kind: 'policy_change',
    role_id: input.role_id,
    subject: { object: input.object },
    dedupe_key: `${input.workspace_id}:peer_undo:${input.undo.target}:${input.object.id}:${input.at}`,
    title: `${input.by_name}改了${input.what}（已生效）`,
    summary: `${input.by_name}自己改的，已经生效。觉得不对可以撤回。`,
    payload: {
      target: input.undo.target,
      form: 'peer_change_notice',
      changed_by: input.by,
      options: [
        { id: 'after', label: '知道了' },
        { id: 'before', label: '撤回' },
      ],
      before: input.before,
      after: input.after,
      undo: input.undo,
    },
    evidence: {
      source_events: [],
      diff: { before: input.before, after: input.after, summary: input.what },
      provenance: { seen: [] },
      precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
    },
    proposer: { kind: 'person', id: input.by },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: people.map((person) => ({ person, via: 'role_holder' as const })),
      rule: 'role_holder',
      escalation: { after_hours: 48, business_hours: true, chain: [], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'digest',
  })) as ApprovalItem
  return item.state === 'blocked' ? undefined : item
}

/** 这张卡带着撤回的办法（不是 WP275 org.ts 那种自己记着「改之前」的）。 */
export function peerUndoOf(item: ApprovalItem): PeerUndo | undefined {
  if (item.kind !== 'policy_change') return undefined
  const p = item.payload as { form?: unknown; undo?: unknown } | undefined
  if (p?.form !== 'peer_change_notice') return undefined
  const undo = p.undo as PeerUndo | undefined
  return undo !== undefined && typeof undo.target === 'string' ? undo : undefined
}

/** 选的是「撤回」（与策略变更卡同一个 `before` 口径）。 */
export function choseUndo(item: ApprovalItem): boolean {
  if (item.state !== 'approved_edited' && item.state !== 'approved' && item.state !== 'applied')
    return false
  const edited = item.decision?.edited_payload as { selected_option_id?: unknown } | undefined
  return (item.decision?.selected_option_id ?? edited?.selected_option_id) === 'before'
}

// ── 3. 连接谁接的谁管 ──────────────────────────────────────────────────

export interface ConnectionOwners {
  of(connection_id: string): PersonId | undefined
  set(connection_id: string, person: PersonId): void
  drop(connection_id: string): void
}

/** 给了路径就落盘（品牌目录下 `connection-owners.json`），没给就是内存档。 */
export function createConnectionOwners(file?: string): ConnectionOwners {
  let map: Record<string, PersonId> = {}
  if (file !== undefined && existsSync(file)) {
    try {
      map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, PersonId>
    } catch {
      map = {}
    }
  }
  const save = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  }
  return {
    of: (id) => map[id],
    set: (id, person) => {
      map = { ...map, [id]: person }
      save()
    },
    drop: (id) => {
      const { [id]: _gone, ...rest } = map
      map = rest
      save()
    },
  }
}

/**
 * 连接面外面套一层：记下每条连接是谁接的；② 里断开 / 重试别人接的连接回 403
 * （「谁接的谁管」，发起人例外——他管家务）。① ③ 只记不拦。
 */
export function withConnectionOwners(
  port: ConnectionsPort,
  options: {
    owners: ConnectionOwners
    mode(workspace_id: WorkspaceId): OrganizationMode | undefined
    initiator(workspace_id: WorkspaceId): PersonId | undefined
  },
): ConnectionsPort {
  const guard = (actor: ConnectionsActor, id: string): void => {
    if (options.mode(actor.workspace_id) !== 'peers') return
    const who = options.owners.of(id)
    if (who === undefined || who === actor.person_id) return
    if (options.initiator(actor.workspace_id) === actor.person_id) return
    throw new ApiError('forbidden', '这条连接是同事接的，谁接的谁管')
  }
  const overrides: Partial<ConnectionsPort> = {
    async submit(actor, service, input) {
      const out = await port.submit(actor, service, input)
      options.owners.set(out.connection.id, actor.person_id)
      return out
    },
    async pollRequest(actor, request_id) {
      const out = await port.pollRequest(actor, request_id)
      if (out.connection !== undefined && options.owners.of(out.connection.id) === undefined)
        options.owners.set(out.connection.id, actor.person_id)
      return out
    },
    async remove(actor, id) {
      guard(actor, id)
      await port.remove(actor, id)
      options.owners.drop(id)
    },
    async test(actor, id) {
      guard(actor, id)
      return port.test(actor, id)
    },
  }
  // 连接面是按品牌现取的 Proxy（展开拿不到方法），所以这里也用 Proxy：只截这四个，其余原样转
  return new Proxy(port, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides)
        return (overrides as Record<string, unknown>)[prop]
      return Reflect.get(target, prop, receiver)
    },
  })
}
