/**
 * 邀请码与申请加入（WP51 交付 ⑤，46 §2 I2 第一条渠道 + I3）。
 *
 * 两件事：
 *
 * 1. **邀请码**：owner 发一个 8 位人类可读的码（去掉了 0/O、1/I/L 这些形近字，
 *    因为它多半是念给同事听或抄在便签上的），24 小时有效，默认能用 5 次。
 *    能用 5 次**不等于**5 个人直通——码只是"你可以来敲门"，敲完仍要 owner 批。
 * 2. **申请加入**：贴一个码，或者在局域网上挑一位同伴。目标工作区收到的是一张
 *    `membership` 审批卡（14），同意才建成员。
 *
 * 三条边界：
 *
 * - **申请里只有名字与邮箱**（46 §4）：不带业务数据、不带凭据、不带岗位。
 * - **同意 = 建成员 + 交给 20 §4 的 Join**；拒绝什么都不建。两者都留事件。
 * - **46 I3**：两边互相申请时以先批的为准。这边一批，我们自己那条朝对方的申请
 *   立刻失效，并且**告诉对方**（`supersede`），让对方那条朝我们的也别再等着。
 *
 * 码的存法说清楚：**明文存在本机库里**，与 WP28 的邮件邀请 token（只存 sha256）不同。
 * 理由是它要能再看一眼——owner 关掉页面之后还得把码念给同事听；而它本身不是凭据，
 * 拿着它最多能让对方的队列里多一张卡。事件日志里仍然只有指纹（`code_fp`）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { InviteView, MembershipRequestInput, MembershipRequestView } from '@agentsws/api'
import type {
  ApprovalBus,
  Clock,
  EventEnvelope,
  Invite,
  MembershipRequest,
  MembershipRequestVia,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { RoleStore } from '@agentsws/roles'
import type BetterSqlite3 from 'better-sqlite3'

/**
 * 首次设置这一摊的错误码（网关照 `code` 归一成统一信封，28 §2）。
 *
 * 它住在这个文件里而不是 `onboarding.ts`，是为了让导入图保持无环：
 * `onboarding.ts → invites.ts`，反过来没有边。
 */
export class OnboardingError extends Error {
  readonly code: 'not_found' | 'conflict' | 'invalid_input' | 'forbidden' | 'not_implemented'
  constructor(
    code: 'not_found' | 'conflict' | 'invalid_input' | 'forbidden' | 'not_implemented',
    message: string,
  ) {
    super(message)
    this.name = 'OnboardingError'
    this.code = code
  }
}

/** 24 小时（46 §2 I2）。 */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000
/** 默认能用几次。 */
export const INVITE_DEFAULT_USES = 5
/**
 * 码的字母表：去掉了 0 / O、1 / I / L、以及 U（手写像 V）。
 * 32 个字符 × 8 位 = 40 bit，对一个 24 小时、要人点头才作数的码来说绰绰有余。
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

/** 申请在本机的存法：多一个方向与对方是谁。 */
interface RequestRow extends MembershipRequest {
  /** `inbound` = 别人要进我们这儿；`outbound` = 我们的人要进别人那儿。 */
  direction: 'inbound' | 'outbound'
  /** 局域网上的对方（有的话）。 */
  peer_id?: string
  approval_item_id?: string
}

interface InvitesBackend {
  invites(): Invite[]
  putInvite(i: Invite): void
  requests(): RequestRow[]
  putRequest(r: RequestRow): void
  close(): void
}

