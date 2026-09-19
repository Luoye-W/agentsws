/**
 * 搬家（WP116 §3）：把别处的公共红人库**一行一行**收进这个库。
 *
 * 三条纪律，每一条都有一个它防的事故：
 *
 * 1. **坏行不让整趟失败**，但要数出来并且说清理由（{@link KolImportResult.rejected}）。
 *    723 行里有 3 行的 handle 是一串空格，这种事不该让另外 720 行也进不来；
 *    反过来，静默丢掉 3 行也不行——搬完之后"少了几个人"是最难查的那种问题。
 * 2. **幂等**：同一份 NDJSON 推两趟，第二趟全是 `updated`，一行都不重复。
 *    落库走的是 `(channel, handle)` 这个自足键上的 upsert，
 *    内容走 `(channel, external_id)`，指标快照走 `(channel, handle, observed_at)`。
 *    所以"重跑一次"是安全的，也是推荐的（网断了就再推一趟）。
 * 3. **邮箱要么加密落库，要么根本不落**：没配 `AGENTSWS_KOL_EMAIL_KEY` 的节点
 *    收到 `kind: 'contact'` 一律 `skipped`，**绝不降级成明文**
 *    （与 `node-crypto.ts` 头注释同一条）。明文邮箱只在这一趟的内存里出现。
 *
 * 另有一条合规闸：**先问 opt-out**。一个要求过被移除的人，搬家不许把他搬回来
 * （后台那页按的"从库中移除"写的就是那张表）。
 */

import type {
  Iso8601,
  KolChannel,
  KolImportRecord,
  KolImportResult,
  KolObservationSource,
  PublicContentSample,
} from '@agentsws/contracts'
import { KOL_OBSERVATION_SOURCES } from '@agentsws/contracts'
import { assertChannel, normalizeEmail, normalizeHandle } from './normalize.js'
import type { CreatorRow, KolLibraryStore, KolStore } from './store.js'
import type { KolSecrets } from './types.js'
import { KolError } from './types.js'

/** 搬进来的行标成这个，后台那页按它数"搬家来的"。 */
export const IMPORTED_FROM_KOLAGENTS = 'kolagents'

/** 搬进来的那一批算哪一档可信度：原系统的来源如实带过来，认不出就当人工填的。 */
export function importSource(raw: unknown): KolObservationSource {
  return typeof raw === 'string' && (KOL_OBSERVATION_SOURCES as readonly string[]).includes(raw)
    ? (raw as KolObservationSource)
    : 'manual'
}

export interface KolImportDeps {
  store: KolStore & KolLibraryStore
  secrets: KolSecrets
  now: () => Iso8601
  /** 这一趟是从哪儿搬的（落在 `imported_from` 那一格）。 */
  from?: string
}

/** 一个非负整数或 `undefined`（负数、NaN、字符串一律当没给——不猜）。 */
function count(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

/** 0–1 之间的小数；出界就夹住（原系统的确认数折出来的值偶尔会到 1.2）。 */
function ratio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** `extra` 只收标量（契约里那条"不放正文、不放嵌套"）。 */
function scalars(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    // 其余（对象 / 数组 / null / undefined）一律不收
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** 类目：去空、去重、小写、最多十个（一个人挂三十个类目等于没有类目）。 */
function categories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const one of raw) {
    if (typeof one !== 'string') continue
    const value = one.trim().toLowerCase()
    if (value !== '' && value.length <= 60) seen.add(value)
    if (seen.size >= 10) break
  }
  return [...seen]
}

/** 时刻：认不出就用"现在"（搬家那一刻），**不留空**——空的 observed_at 会让基准算错。 */
function at(raw: unknown, fallback: Iso8601): Iso8601 {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
}

/** `{ channel, handle }`：两样都必须认得出来，认不出来这一行就没有归属。 */
function keyOf(raw: { channel?: unknown; handle?: unknown }): {
  channel: KolChannel
  handle: string
} {
  return { channel: assertChannel(raw.channel), handle: normalizeHandle(raw.handle) }
}

