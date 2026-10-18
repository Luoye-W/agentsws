/**
 * WP406 测试的替身：现生成的官方钥匙、按需打包的内容包、云上订阅与下载那几条路、一条最小的审批总线、
 * 公司改的角色定位那一层、职责定义表。不联网、不花钱。
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalItem,
  ContentItem,
  ContentManifest,
  ContentSubscriptionView,
  DecideInput,
  PersonaOverride,
  PersonaSubject,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  CONTENT_SUBSCRIPTION_PATH,
  OFFICIAL_CONTENT_PATHS,
  summarizeOfficialContent,
} from '@agentsws/contracts'
import { registerContentTableProvider } from '@agentsws/core'
import {
  bundledContentFiles,
  loadBundledRoleWithContent,
  type RoleDefinitionFull,
} from '@agentsws/roles'
import {
  type BuiltContentPack,
  buildContentPack,
  type ContentItemMeta,
  contentPublicKeyOf,
  createSkills,
} from '@agentsws/skills'
import {
  createOfficialContent,
  type OfficialContent,
  type OfficialContentOptions,
  type OfficialPosition,
} from '../src/official-content.js'

export const WS = 'ws_brand' as WorkspaceId
export const OWNER = 'per_owner' as PersonId
export const SUPERVISOR = 'per_sup' as PersonId
export const MEMBER = 'per_member' as PersonId
export const ROLE = 'dtc.store' as RoleId
export const POSITION = 'web-ops'

export function officialKeys() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { pem, pub: contentPublicKeyOf(pem) }
}

export const bundledStore = () => {
  const c = bundledContentFiles().roles.find((r) => r.id === ROLE)
  if (c === undefined) throw new Error('no bundled dtc.store')
  return c.content
}

/** 包里的中文角色定位换掉某一段的正文。 */
export function personaWith(section: string, body: string): string {
  const zh = String(
    typeof bundledStore().persona === 'string'
      ? bundledStore().persona
      : (bundledStore().persona as { zh: string }).zh,
  )
  const lines = zh.split('\n')
  const at = lines.findIndex((l) => l.startsWith(`${section}：`))
  if (at < 0) throw new Error(`no section ${section}`)
  lines[at] = `${section}：${body}`
  return lines.join('\n')
}

export interface ItemSpec {
  kind: ContentItem['kind']
  name: string
  version: string
  files: Record<string, string>
  title?: string
  positions?: string[]
  urgent?: boolean
  released_at?: string
}

const meta = (s: ItemSpec): ContentItemMeta => ({
  id: `${s.kind}:${s.name}`,
  kind: s.kind,
  name: s.name,
  version: s.version,
  title: { zh: s.title ?? `${s.name} 更新`, en: `${s.name} update` },
  summary: { zh: `${s.name} 改了几处`, en: `${s.name} changed` },
  upstream: {
    id: 'official',
    repo: 'agentsws-content',
    commit: 'abc',
    published_at: '2026-10-19',
    license: 'Apache-2.0',
  },
  review: {
    reviewer: 'Fable',
    reviewed_at: '2026-10-19',
    license_before: 'Apache-2.0',
    license_after: 'Apache-2.0',
    scan_hits: 0,
    scan_rules: [],
    notes_ok: true,
    tests_ok: true,
  },
  ...(s.positions === undefined ? {} : { positions: s.positions }),
  ...(s.urgent === undefined ? {} : { urgent: s.urgent }),
  ...(s.released_at === undefined ? {} : { released_at: s.released_at }),
})

export function roleContentFiles(content: Record<string, unknown>, id = ROLE) {
  return {
    'content.json': JSON.stringify({
      schema: 'agentsws.role-content/1',
      kind: 'role',
      id,
      content,
    }),
  }
}

export function pack(
  dir: string,
  key: { pem: string },
  serial: number,
  specs: ItemSpec[],
  options: { source?: 'official' | 'public'; created_at?: string } = {},
): BuiltContentPack {
  const items = specs.map((s) => {
    const d = join(dir, `src-${serial}-${s.kind}-${s.name}`)
    for (const [path, text] of Object.entries(s.files)) {
      mkdirSync(join(d, path, '..'), { recursive: true })
      writeFileSync(join(d, path), text)
    }
    return { meta: meta(s), dir: d }
  })
  return buildContentPack({
    channel: 'stable',
    serial,
    created_at: options.created_at ?? '2026-10-19T00:00:00.000Z',
    min_app_version: '0.0.0',
    items,
    privateKeyPem: key.pem,
    ...(options.source === 'public' ? {} : { source: options.source ?? 'official' }),
  })
}

