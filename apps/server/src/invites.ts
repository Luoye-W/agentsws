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

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  DiscoveryHelloView,
  InviteView,
  JoinPort,
  MembershipClaimRequest,
  MembershipRequestInput,
  MembershipRequestView,
  TeamJoinView,
} from '@agentsws/api'
import type {
  ApprovalBus,
  Clock,
  EventEnvelope,
  Invite,
  JoinExportBundle,
  MembershipClaimView,
  MembershipRequest,
  MembershipRequestVia,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { isPlaceholderOwnerEmail, TEAM_OFF_HEADER } from '@agentsws/contracts'
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
/**
 * 新同事的**个人工作区 id**。
 *
 * 46 §4 定死了申请里只有名字与邮箱——业务数据、凭据、岗位一个都不带，所以这会儿
 * 我们并不知道他那台机器上的工作区叫什么。批准的这一刻要建的是一张**空的对照卡**：
 * "人进来了，他的品牌 / 产品线 / 店铺还没并进来"。等他从自己那台机器
 * `POST /v1/join/export` → `import` 真包过来时，卡上就有东西了。
 *
 * 派生而不是随机：同一个人两次批准落到同一个 `join_id`，卡也就是同一张（去重键稳定）。
 */
export const personalWorkspaceIdOf = (person_id: PersonId): WorkspaceId =>
  `ws_personal_${person_id}`

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

/** 申请在本机的存法：多一个方向与对方是谁。 */
interface RequestRow extends MembershipRequest {
  /** `inbound` = 别人要进我们这儿；`outbound` = 我们的人要进别人那儿。 */
  direction: 'inbound' | 'outbound'
  /** 局域网上的对方（有的话）。 */
  peer_id?: string
  approval_item_id?: string
  /** WP427（inbound）：申请人那台机器发的票的哈希——批了之后拿票来换一次性登录。 */
  ticket_hash?: string
  /**
   * WP427（outbound）：递到哪儿去了、对方那边的申请 id、我们这张票本身（只在本机库里，
   * 不进任何视图与日志）、对方自报的展示名、走的哪条路。
   */
  remote?: {
    base: string
    request_id: string
    ticket: string
    label?: string
    via: 'lan' | 'cloud'
    /** 最近一次问到的状态。 */
    status?: TeamJoinView['status']
  }
}

/** WP427：本机身份是占位邮箱（没关联工坊账号）的申请人，在这边建人时换一个只在这边用的地址。 */
export const COLLEAGUE_EMAIL_DOMAIN = 'colleague.localhost'

/** 这个邮箱是不是本机造的、不能拿去发信的那种（占位 / 同事替身）。 */
export function isLocalOnlyEmail(email: string | undefined): boolean {
  return (
    email !== undefined &&
    (isPlaceholderOwnerEmail(email) ||
      email.trim().toLowerCase().endsWith(`@${COLLEAGUE_EMAIL_DOMAIN}`))
  )
}

const ticketHashOf = (ticket: string): string => sha256(ticket)

const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
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
  post?: (
    url: string,
    body: unknown,
  ) => Promise<{ ok: boolean; data?: unknown; status?: number; message?: string; off?: string }>
  /**
   * 20 §4 的 Join 入口（WP50）。**懒取**：Join 装在 onboarding 之后，
   * 直接传值会拿到 undefined；这里在 `decide` 那一刻才去要它。
   *
   * 不装配时走兜底（只记一条 `next: 'join_import'` 的事件，与 WP51 原样）。
   */
  join?: () => JoinPort | undefined
  /**
   * WP276（docs/95 §3.3，决策 237）：这个品牌现在是哪种用法。不是 ③ 时申请卡说「想一起用」
   * （不是「加入公司 / 成为成员」），同意之后不出空的并进来对照卡（两边各建了同一个品牌才出）。
   * 不给 = 老样子（按 ③ 说）。
   */
  mode?: () => Promise<'solo' | 'peers' | 'company'>
  dbDir?: string
  /**
   * WP427：本机、局域网里都找不到的码，问工坊云这是哪条通道的（回通道地址）。不给 = 不问云。
   */
  resolveCode?: (code: string) => Promise<string | undefined>
  /** WP427：新发了一个码（登记到云上，不在同一个网络的同事才贴得进来）。 */
  onInviteCreated?: (code: string, expires_at: string) => void
  /** WP427：给某个人签一张一次性登录（申请人拿票来换）。 */
  issueLogin?: (person_id: PersonId) => Promise<{ token: string; expires_at: string } | undefined>
  /** WP427：问对方「你是谁」（拿展示名）。默认 `fetch`。 */
  hello?: (base: string) => Promise<DiscoveryHelloView | undefined>
  /** WP427：我们自己的展示名（申请人拿票来问时一起回）。 */
  selfLabel?: () => Promise<string>
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
  /** WP427 公开：申请人拿票来问批了没有（批了可以换一次性登录）。票不对一律 not_found。 */
  claim(id: string, input: MembershipClaimRequest): Promise<MembershipClaimView>
  /** WP427：我递出去的申请（顺手问一遍对方）。 */
  joins(): Promise<TeamJoinView[]>
  /** WP427：批了的那一条：带一次性登录的地址。 */
  enter(id: string): Promise<{ url: string }>
  close(): void
}