function createMemoryBackend(): InvitesBackend {
  const invites = new Map<string, Invite>()
  const requests = new Map<string, RequestRow>()
  return {
    invites: () => [...invites.values()].map((i) => ({ ...i })),
    putInvite: (i) => {
      invites.set(i.code, { ...i })
    },
    requests: () => [...requests.values()].map((r) => structuredClone(r)),
    putRequest: (r) => {
      requests.set(r.id, structuredClone(r))
    },
    close: () => {
      invites.clear()
      requests.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS onboarding_invites (code TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS onboarding_requests (id TEXT PRIMARY KEY, json TEXT NOT NULL);
`

function createSqliteBackend(dbPath: string): InvitesBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const putInvite = db.prepare(
    'INSERT INTO onboarding_invites (code, json) VALUES (?,?) ON CONFLICT(code) DO UPDATE SET json = excluded.json',
  )
  const putRequest = db.prepare(
    'INSERT INTO onboarding_requests (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  )
  return {
    invites: () =>
      (db.prepare('SELECT json FROM onboarding_invites').all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as Invite,
      ),
    putInvite: (i) => {
      putInvite.run(i.code, JSON.stringify(i))
    },
    requests: () =>
      (
        db.prepare('SELECT json FROM onboarding_requests ORDER BY id').all() as { json: string }[]
      ).map((r) => JSON.parse(r.json) as RequestRow),
    putRequest: (r) => {
      putRequest.run(r.id, JSON.stringify(r))
    },
    close: () => {
      db.close()
    },
  }
}

/** 身份服务的最小面（本模块只做这四件事）。 */
export interface InvitesIdentity {
  personByEmail(email: string): { id: PersonId; email: string; name: string } | undefined
  createPerson(input: { email: string; name: string }): Promise<{ id: PersonId }>
  addMember(m: {
    workspace_id: WorkspaceId
    person_id: PersonId
    role: 'owner' | 'manager' | 'member'
    ranges: never[]
  }): Promise<unknown>
}

export interface InvitesOptions {
  clock: Clock
  random: () => number
  workspace_id: WorkspaceId
  owner: PersonId
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  roles: RoleStore
  approvals: ApprovalBus
  identity: InvitesIdentity
  members(): Promise<{ person_id: PersonId; name: string; email: string }[]>
  /** 本机的公司钥匙（局域网那条路要拿它证明"我们是同一家"）。 */
  companyKey(): string | undefined
  /** 这台机器在局域网上的 id。 */
  peerId(): string
  /** 某位同伴的地址。 */
  peerAddress(peer_id: string): { host: string; port: number } | undefined
  /** 现在看得见的全部同伴（贴码时挨个试）。 */
  peerIds(): string[]
  /** 往同伴那边发一条请求；默认 `fetch`，测试注入内存实现。 */
  post?: (url: string, body: unknown) => Promise<{ ok: boolean; data?: unknown }>
  dbDir?: string
}

export interface InvitesAssembly {
  list(): InviteView[]
  create(by: PersonId, uses?: number): InviteView
  requests(): MembershipRequestView[]
  request(input: MembershipRequestInput): Promise<MembershipRequestView>
  decide(
    by: PersonId,
    id: string,
    input: { approve: boolean; reason?: string | undefined },
  ): Promise<MembershipRequestView>
  /** 46 I3：对方说"我这边已经定了"，我们把与他之间还悬着的一律作废。 */
  supersede(input: { peer_id: string; company_key: string; reason?: string | undefined }): {
    voided: number
  }
  close(): void
}

async function defaultPost(url: string, body: unknown): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const parsed: unknown = text === '' ? {} : JSON.parse(text)
    return { ok: res.ok, data: (parsed as { data?: unknown }).data }
  } catch {
    return { ok: false }
  }
}

export function createInvites(options: InvitesOptions): InvitesAssembly {
  const { clock, workspace_id, appendEvent, roles, approvals } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'onboarding.sqlite'))
  const post = options.post ?? defaultPost

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (
    type: string,
    actor: PersonId | 'system',
    payload: Record<string, unknown>,
  ): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: actor === 'system' ? { kind: 'system', id: 'invites' } : { kind: 'person', id: actor },
      // 21 §2：申请可能是**对方机器**发过来的——不在我们这边任何一次请求的 trace 里，
      // 所以自己起一条（网关在请求里调用时，`appendEvent` 会用请求那条覆盖它）。
      correlation: { trace_id: `tr_invite_${clock.now()}` },
      payload,
    })
  }

  /** 码的指纹：日志里只出现它，明文永远不进事件（21 §5）。 */
  const fingerprint = (code: string): string => sha256(code).slice(0, 12)

  const viewOfInvite = (i: Invite, created_at: string): InviteView => ({
    code: i.code,
    expires_at: i.expires_at,
    uses_left: i.uses_left,
    created_at,
  })

  const viewOf = (r: RequestRow): MembershipRequestView => ({
    id: r.id,
    person: { ...r.person },
    via: r.via,
    status: r.status,
    created_at: r.created_at,
    ...(r.decided_at === undefined ? {} : { decided_at: r.decided_at }),
    ...(r.superseded_reason === undefined ? {} : { superseded_reason: r.superseded_reason }),
    ...(r.approval_item_id === undefined ? {} : { approval_item_id: r.approval_item_id }),
  })

  /** 活着的邀请码（没过期、还有次数）。 */
  const liveInvites = (): Invite[] => {
    const now = Date.parse(clock.now())
    return backend.invites().filter((i) => i.uses_left > 0 && Date.parse(i.expires_at) > now)
  }

  /** 本机真收下一条申请（不管它是贴码来的还是局域网来的）。 */
  async function accept(input: {
    name: string
    email: string
    via: MembershipRequestVia
    peer_id?: string
  }): Promise<MembershipRequestView> {
    const now = clock.now()
    const row: RequestRow = {
      id: nextId('mrq'),
      workspace_id,
      person: { name: input.name, email: input.email },
      via: input.via,
      status: 'pending',
      created_at: now,
      direction: 'inbound',
      ...(input.peer_id === undefined ? {} : { peer_id: input.peer_id }),
    }
    // 14：目标工作区的 owner 收一张 membership 卡。**不是通知，是审批项**——
    // 通过后有明确的施行（建成员 + 交给 Join），失败就回到 pending。
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'membership',
      role_id: 'common.owner',
      subject: { object: { type: 'membership_request', id: row.id } },
      dedupe_key: `${workspace_id}:membership:${sha256(input.email.trim().toLowerCase()).slice(0, 16)}`,
      title: `${input.name} 想加入`,
      summary:
        input.via === 'lan'
          ? `${input.name}（${input.email}）在同一个局域网里，公司名算出来和你们一样。同意他就成为成员，之后走一遍合并向导。`
          : `${input.name}（${input.email}）贴了你发的邀请码。同意他就成为成员，之后走一遍合并向导。`,
      payload: {
        request_id: row.id,
        person: { name: input.name, email: input.email },
        via: input.via,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        diff: {
          before: null,
          after: { name: input.name, email: input.email },
          summary: '工作区多一个人',
        },
        precheck: {},
      },
      proposer: { kind: 'system', id: 'invites' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: options.owner, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    if (item.state !== 'blocked') row.approval_item_id = item.id
    backend.putRequest(row)
    // 日志里只有申请 id、渠道与邮箱域名——名字与完整邮箱留在卡里给人看，不进日志
    emit('membership.requested', 'system', {
      request_id: row.id,
      via: row.via,
      email_domain: input.email.split('@')[1] ?? '',
      ...(row.approval_item_id === undefined ? {} : { approval_item_id: row.approval_item_id }),
    })
    return viewOf(row)
  }

  /** 往某位同伴那边转发一条申请（我们的人要进他那儿）。 */
  async function forward(
    peer_id: string,
    body: Record<string, unknown>,
    input: { name: string; email: string },
  ): Promise<MembershipRequestView | undefined> {
    const address = options.peerAddress(peer_id)
    if (address === undefined) return undefined
    const out = await post(`http://${address.host}:${address.port}/v1/memberships/requests`, body)
    if (!out.ok || out.data === undefined) return undefined
    const remote = out.data as MembershipRequestView
    // 我们这边也记一条：46 I3 要知道"我朝谁申请过"，先批的那一方才好让另一条失效
    const row: RequestRow = {
      id: nextId('mrq'),
      workspace_id,
      person: { name: input.name, email: input.email },
      via: 'lan',
      status: 'pending',
      created_at: clock.now(),
      direction: 'outbound',
      peer_id,
    }
    backend.putRequest(row)
    return remote
  }

  return {
    list(): InviteView[] {
      return liveInvites().map((i) =>
        viewOfInvite(i, new Date(Date.parse(i.expires_at) - INVITE_TTL_MS).toISOString()),
      )
    },

    create(by, uses): InviteView {
      let code = ''
      for (let i = 0; i < 8; i += 1)
        code += ALPHABET[Math.floor(options.random() * ALPHABET.length)] ?? 'A'
      const now = clock.now()
      const invite: Invite = {
        code,
        workspace_id,
        created_by: by,
        expires_at: new Date(Date.parse(now) + INVITE_TTL_MS).toISOString(),
        uses_left: uses ?? INVITE_DEFAULT_USES,
      }
      backend.putInvite(invite)
      emit('invite.created', by, { code_fp: fingerprint(code), uses: invite.uses_left })
      return viewOfInvite(invite, now)
    },

    requests(): MembershipRequestView[] {
      return backend
        .requests()
        .filter((r) => r.direction === 'inbound')
        .map(viewOf)
    },

    async request(input): Promise<MembershipRequestView> {
      const name = input.name.trim()
      const email = input.email.trim()
      if (name === '' || email === '')
        throw new OnboardingError('invalid_input', '名字和邮箱都要填')

      // ① 局域网那条路的**收件端**：对方带着同一把公司钥匙找过来
      const withKey = input as MembershipRequestInput & { company_key?: string; from_peer?: string }
      if (withKey.company_key !== undefined) {
        if (withKey.company_key !== options.companyKey())
          throw new OnboardingError('forbidden', '公司对不上，这条申请不属于这个工作区')
        return accept({
          name,
          email,
          via: 'lan',
          ...(withKey.from_peer === undefined ? {} : { peer_id: withKey.from_peer }),
        })
      }

      // ② 贴码：先看是不是我们自己发的码
      if (input.code !== undefined) {
        const code = input.code.trim().toUpperCase()
        const invite = liveInvites().find((i) => i.code === code)
        if (invite !== undefined) {
          backend.putInvite({ ...invite, uses_left: invite.uses_left - 1 })
          emit('invite.redeemed', 'system', {
            code_fp: fingerprint(code),
            uses_left: invite.uses_left - 1,
          })
          return accept({ name, email, via: 'invite' })
        }
        // 不是我们的码 → 挨个问局域网上的同伴（v1 没有云目录，只能这么找）
        for (const peer_id of options.peerIds()) {
          const out = await forward(peer_id, { code, name, email }, { name, email })
          if (out !== undefined) return out
        }
        throw new OnboardingError('not_found', '这个邀请码不对，或者已经过期 / 用完了')
      }

      // ③ 挑了一位局域网同伴：带上我们的公司钥匙去敲他的门
      const peer_id = input.peer_id
      if (peer_id === undefined) throw new OnboardingError('invalid_input', '不知道要加入谁')
      const key = options.companyKey()
      if (key === undefined)
        throw new OnboardingError('invalid_input', '先把公司全称填了，才谈得上找同事')
      const out = await forward(
        peer_id,
        { company_key: key, from_peer: options.peerId(), name, email },
        { name, email },
      )
      if (out === undefined) throw new OnboardingError('not_found', '这位同伴现在联系不上')
      return out
    },

    async decide(by, id, input): Promise<MembershipRequestView> {
      const row = backend.requests().find((r) => r.id === id && r.direction === 'inbound')
      if (row === undefined) throw new OnboardingError('not_found', `没有这条申请：${id}`)
      if (row.status !== 'pending') throw new OnboardingError('conflict', '这条申请已经定过了')
      row.decided_at = clock.now()
      if (!input.approve) {
        row.status = 'rejected'
        backend.putRequest(row)
        emit('membership.rejected', by, {
          request_id: row.id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        return viewOf(row)
      }

      // 同意 = 真建人 + 真建成员 + 一条"工作区成员"职责（20 §1：加入就有它）。
      // 20 §4 的 Join（导入 + 映射确认）是**下一步**：这一步只把人放进来，
      // 品牌 / 产品线 / 店铺范围的对照由 45 的合并向导接着走。
      const existing = options.identity.personByEmail(row.person.email)
      const person_id =
        existing?.id ??
        (await options.identity.createPerson({ email: row.person.email, name: row.person.name })).id
      await options.identity.addMember({
        workspace_id,
        person_id,
        role: 'member',
        ranges: [],
      })
      const MEMBER: RoleId = 'common.member'
      if (roles.roles.get(MEMBER) !== undefined) {
        const held = roles.assignments
          .listByPerson(person_id, { workspace_id })
          .some((a) => a.revoked_at === undefined && a.role_id === MEMBER)
        if (!held)
          roles.assignments.create({
            person_id,
            workspace_id,
            role_id: MEMBER,
            ranges: [],
            granted_by: by,
          })
      }
      row.status = 'approved'
      row.person_id = person_id
      backend.putRequest(row)
      emit('membership.approved', by, {
        request_id: row.id,
        person_id,
        via: row.via,
        // 20 §4：人进来了，接着该走的是 Join 的导入 + 映射确认（45 的合并向导）
        next: 'join_import',
      })

      // 46 I3：我们既然收下了对方的人，我们自己朝他那边的申请就没有意义了——
      // 作废，并且告诉对方一声，免得他那边一直等着。
      const peer_id = row.peer_id
      if (peer_id !== undefined) {
        for (const mine of backend.requests()) {
          if (mine.direction !== 'outbound' || mine.peer_id !== peer_id) continue
          if (mine.status !== 'pending') continue
          mine.status = 'superseded'
          mine.decided_at = clock.now()
          mine.superseded_reason = '你们已经先批了对方的申请，这一条自动失效'
          backend.putRequest(mine)
        }
        const address = options.peerAddress(peer_id)
        const key = options.companyKey()
        if (address !== undefined && key !== undefined) {
          await post(`http://${address.host}:${address.port}/v1/discovery/superseded`, {
            peer_id: options.peerId(),
            company_key: key,
            reason: '对方已经批了你们的申请，这边这条自动失效',
          })
        }
      }
      return viewOf(row)
    },

    supersede(input): { voided: number } {
      if (input.company_key !== options.companyKey()) return { voided: 0 }
      let voided = 0
      for (const row of backend.requests()) {
        if (row.status !== 'pending') continue
        if (row.peer_id !== input.peer_id) continue
        row.status = 'superseded'
        row.decided_at = clock.now()
        row.superseded_reason = input.reason ?? '先批的那一边为准，这一条自动失效'
        backend.putRequest(row)
        voided += 1
      }
      if (voided > 0) emit('membership.rejected', 'system', { superseded: voided })
      return { voided }
    },

    close() {
      backend.close()
    },
  }
}