/** 云上那几条路的替身。 */
export class FakeCloud {
  linked = true
  offline = false
  scopeMissing = false
  sub: ContentSubscriptionView = {
    service_id: 'content.official.monthly',
    status: 'active',
    usable: true,
    credits_per_month: 30,
    cancel_at_period_end: false,
  }
  built: BuiltContentPack | undefined
  /** 改坏的字节（坏签名 / 坏哈希测试用）。 */
  manifestOverride: Buffer | undefined
  signatureOverride: string | undefined
  blobOverride = new Map<string, Buffer>()
  calls: string[] = []
  now = (): string => new Date().toISOString()

  api() {
    return {
      linked: () => this.linked,
      call: async <T>(path: string, init?: { method?: string }) => {
        this.calls.push(`${init?.method ?? 'GET'} ${path}`)
        if (this.offline) return { ok: false, status: 0 } as never
        if (this.scopeMissing)
          return { ok: false, status: 403, details: { required_scope: 'content' } } as never
        if (path.startsWith(CONTENT_SUBSCRIPTION_PATH)) {
          if (init?.method === 'POST') this.sub = { ...this.sub, status: 'active', usable: true }
          return { ok: true, status: 200, data: this.sub as T }
        }
        if (path.startsWith(OFFICIAL_CONTENT_PATHS.summary)) {
          const m = this.built?.manifest
          const positions = new URL(`https://x${path}`).searchParams.get('positions')?.split(',')
          return {
            ok: true,
            status: 200,
            data: (m === undefined
              ? { channel: 'stable', available: false, since: '', until: '', positions: [] }
              : summarizeOfficialContent(m as ContentManifest, {
                  now: this.now(),
                  ...(positions === undefined ? {} : { positions }),
                })) as T,
          }
        }
        return { ok: false, status: 404 } as never
      },
      callBytes: async <T>(path: string) => {
        this.calls.push(`BYTES ${path}`)
        if (this.offline) return { ok: false, status: 0 } as never
        if (!this.sub.usable) return { ok: false, status: 402, message: '没订阅' } as never
        const b = this.built
        if (b === undefined) return { ok: false, status: 404 } as never
        const bytes = (x: Uint8Array) => ({ ok: true, status: 200, bytes: x }) as never as T
        if (path.startsWith(OFFICIAL_CONTENT_PATHS.signature))
          return bytes(Buffer.from(this.signatureOverride ?? b.signature))
        if (path.startsWith(OFFICIAL_CONTENT_PATHS.manifest))
          return bytes(this.manifestOverride ?? b.manifestBytes)
        if (path.startsWith(OFFICIAL_CONTENT_PATHS.blobs)) {
          const sha = path.slice(OFFICIAL_CONTENT_PATHS.blobs.length)
          const blob = this.blobOverride.get(sha) ?? b.blobs.get(sha)
          return blob === undefined ? ({ ok: false, status: 404 } as never) : bytes(blob)
        }
        return { ok: false, status: 404 } as never
      },
    }
  }
}

/** 一条最小的审批总线（出卡、取、作废、批）。 */
export class FakeBus {
  cards = new Map<string, ApprovalItem>()
  n = 0
  async create(input: never): Promise<ApprovalItem> {
    this.n += 1
    const item = {
      ...(input as object),
      id: `apv_${this.n}`,
      state: 'pending',
      revision: 1,
    } as unknown as ApprovalItem
    this.cards.set(item.id, item)
    return item
  }
  async get(id: string) {
    return this.cards.get(id)
  }
  async expireNow(id: string) {
    const c = this.cards.get(id)
    if (c === undefined) return undefined
    const next = { ...c, state: 'expired' } as ApprovalItem
    this.cards.set(id, next)
    return next
  }
  async decide(id: string, _by: never, input: DecideInput): Promise<ApprovalItem> {
    const c = this.cards.get(id)
    if (c === undefined) throw new Error('no card')
    const next = {
      ...c,
      state: input.action === 'reject' ? 'rejected' : 'approved',
      decision: {
        ...(input.selected_option_id === undefined
          ? {}
          : { selected_option_id: input.selected_option_id }),
      },
    } as unknown as ApprovalItem
    this.cards.set(id, next)
    return next
  }
  open(kind = 'content_update_digest'): ApprovalItem[] {
    return [...this.cards.values()].filter((c) => c.kind === kind && c.state === 'pending')
  }
}