/** 一句话的拒绝理由（同一个理由在结果里合并计数）。 */
function reasonOf(err: unknown): string {
  if (err instanceof KolError) return err.message
  return err instanceof Error && err.message !== '' ? err.message : '这一行读不懂'
}

/*
 * 下面三个 `…Field` 是给 `exactOptionalPropertyTypes` 用的。
 *
 * 直接写 `...(count(x) === undefined ? {} : { views: count(x) })` 编不过：
 * 那是**两次**调用，TS 不会把第二次的结果也窄成 `number`。所以窄化在函数里做一次，
 * 返回"要么一格要么没有这一格"。
 */

/** 非负整数那一格（认不出来就没有这一格）。 */
function numField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const n = count(value)
  return n === undefined ? {} : ({ [key]: n } as { [P in K]?: number })
}

/** 0–1 那一格。 */
function ratioField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const n = ratio(value)
  return n === undefined ? {} : ({ [key]: n } as { [P in K]?: number })
}

/** 非空字符串那一格（顺便截长）。 */
function strField<K extends string>(key: K, value: unknown, max = 500): { [P in K]?: string } {
  if (typeof value !== 'string') return {}
  const trimmed = value.trim()
  return trimmed === '' ? {} : ({ [key]: trimmed.slice(0, max) } as { [P in K]?: string })
}

/** 这一行落哪儿、算插入还是更新。一条 = 一个 kind。 */
type Outcome = 'inserted' | 'updated' | 'skipped'

/** `kind: 'creator'`：卡 + 旁表（原生 id / 名称 / 头像 / 分组 / extra）。 */
function putCreator(deps: KolImportDeps, row: Record<string, unknown>, when: Iso8601): Outcome {
  const key = keyOf(row)
  if (deps.store.optedOut(key.channel, key.handle)) return 'skipped'
  const existing = deps.store.creator(key.channel, key.handle)
  const observed_at = at(row.observed_at, when)
  const source = importSource(row.source)
  const card: CreatorRow = {
    ...key,
    // 搬进来的那一批很多只有粉丝数：另外两个数**给 0 而不是编一个**
    followers: count(row.followers) ?? existing?.followers ?? 0,
    posts_30d: count(row.posts_30d) ?? existing?.posts_30d ?? 0,
    engagement_rate: ratio(row.engagement_rate) ?? existing?.engagement_rate ?? 0,
    categories:
      categories(row.categories).length === 0
        ? (existing?.categories ?? [])
        : categories(row.categories),
    observed_at,
    source,
    // 观察条数不动：搬家不是"有人报了一条"，它不该抬高可信度
    observations: existing?.observations ?? 0,
    confidence: existing?.confidence ?? 0,
    has_contact: existing?.has_contact ?? false,
    updated_at: when,
    ...(typeof row.language === 'string' && row.language !== '' ? { language: row.language } : {}),
    ...(typeof row.country === 'string' && row.country !== ''
      ? { region: row.country }
      : typeof row.region === 'string' && row.region !== ''
        ? { region: row.region }
        : {}),
  }
  deps.store.putCreator(card)
  deps.store.putCreatorExtra({
    ...key,
    imported_from: deps.from ?? IMPORTED_FROM_KOLAGENTS,
    ...(typeof row.external_id === 'string' && row.external_id !== ''
      ? { external_id: row.external_id }
      : {}),
    ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
    ...(typeof row.avatar_url === 'string' && row.avatar_url !== ''
      ? { avatar_url: row.avatar_url }
      : {}),
    ...(typeof row.country === 'string' && row.country !== '' ? { country: row.country } : {}),
    ...(typeof row.person_id === 'string' && row.person_id !== ''
      ? { person_id: row.person_id }
      : {}),
    ...(scalars(row.extra) === undefined ? {} : { extra: scalars(row.extra) }),
  })
  return existing === undefined ? 'inserted' : 'updated'
}