async function defaultPost(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; data?: unknown; status?: number; message?: string; off?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let parsed: { data?: unknown; message?: unknown } = {}
    try {
      parsed = text === '' ? {} : (JSON.parse(text) as typeof parsed)
    } catch {
      parsed = {}
    }
    // WP444：经云的通道地址回 503 时带一个头说为什么（对方的团队通道没开通 / 已到期、不在线、被停用）
    const off = res.headers.get(TEAM_OFF_HEADER)
    return {
      ok: res.ok,
      status: res.status,
      data: parsed.data,
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
      ...(off === null ? {} : { off }),
    }
  } catch {
    return { ok: false }
  }
}

async function defaultHello(base: string): Promise<DiscoveryHelloView | undefined> {
  try {
    const res = await fetch(`${base}/v1/discovery/hello`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return undefined
    return ((await res.json()) as { data?: DiscoveryHelloView }).data
  } catch {
    return undefined
  }
}

export function createInvites(options: InvitesOptions): InvitesAssembly {
  const { clock, workspace_id, appendEvent, roles, approvals } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'onboarding.sqlite'))
  const post = options.post ?? defaultPost
  const hello = options.hello ?? defaultHello

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
    ...(r.decided_by === undefined ? {} : { decided_by: r.decided_by }),
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
    ticket_hash?: string
  }): Promise<MembershipRequestView> {
    /*
     * WP427：申请里的邮箱如果已经是这里的人（含负责人自己），不收——申请人没证明过这个邮箱是他的，
     * 批了就等于把那个人的身份交出去（拿票换登录换到的是他）。本机占位邮箱（没关联账号）不算：
     * 批的时候在这边给他另建一个人。
     */
    if (!isLocalOnlyEmail(input.email)) {
      const here = (await options.members()).some(
        (m) => m.email.trim().toLowerCase() === input.email.trim().toLowerCase(),
      )
      if (here)
        throw new OnboardingError(
          'conflict',
          '这个邮箱已经在对方那边了——直接用工坊账号登录进去就行，不用再申请。',
        )
    }
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
      ...(input.ticket_hash === undefined ? {} : { ticket_hash: input.ticket_hash }),
    }
    // 14：目标工作区的 owner 收一张 membership 卡。**不是通知，是审批项**——
    // 通过后有明确的施行（建成员 + 交给 Join），失败就回到 pending。
    const who = isPlaceholderOwnerEmail(input.email)
      ? input.name
      : `${input.name}（${input.email}）`
    // WP276：① ② 里申请的是「一起用」，不是「加入公司」
    const together = ((await options.mode?.()) ?? 'company') !== 'company'
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'membership',
      role_id: 'common.owner',
      subject: { object: { type: 'membership_request', id: row.id } },
      dedupe_key: `${workspace_id}:membership:${sha256(input.email.trim().toLowerCase()).slice(0, 16)}`,
      title: together ? `${input.name} 想和你们一起用` : `${input.name} 想加入`,
      // WP233：对方本机的占位邮箱（owner@localhost）不进卡面，只说名字
      summary: together
        ? input.via === 'lan'
          ? `${who}在同一个局域网里。同意了就能一起用这个品牌。`
          : `${who}贴了邀请码。同意了就能一起用这个品牌。`
        : input.via === 'lan'
          ? `${who}在同一个局域网里，公司名算出来和你们一样。同意他就成为成员，之后走一遍合并向导。`
          : `${who}贴了你发的邀请码。同意他就成为成员，之后走一遍合并向导。`,
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

  /** 申请那张卡还开着就收掉（定过了 / 没了就算了）。 */
  async function retireCard(id: string | undefined, by: PersonId): Promise<void> {
    if (id === undefined || typeof approvals.get !== 'function') return
    const card = await approvals.get(id)
    if (card === undefined || (card.state !== 'pending' && card.state !== 'in_review')) return
    try {
      await approvals.withdraw(id, by)
    } catch {
      // 收不掉不影响申请本身
    }
  }

  /**
   * 往别人那边递一条申请（我们的人要进他那儿）：局域网上的同伴、或者经云查到的通道地址。
   *
   * WP427：顺手发一张「票」——对方只拿到票的哈希；批了之后我们拿票本身去换一次性登录，
   * 用不着邮箱验证码，也用不着工坊账号。票只存在本机库里，不进任何视图与日志。
   */
  async function forwardTo(
    base: string,
    body: Record<string, unknown>,
    input: { name: string; email: string },
    meta: { via: 'lan' | 'cloud'; peer_id?: string },
  ): Promise<MembershipRequestView | undefined> {
    const ticket = randomBytes(24).toString('base64url')
    const out = await post(`${base}/v1/memberships/requests`, {
      ...body,
      ticket_hash: ticketHashOf(ticket),
    })
    if (!out.ok || out.data === undefined) {
      // WP444：经云的那条路被关了——对方的团队通道没开通 / 已到期（不是「连不上」）
      if (out.status === 503 && out.off === 'subscription')
        throw new OnboardingError(
          'conflict',
          '对方的团队通道未开通或已到期，不在同一个网络时暂时递不过去。请对方开通；同一个网络里照常能用。',
        )
      // 对方明说不收（邮箱已经在那边了 / 公司对不上）：把那句话原样告诉申请人
      if (out.status === 409 || out.status === 403)
        throw new OnboardingError(
          out.status === 409 ? 'conflict' : 'forbidden',
          out.message ?? '对方没收这条申请',
        )
      return undefined
    }
    const remote = out.data as MembershipRequestView
    const said = await hello(base).catch(() => undefined)
    // 我们这边也记一条：46 I3 要知道"我朝谁申请过"，先批的那一方才好让另一条失效
    const row: RequestRow = {
      id: nextId('mrq'),
      workspace_id,
      person: { name: input.name, email: input.email },
      via: meta.via === 'lan' ? 'lan' : 'invite',
      status: 'pending',
      created_at: clock.now(),
      direction: 'outbound',
      ...(meta.peer_id === undefined ? {} : { peer_id: meta.peer_id }),
      remote: {
        base,
        request_id: remote.id,
        ticket,
        via: meta.via,
        ...(said?.workspace_label === undefined ? {} : { label: said.workspace_label }),
      },
    }
    backend.putRequest(row)
    return remote
  }

  /** 往某位局域网同伴那边递。 */
  async function forward(
    peer_id: string,
    body: Record<string, unknown>,
    input: { name: string; email: string },
  ): Promise<MembershipRequestView | undefined> {
    const address = options.peerAddress(peer_id)
    if (address === undefined) return undefined
    return forwardTo(`http://${address.host}:${address.port}`, body, input, { via: 'lan', peer_id })
  }

  /** 问对方那边：我这条批了没有（`login` = 批了就顺手换一张一次性登录）。 */
  async function ask(
    row: RequestRow,
    login: boolean,
  ): Promise<MembershipClaimView | 'unreachable' | 'channel_off' | 'gone'> {
    const remote = row.remote
    if (remote === undefined) return 'gone'
    const out = await post(
      `${remote.base}/v1/memberships/requests/${encodeURIComponent(remote.request_id)}/claim`,
      { ticket: remote.ticket, login },
    )
    if (!out.ok && out.status === 503 && out.off === 'subscription') return 'channel_off'
    if (!out.ok) return out.status === undefined || out.status >= 500 ? 'unreachable' : 'gone'
    return out.data as MembershipClaimView
  }

  const joinViewOf = (r: RequestRow): TeamJoinView => {
    const status: TeamJoinView['status'] = r.remote?.status ?? r.status
    return {
      id: r.id,
      workspace_label: r.remote?.label ?? '对方的工作区',
      status,
      via: r.remote?.via ?? 'lan',
      created_at: r.created_at,
      can_enter: status === 'approved',
    }
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
      // WP427：登记到云上（不在同一个网络的同事贴码时，靠云查到是这边）
      options.onInviteCreated?.(code, invite.expires_at)
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
      // WP427：门外来的（别的电脑）只收、不转；经云来的只认邀请码（公司钥匙是公司名的哈希，猜得出来）
      const door = input.via_door
      if (door === 'cloud' && input.code === undefined)
        throw new OnboardingError('not_found', '这个邀请码不对，或者已经过期 / 用完了')
      if (withKey.company_key !== undefined) {
        if (withKey.company_key !== options.companyKey())
          throw new OnboardingError('forbidden', '公司对不上，这条申请不属于这个工作区')
        return accept({
          name,
          email,
          via: 'lan',
          ...(withKey.from_peer === undefined ? {} : { peer_id: withKey.from_peer }),
          ...(input.ticket_hash === undefined ? {} : { ticket_hash: input.ticket_hash }),
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
          return accept({
            name,
            email,
            via: 'invite',
            ...(input.ticket_hash === undefined ? {} : { ticket_hash: input.ticket_hash }),
          })
        }
        // 门外来的：不是我们的码就到此为止（不替别的电脑去问局域网、问云）
        if (door !== undefined)
          throw new OnboardingError('not_found', '这个邀请码不对，或者已经过期 / 用完了')
        // 不是我们的码 → 挨个问局域网上的同伴（同一个网络时的快路）
        for (const peer_id of options.peerIds()) {
          const out = await forward(peer_id, { code, name, email }, { name, email })
          if (out !== undefined) return out
        }
        // WP427：局域网里也没有 → 问工坊云这是谁的码（对方可能在另一个网络里）
        const base = await options.resolveCode?.(code).catch(() => undefined)
        if (base !== undefined) {
          const out = await forwardTo(
            base,
            { code, name, email },
            { name, email },
            { via: 'cloud' },
          )
          if (out !== undefined) return out
          throw new OnboardingError(
            'not_found',
            '找到了发码的人，但他的电脑这会儿连不上，等一会儿再试',
          )
        }
        throw new OnboardingError('not_found', '这个邀请码不对，或者已经过期 / 用完了')
      }

      // ③ 挑了一位局域网同伴：带上我们的公司钥匙去敲他的门（门外来的不替他敲）
      if (door !== undefined) throw new OnboardingError('invalid_input', '不知道要加入谁')
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
      row.decided_by = by
      // WP276：在团队页上定的——队列里那张卡也收掉（卡上点的那一路，卡已经是定了的）
      await retireCard(row.approval_item_id, by)
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
      /*
       * WP427：申请人那台机器没关联工坊账号时，递过来的是本机占位邮箱（owner@localhost）——
       * 这边的负责人多半也是这个占位邮箱。按邮箱找人会找到负责人自己（于是「批了」等于把负责人的
       * 身份交出去）。占位的一律在这边另建一个人，邮箱换成只在这边用的地址。
       * 真邮箱：已经是这里的在职成员就不收（申请人没证明过邮箱是他的）；以前来过又走了的照旧复用。
       */
      const localOnly = isLocalOnlyEmail(row.person.email)
      const existing = localOnly ? undefined : options.identity.personByEmail(row.person.email)
      if (
        existing !== undefined &&
        (await options.members()).some((m) => m.person_id === existing.id)
      )
        throw new OnboardingError('conflict', '这个邮箱已经在这里了，不用再批。')
      const person_id =
        existing?.id ??
        (
          await options.identity.createPerson({
            email: localOnly
              ? `peer-${randomBytes(5).toString('hex')}@${COLLEAGUE_EMAIL_DOMAIN}`
              : row.person.email,
            name: row.person.name,
          })
        ).id
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

      /*
       * 20 §4：人进来了，接着该走的是 Join 的导入 + 映射确认（45 的合并向导）。
       *
       * WP51 时这里只记了一句 `next: 'join_import'`——没人接得住它，owner 的队列里
       * 什么都没有，"接着该走"就只是一句话。WP52 把它接上：**真调 WP50 的
       * `join.import`**，owner 当场收到一张 `join_mapping` 卡。
       *
       * 包是空的（46 §4：申请里只有名字与邮箱，我们还不知道他那边有什么），
       * 所以这张卡此刻的意思是"该把他的个人工作区并进来了"。他从自己那台机器导出
       * 真包再 import 时，`join_id` 由 (源工作区, 公司工作区, 人) 派生、去重键稳定，
       * 落到的还是这一张卡——不会变成两张。
       *
       * Join 没装配、或者建卡失败：退回 WP51 的老路（只记事件）。
       * **人已经建好了，不能因为一张卡没建成就把批准回滚。**
       */
      // WP276：① ② 不出空的并进来对照卡（他那边的东西整个挂进来；两边各建了同一个品牌才出对照表）
      const port =
        ((await options.mode?.()) ?? 'company') === 'company' ? options.join?.() : undefined
      let joined: { join_id: string; approval_item_id: string } | undefined
      let joinFailed: string | undefined
      if (port !== undefined) {
        const source = personalWorkspaceIdOf(person_id)
        const bundle: JoinExportBundle = {
          schema_version: 1,
          workspace_id: source,
          person_id,
          exported_at: row.decided_at ?? clock.now(),
          range_groups: [],
          product_lines: [],
          store_ranges: [],
          connections: [],
        }
        try {
          const receipt = await port.import(
            {
              workspace_id,
              person_id: by,
              assignment_id: 'onboarding',
              role_id: 'common.owner',
            },
            bundle,
          )
          joined = { join_id: receipt.join_id, approval_item_id: receipt.approval_item_id }
        } catch (e) {
          joinFailed = e instanceof Error ? e.message : String(e)
        }
      }

      backend.putRequest(row)
      emit('membership.approved', by, {
        request_id: row.id,
        person_id,
        via: row.via,
        next: 'join_import',
        ...(joined === undefined
          ? {}
          : { join_id: joined.join_id, join_approval_item_id: joined.approval_item_id }),
        ...(joinFailed === undefined ? {} : { join_error: joinFailed }),
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

    async claim(id, input): Promise<MembershipClaimView> {
      const row = backend.requests().find((r) => r.id === id && r.direction === 'inbound')
      // 票不对、没这条、没带票的老申请：一律同一句（不说有没有这条）
      if (
        row === undefined ||
        row.ticket_hash === undefined ||
        !sameHash(row.ticket_hash, ticketHashOf(input.ticket))
      )
        throw new OnboardingError('not_found', '没有这条申请')
      const label = await options.selfLabel?.().catch(() => undefined)
      const base = label === undefined ? {} : { workspace_label: label }
      if (row.status !== 'approved' || row.person_id === undefined)
        return { status: row.status, ...base }
      const person_id = row.person_id
      // 批过、后来又走了（退出 / 被请离开）：票不再换得到登录
      if (!(await options.members()).some((m) => m.person_id === person_id))
        return { status: 'left', ...base }
      if (input.login !== true || options.issueLogin === undefined)
        return { status: 'approved', ...base }
      const issued = await options.issueLogin(person_id)
      if (issued === undefined) return { status: 'approved', ...base }
      emit('membership.claimed', 'system', { request_id: row.id })
      return {
        status: 'approved',
        ...base,
        login_token: issued.token,
        expires_at: issued.expires_at,
      }
    },

    async joins(): Promise<TeamJoinView[]> {
      const rows = backend
        .requests()
        .filter((r) => r.direction === 'outbound' && r.remote !== undefined)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
      await Promise.all(
        rows.map(async (row) => {
          const remote = row.remote
          if (remote === undefined) return
          // 定了的（不收 / 失效）不用再问
          if (remote.status === 'rejected' || remote.status === 'superseded') return
          const said = await ask(row, false)
          const status: TeamJoinView['status'] =
            said === 'channel_off'
              ? 'channel_off'
              : said === 'unreachable'
                ? remote.status === 'approved'
                  ? 'approved'
                  : 'unreachable'
                : said === 'gone'
                  ? 'rejected'
                  : said.status
          const label = typeof said === 'object' ? said.workspace_label : undefined
          const next: RequestRow = {
            ...row,
            ...(status === 'approved' || status === 'rejected' || status === 'superseded'
              ? { status: status === 'approved' ? 'approved' : status }
              : {}),
            remote: { ...remote, status, ...(label === undefined ? {} : { label }) },
          }
          backend.putRequest(next)
          Object.assign(row, next)
        }),
      )
      return rows.map(joinViewOf)
    },

    async enter(id): Promise<{ url: string }> {
      const row = backend
        .requests()
        .find((r) => r.id === id && r.direction === 'outbound' && r.remote !== undefined)
      if (row?.remote === undefined) throw new OnboardingError('not_found', `没有这条申请：${id}`)
      const said = await ask(row, true)
      if (said === 'channel_off')
        throw new OnboardingError(
          'conflict',
          '对方的团队通道未开通或已到期，不在同一个网络时暂时进不去。请对方开通；同一个网络里照常能用。',
        )
      if (said === 'unreachable')
        throw new OnboardingError('not_found', '对方的电脑这会儿连不上（工坊没开，或者睡着了）')
      if (said === 'gone' || said.status !== 'approved' || said.login_token === undefined)
        throw new OnboardingError(
          'conflict',
          said !== 'gone' && said.status === 'pending'
            ? '对方还没同意'
            : said !== 'gone' && said.status === 'left'
              ? '你已经不在对方那边了'
              : '对方没同意这条申请',
        )
      // 决策 942 的同一个口子：一次性 token 放在 # 后面（不发给服务端、不进访问日志），工作台落地就抹掉
      return { url: `${row.remote.base}/#agentsws-enter=${encodeURIComponent(said.login_token)}` }
    },

    close() {
      backend.close()
    },
  }
}