export interface Harness {
  dir: string
  key: ReturnType<typeof officialKeys>
  cloud: FakeCloud
  bus: FakeBus
  oc: OfficialContent
  setNow(at: string): void
  personas: Map<string, PersonaOverride>
  roles: Map<string, RoleDefinitionFull>
  company: { on: boolean }
  events: { type: string; payload: Record<string, unknown> }[]
  publish(serial: number, specs: ItemSpec[], options?: Parameters<typeof pack>[4]): void
  decideBus: FakeBus
  registry: ReturnType<typeof createSkills>['registry']
}

/** 规则表覆盖源是进程全局的：每建一套替身，先撤掉上一套登记的。 */
let unregister: (() => void) | undefined

export function harness(
  input: Partial<Omit<OfficialContentOptions, 'positions'>> & {
    positions?: OfficialPosition[]
  } = {},
): Harness {
  const { positions: givenPositions, ...overrides } = input
  const dir = mkdtempSync(join(tmpdir(), 'wp406-'))
  const key = officialKeys()
  const cloud = new FakeCloud()
  const bus = new FakeBus()
  let at = '2026-10-20T02:00:00.000Z'
  const clock = { now: () => at }
  cloud.now = () => at
  const personas = new Map<string, PersonaOverride>()
  const roles = new Map<string, RoleDefinitionFull>([[ROLE, loadBundledRoleWithContent(ROLE, {})]])
  const company = { on: false }
  const events: Harness['events'] = []
  const skills = createSkills({ clock, random: () => 0.5 })
  const positions: OfficialPosition[] = givenPositions ?? [
    {
      id: POSITION,
      name: { zh: '网站运营', en: 'Web ops' },
      roles: [ROLE, 'dtc.content'],
      supervisor_person_id: SUPERVISOR,
    },
  ]
  const pkey = (s: PersonaSubject) => `${s.kind}:${s.id}`
  const oc = createOfficialContent({
    root: join(dir, 'official'),
    appVersion: '1.0.0',
    channel: 'stable',
    keys: [key.pub],
    clock,
    registry: skills.registry,
    bootWorkspace: WS,
    brands: async () => [{ id: WS, owner_id: OWNER }],
    positions: () => positions,
    company: async () => company.on,
    isOwner: async (_ws, person) => person === OWNER,
    cloud: async () => cloud.api() as never,
    approvals: () => bus as never,
    appendEvent: (e) => {
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> })
    },
    roles: { get: (id) => roles.get(id), register: (def) => roles.set(def.id, def) },
    personas: {
      get: (s) => personas.get(pkey(s)),
      put: (row) => personas.set(pkey(row.subject), row),
      remove: (s) => personas.delete(pkey(s)),
    },
    ...overrides,
  })
  unregister?.()
  unregister = registerContentTableProvider((table, brand) => oc.tableRows(brand as never, table))
  return {
    dir,
    key,
    cloud,
    bus,
    oc,
    setNow: (x) => {
      at = x
    },
    personas,
    roles,
    company,
    events,
    publish(serial, specs, options) {
      cloud.built = pack(dir, key, serial, specs, options)
    },
    decideBus: bus,
    registry: skills.registry,
  }
}

/** 批一张岗位更新卡（经引擎的包装：选「全部应用」或「这次跳过」）。 */
export async function decideDigest(
  h: Harness,
  card: ApprovalItem,
  option: 'apply_all' | 'skip',
  by: PersonId = OWNER,
) {
  const wrapped = h.oc.wrap(h.bus as never) as unknown as FakeBus
  return wrapped.decide(
    card.id,
    by as never,
    {
      decision_token: 't',
      action: 'approve',
      selected_option_id: option,
      via: 'workstation',
    } as DecideInput,
  )
}