/** `kind: 'contact'`：明文邮箱只在这个函数的栈上活一会儿。 */
function putContact(deps: KolImportDeps, row: Record<string, unknown>, when: Iso8601): Outcome {
  const key = keyOf(row)
  if (deps.store.optedOut(key.channel, key.handle)) return 'skipped'
  const email = normalizeEmail(row.email)
  const email_sha256 = deps.secrets.sha256(email)
  const email_cipher = deps.secrets.encrypt(email)
  // 没配密钥就一个字节都不落（**不降级成明文**）
  if (email_cipher === undefined) return 'skipped'
  const existing = deps.store.contactBySha(key.channel, key.handle, email_sha256)
  deps.store.putContact({
    ...key,
    email_sha256,
    email_cipher,
    source: importSource(row.source),
    // 搬进来的这一批没有"哪个工作区回填的"——原系统里它是全局的
    contributed_by: existing?.contributed_by ?? deps.from ?? IMPORTED_FROM_KOLAGENTS,
    at: at(row.at, when),
    ...strField('source_url', row.source_url, 1000),
    ...strField('source_detail', row.source_detail, 100),
    ...ratioField('confidence', row.confidence),
    ...numField('confirmations', row.confirmations),
    ...numField('disputes', row.disputes),
  })
  /*
   * 卡上那一格也要翻。后台那页数"有联系方式的人"数的是卡上的 `has_contact`
   * （一次 JOIN 省掉），所以少翻这一下，搬完之后那个数就是 0——
   * 数对不上比没有数更糟。服务那一侧 `saveContact` 走的也是这一行。
   */
  const card = deps.store.creator(key.channel, key.handle)
  if (card !== undefined && !card.has_contact)
    deps.store.putCreator({ ...card, has_contact: true, updated_at: when })
  return existing === undefined ? 'inserted' : 'updated'
}

/** `kind: 'content'`：一条作品的**公开元数据**。评论与文案一个字都不收（48 §1.3）。 */
function putContent(deps: KolImportDeps, row: Record<string, unknown>, when: Iso8601): Outcome {
  const key = keyOf(row)
  if (deps.store.optedOut(key.channel, key.handle)) return 'skipped'
  const external_id = typeof row.external_id === 'string' ? row.external_id.trim() : ''
  if (external_id === '' || external_id.length > 200)
    throw new KolError('invalid_input', '内容要有一个平台原生 id。')
  const existing = deps.store.content(key.channel, external_id)
  const type = row.content_type
  const sample: PublicContentSample = {
    ...key,
    external_id,
    content_type: type === 'post' || type === 'reel' ? type : 'video',
    observed_at: at(row.observed_at, when),
    source: importSource(row.source),
    updated_at: when,
    ...strField('title', row.title),
    ...strField('url', row.url, 1000),
    ...strField('thumbnail_url', row.thumbnail_url, 1000),
    ...(categories(row.tags).length === 0 ? {} : { tags: categories(row.tags) }),
    ...(row.orientation === 'portrait' || row.orientation === 'landscape'
      ? { orientation: row.orientation }
      : {}),
    ...numField('duration_seconds', row.duration_seconds),
    ...(typeof row.published_at === 'string' && row.published_at !== ''
      ? { published_at: at(row.published_at, when) }
      : {}),
    ...numField('views', row.views),
    ...numField('likes', row.likes),
    ...numField('comments', row.comments),
    ...numField('shares', row.shares),
  }
  deps.store.putContent(sample)
  return existing === undefined ? 'inserted' : 'updated'
}

/** `kind: 'content_metric'`：一条作品在某一刻的数。主键带 `observed_at`，重跑不翻倍。 */
function putContentMetric(
  deps: KolImportDeps,
  row: Record<string, unknown>,
  when: Iso8601,
): Outcome {
  const key = keyOf(row)
  if (deps.store.optedOut(key.channel, key.handle)) return 'skipped'
  const content_external_id =
    typeof row.content_external_id === 'string' ? row.content_external_id.trim() : ''
  if (content_external_id === '')
    throw new KolError('invalid_input', '这条指标没说是哪条内容的（content_external_id）。')
  deps.store.putContentMetric({
    ...key,
    content_external_id,
    observed_at: at(row.observed_at, when),
    source: importSource(row.source),
    at: when,
    ...numField('views', row.views),
    ...numField('likes', row.likes),
    ...numField('comments', row.comments),
    ...numField('shares', row.shares),
  })
  // 主键上的 upsert：说不清是插还是更（也不重要），一律算更新——**不虚报插入数**
  return 'updated'
}

/** `kind: 'metric'`：粉丝 / 均播 / 累计那一组快照。 */
function putMetric(deps: KolImportDeps, row: Record<string, unknown>, when: Iso8601): Outcome {
  const key = keyOf(row)
  if (deps.store.optedOut(key.channel, key.handle)) return 'skipped'
  deps.store.putMetricSnapshot({
    ...key,
    observed_at: at(row.observed_at, when),
    source: importSource(row.source),
    ...numField('followers', row.followers),
    ...numField('avg_views', row.avg_views),
    ...numField('video_count', row.video_count),
    ...numField('total_views', row.total_views),
  })
  return 'updated'
}

/** `kind: 'person'`：只分组，不下"这就是同一个人"的结论。 */
function putPerson(deps: KolImportDeps, row: Record<string, unknown>, when: Iso8601): Outcome {
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '' || id.length > 200) throw new KolError('invalid_input', 'person 要有一个 id。')
  const existing = deps.store.person(id)
  deps.store.putPerson({
    id,
    created_at: existing?.created_at ?? at(row.created_at, when),
    updated_at: when,
    ...(typeof row.display_name === 'string' && row.display_name !== ''
      ? { display_name: row.display_name.slice(0, 200) }
      : {}),
  })
  return existing === undefined ? 'inserted' : 'updated'
}

/**
 * 收一批（**一趟 ≤ {@link MAX_KOL_IMPORT_BATCH} 行**，脚本按它分块）。
 *
 * 每一行自己一个 try：一行坏了只算它自己坏。整批**不开一个大事务**——
 * 五百行里第四百行抛一下就把前三百九十九行也回滚掉，那会让"重跑一趟"
 * 从"补差"变成"从头再来"。
 */
export function importKolRecords(
  deps: KolImportDeps,
  records: readonly unknown[],
): KolImportResult {
  const when = deps.now()
  const rejected = new Map<string, number>()
  let inserted = 0
  let updated = 0
  let skipped = 0
  for (const raw of records) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      rejected.set('这一行不是一个对象', (rejected.get('这一行不是一个对象') ?? 0) + 1)
      continue
    }
    const row = raw as Record<string, unknown>
    const kind = row.kind
    try {
      const outcome: Outcome =
        kind === 'person'
          ? putPerson(deps, row, when)
          : kind === 'creator'
            ? putCreator(deps, row, when)
            : kind === 'contact'
              ? putContact(deps, row, when)
              : kind === 'content'
                ? putContent(deps, row, when)
                : kind === 'content_metric'
                  ? putContentMetric(deps, row, when)
                  : kind === 'metric'
                    ? putMetric(deps, row, when)
                    : (() => {
                        throw new KolError(
                          'invalid_input',
                          `不认识的 kind：${typeof kind === 'string' ? kind : '（没给）'}`,
                        )
                      })()
      if (outcome === 'inserted') inserted += 1
      else if (outcome === 'updated') updated += 1
      else skipped += 1
    } catch (err) {
      const reason = reasonOf(err)
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1)
    }
  }
  return {
    received: records.length,
    inserted,
    updated,
    skipped,
    rejected: [...rejected].map(([reason, count_]) => ({ reason, count: count_ })),
    at: when,
  }
}

/** NDJSON → 一批对象。**坏行在这里不抛**，原样带着让 {@link importKolRecords} 去数。 */
export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // 一行坏 JSON 也是一行："这一行不是一个对象"会把它数进 rejected
      out.push(trimmed)
    }
  }
  return out
}

export type { KolImportRecord, KolImportResult }
