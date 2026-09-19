#!/usr/bin/env node
/**
 * 把 KOLAgents 的公共红人库导成 NDJSON（WP116 §3 第一步）。
 *
 * ```
 * node --env-file=<KOLAgents 的 env 文件> scripts/export-kolagents-public.mjs
 * ```
 *
 * 三条纪律：
 *
 * 1. **连接串只从环境变量 `KOLAGENTS_DATABASE_URL` 读**，不接受命令行参数，
 *    也**一个字都不打印**（出错时只说"连不上"，不回显串）。
 * 2. **只读**：连上就 `SET default_transaction_read_only = on`，
 *    整个脚本里没有一条 `insert` / `update` / `delete`。
 * 3. **产物含真实邮箱**，写进 `./.data/kolagents-public/`（`.gitignore` 里已有
 *    `.data/`）。**绝不进仓库、绝不进日志**——屏幕上只有行数。
 *
 * 出六个文件，名字带序号是因为**导入有顺序**：`person` 与 `creator` 要先落，
 * 不然 `contact` / `content` / `metric` 找不到归属的那张卡。
 *
 * ```
 * 01-person.ndjson  02-creator.ndjson  03-contact.ndjson
 * 04-content.ndjson 05-content-metric.ndjson 06-metric.ndjson
 * ```
 *
 * 字段映射见下面每一段 SQL 上方的注释。对不上我们模型的那几格（频道的加入日期、
 * 原系统的行 id）放 `extra`；**`bio` 一个字都不导**——它是简介正文，而且简介里
 * 经常写着邮箱，落进 `extra` 就等于把明文邮箱存进了库（21 §5 / 48 §1.3 第 4 条）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 连接串只认这一个名字。 */
const URL_ENV = 'KOLAGENTS_DATABASE_URL'

/** 平台名 → 我们的渠道。认不出来的那一行**跳过并计数**，不猜。 */
const CHANNELS = {
  youtube: 'youtube',
  instagram: 'instagram',
  tiktok: 'tiktok',
  facebook: 'facebook',
  x: 'x',
  twitter: 'x',
}

/** handle 的形状（与 `packages/kol-public` 的 `HANDLE_RE` 一字不差）。 */
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/

/** 邮箱的形状（与 `normalizeEmail` 一字不差）。 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

/**
 * KOLAgents 的 `source_type` → 我们的四档可信度来源。
 *
 * 细的那一档原样留在 `source_detail` 里——**两件事**：档位是给
 * `SOURCE_CONFIDENCE` 查表的，路径是给"这个邮箱你从哪儿看到的"回答的。
 */
const SOURCE_OF_DETAIL = {
  plugin_manual: 'plugin',
  observation_email: 'plugin',
  youtube_channel_description: 'official_api',
  apify_tiktok_bio: 'apify',
  manual: 'manual',
}

/** `@SomeCreator` → `somecreator`；形状不对回 `undefined`（**不截断、不猜**）。 */
export function handleOf(raw) {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().replace(/^@+/, '').toLowerCase()
  return HANDLE_RE.test(value) ? value : undefined
}

/**
 * 一行红人的自足键的一半。
 *
 * handle 认不出来时**用 `external_id` 顶上**：YouTube 有一批老频道根本没有
 * handle，只有 `UCxxxx` 那个 id，而那一批恰好是粉丝最多的一批。丢掉它们
 * 比"用一个不好看但稳定的 handle"坏得多。
 */
export function keyHandle(row) {
  return handleOf(row.handle) ?? handleOf(row.external_id)
}

/** 时刻 → ISO；认不出来回 `undefined`（导入那一侧会用"搬家那一刻"兜底）。 */
export function isoOf(value) {
  if (value === null || value === undefined) return undefined
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

/** 非负整数；`bigint`（postgres 驱动回字符串）也认。认不出来回 `undefined`。 */
export function numOf(value) {
  if (value === null || value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.trunc(n)
}

/** 非空字符串（顺便截长）。 */
export function strOf(value, max = 500) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/** 把 `undefined` 的那几格删掉再序列化（NDJSON 里不留一堆 null）。 */
export function line(record) {
  const out = {}
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return JSON.stringify(out)
}

/**
 * 确认 / 报错数折成 0–1 的可信度。
 *
 * `confirmations / (confirmations + disputes)`，一个人确认零人报错 = 1。
 * 两边都是 0（原系统的默认是 confirmation_count = 1，所以很少见）回 `undefined`
 * ——**没有数就别编一个**（21 §4）。
 */
export function confidenceOf(confirmations, disputes) {
  const yes = numOf(confirmations) ?? 0
  const no = numOf(disputes) ?? 0
  if (yes + no === 0) return undefined
  return Math.round((yes / (yes + no)) * 1000) / 1000
}

/* ------------------------------------------------------------------ */
/* 六段映射。每一段：一条 SQL + 一个"一行 → 一条记录"的函数。            */
/* ------------------------------------------------------------------ */

/**
 * 导出的六段，**顺序就是导入的顺序**。
 *
 * `rows` 收到的是原系统的一行（`snake_case`，postgres 驱动原样给），
 * 回 `undefined` 表示"这一行导不出来"（会被计进 `skipped`，并说一句理由）。
 */
export const SECTIONS = [
  {
    file: '01-person.ndjson',
    table: 'public_person',
    sql: 'select id, display_name, created_at, updated_at from public_person',
    map(row) {
      const id = strOf(row.id, 200)
      if (id === undefined) return { skip: 'person 没有 id' }
      return {
        record: {
          kind: 'person',
          id,
          display_name: strOf(row.display_name, 200),
          created_at: isoOf(row.created_at),
          updated_at: isoOf(row.updated_at),
        },
      }
    },
  },
  {
    /*
     * 红人卡。`latest_*` 那一组是原系统从最新一条 metric 反范式下来的快照，
     * 所以这里只取 `latest_followers`——`avg_views` / `video_count` /
     * `total_views` 在我们这边属于**指标快照**那张表（见 06 段），
     * 混进卡里会让"粉丝增长"那条曲线看不出来源。
     *
     * `posts_30d` 与 `engagement_rate` 原系统没有，所以**一格都不给**：
     * 填 0 会把 k-匿名基准的中位互动率拉成 0（见 `contracts` 里
     * `PublicCreatorMetricSnapshot` 的注释）。
     */
    file: '02-creator.ndjson',
    table: 'public_creator',
    sql: `select id, person_id, platform, external_id, handle, name, avatar_url,
                 country, language, joined_date, latest_followers, latest_captured_at, updated_at
          from public_creator`,
    map(row) {
      const channel = CHANNELS[String(row.platform ?? '').toLowerCase()]
      if (channel === undefined) return { skip: `不认识的平台：${String(row.platform)}` }
      const handle = keyHandle(row)
      if (handle === undefined) return { skip: 'handle 与 external_id 都不成形状' }
      const extra = {}
      const joined = strOf(row.joined_date, 60)
      if (joined !== undefined) extra.joined_date = joined
      const sourceId = strOf(row.id, 200)
      if (sourceId !== undefined) extra.kolagents_id = sourceId
      return {
        record: {
          kind: 'creator',
          channel,
          handle,
          external_id: strOf(row.external_id, 200),
          name: strOf(row.name, 200),
          avatar_url: strOf(row.avatar_url, 1000),
          country: strOf(row.country, 10),
          language: strOf(row.language, 20),
          person_id: strOf(row.person_id, 200),
          followers: numOf(row.latest_followers),
          observed_at: isoOf(row.latest_captured_at) ?? isoOf(row.updated_at),
          source: 'plugin',
          extra,
        },
      }
    },
  },
  {
    /*
     * 联系方式。**明文邮箱只在这一步落到本机磁盘上**，而那个目录在
     * `.gitignore` 里。导入那一侧要么加密落库要么根本不落（`import.ts` §3）。
     */
    file: '03-contact.ndjson',
    table: 'public_contact',
    sql: `select c.value, c.source_url, c.source_type, c.confirmation_count,
                 c.dispute_count, c.last_confirmed_at,
                 cr.platform, cr.handle, cr.external_id
          from public_contact c
          join public_creator cr on cr.id = c.creator_id
          where c.type = 'email'`,
    map(row) {
      const channel = CHANNELS[String(row.platform ?? '').toLowerCase()]
      if (channel === undefined) return { skip: `不认识的平台：${String(row.platform)}` }
      const handle = keyHandle(row)
      if (handle === undefined) return { skip: 'handle 与 external_id 都不成形状' }
      const email = strOf(row.value, 254)?.toLowerCase()
      if (email === undefined || !EMAIL_RE.test(email)) return { skip: '这不像一个邮箱地址' }
      const detail = strOf(row.source_type, 100)
      return {
        record: {
          kind: 'contact',
          channel,
          handle,
          email,
          source: SOURCE_OF_DETAIL[detail ?? ''] ?? 'manual',
          source_url: strOf(row.source_url, 1000),
          source_detail: detail,
          confidence: confidenceOf(row.confirmation_count, row.dispute_count),
          confirmations: numOf(row.confirmation_count),
          disputes: numOf(row.dispute_count),
          at: isoOf(row.last_confirmed_at),
        },
      }
    },
  },
  {
    /*
     * 内容样本：**公开元数据**（标题、封面、时长、播放数）。
     * 评论与视频文案一个字都不收——原系统里也没存。
     */
    file: '04-content.ndjson',
    table: 'public_content',
    sql: `select ct.external_id, ct.content_type, ct.title, ct.url, ct.thumbnail_url,
                 ct.tags, ct.orientation, ct.duration_seconds, ct.published_at,
                 ct.latest_views, ct.latest_likes, ct.latest_comments, ct.latest_shares,
                 ct.latest_captured_at, ct.updated_at,
                 cr.platform, cr.handle, cr.external_id as creator_external_id
          from public_content ct
          join public_creator cr on cr.id = ct.creator_id`,
    map(row) {
      const channel = CHANNELS[String(row.platform ?? '').toLowerCase()]
      if (channel === undefined) return { skip: `不认识的平台：${String(row.platform)}` }
      const handle = keyHandle({ handle: row.handle, external_id: row.creator_external_id })
      if (handle === undefined) return { skip: 'handle 与 external_id 都不成形状' }
      const external_id = strOf(row.external_id, 200)
      if (external_id === undefined) return { skip: '内容没有平台原生 id' }
      const type = String(row.content_type ?? 'video')
      const orientation = String(row.orientation ?? '')
      return {
        record: {
          kind: 'content',
          channel,
          handle,
          external_id,
          content_type: type === 'post' || type === 'reel' ? type : 'video',
          title: strOf(row.title),
          url: strOf(row.url, 1000),
          thumbnail_url: strOf(row.thumbnail_url, 1000),
          tags: Array.isArray(row.tags)
            ? row.tags.map((t) => strOf(t, 60)).filter((t) => t !== undefined)
            : undefined,
          orientation:
            orientation === 'portrait' || orientation === 'landscape' ? orientation : undefined,
          duration_seconds: numOf(row.duration_seconds),
          published_at: isoOf(row.published_at),
          views: numOf(row.latest_views),
          likes: numOf(row.latest_likes),
          comments: numOf(row.latest_comments),
          shares: numOf(row.latest_shares),
          observed_at: isoOf(row.latest_captured_at) ?? isoOf(row.updated_at),
          source: 'plugin',
        },
      }
    },
  },
  {
    file: '05-content-metric.ndjson',
    table: 'public_content_metric',
    sql: `select m.views, m.likes, m.comments, m.shares, m.captured_at, m.source,
                 ct.external_id as content_external_id,
                 cr.platform, cr.handle, cr.external_id as creator_external_id
          from public_content_metric m
          join public_content ct on ct.id = m.content_id
          join public_creator cr on cr.id = ct.creator_id`,
    map(row) {
      const channel = CHANNELS[String(row.platform ?? '').toLowerCase()]
      if (channel === undefined) return { skip: `不认识的平台：${String(row.platform)}` }
      const handle = keyHandle({ handle: row.handle, external_id: row.creator_external_id })
      if (handle === undefined) return { skip: 'handle 与 external_id 都不成形状' }
      const content_external_id = strOf(row.content_external_id, 200)
      if (content_external_id === undefined) return { skip: '这条指标没说是哪条内容的' }
      return {
        record: {
          kind: 'content_metric',
          channel,
          handle,
          content_external_id,
          views: numOf(row.views),
          likes: numOf(row.likes),
          comments: numOf(row.comments),
          shares: numOf(row.shares),
          observed_at: isoOf(row.captured_at),
          // 原系统的 `source` 只有 plugin / refresh 两档，refresh = 我们的官方口
          source: String(row.source) === 'refresh' ? 'official_api' : 'plugin',
        },
      }
    },
  },
  {
    /*
     * 指标快照。`recent_items` 那一列**不导**：它是"抓取那一刻网格上看到的
     * 前十条"，我们这边有 `public_content` 那张正经的内容表，而 `recent_items`
     * 里的标题会与内容表打架（同一条作品两份标题，谁对说不清）。
     */
    file: '06-metric.ndjson',
    table: 'public_creator_metric',
    sql: `select m.followers, m.avg_views, m.video_count, m.captured_at, m.source,
                 cr.platform, cr.handle, cr.external_id, cr.total_views
          from public_creator_metric m
          join public_creator cr on cr.id = m.creator_id`,
    map(row) {
      const channel = CHANNELS[String(row.platform ?? '').toLowerCase()]
      if (channel === undefined) return { skip: `不认识的平台：${String(row.platform)}` }
      const handle = keyHandle(row)
      if (handle === undefined) return { skip: 'handle 与 external_id 都不成形状' }
      return {
        record: {
          kind: 'metric',
          channel,
          handle,
          followers: numOf(row.followers),
          avg_views: numOf(row.avg_views),
          video_count: numOf(row.video_count),
          total_views: numOf(row.total_views),
          observed_at: isoOf(row.captured_at),
          source: String(row.source) === 'refresh' ? 'official_api' : 'plugin',
        },
      }
    },
  },
]

/** 一段的行 → NDJSON 文本 + 一份计数（**不含任何一行的内容**）。 */
export function renderSection(section, rows) {
  const lines = []
  const skipped = new Map()
  for (const row of rows) {
    const out = section.map(row)
    if (out.skip !== undefined) {
      skipped.set(out.skip, (skipped.get(out.skip) ?? 0) + 1)
      continue
    }
    lines.push(line(out.record))
  }
  return {
    text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    written: lines.length,
    read: rows.length,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
  }
}

/* ------------------------------------------------------------------ */

/** `postgres` 那个驱动住在 `packages/core` 底下（这个脚本自己没有依赖）。 */
async function loadPostgres() {
  const require = createRequire(join(ROOT, 'packages/core/package.json'))
  const mod = await import(require.resolve('postgres'))
  return mod.default ?? mod
}

function usage(message) {
  console.error(message)
  console.error('')
  console.error('用法：node --env-file=<KOLAgents 的 env 文件> scripts/export-kolagents-public.mjs')
  console.error(`      连接串只从环境变量 ${URL_ENV} 读，不接受命令行参数。`)
  process.exit(1)
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = resolve(
    ROOT,
    outIdx >= 0 ? (args[outIdx + 1] ?? '.data/kolagents-public') : '.data/kolagents-public',
  )
  const url = process.env[URL_ENV]
  if (url === undefined || url.trim() === '') usage(`没有设 ${URL_ENV}。`)

  const postgres = await loadPostgres()
  // 只读、单连接、不预编译（这是一次性的活，连接池没有意义）
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  mkdirSync(outDir, { recursive: true })
  const summary = []
  try {
    await sql.unsafe('set default_transaction_read_only = on')
    for (const section of SECTIONS) {
      const rows = await sql.unsafe(section.sql)
      const out = renderSection(section, rows)
      writeFileSync(join(outDir, section.file), out.text, 'utf8')
      summary.push({ ...out, file: section.file, table: section.table })
    }
  } catch (err) {
    /*
     * **不回显连接串**：驱动的报错信息里有时带着 host / user，所以只留
     * `err.message` 里不含 URL 的那一句，拿不准就一句通用的。
     */
    const message = err instanceof Error ? err.message : String(err)
    console.error(`导出没做完：${message.includes('://') ? '数据库连不上或者这条 SQL 不对' : message}`)
    process.exitCode = 1
    return
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log(`导出目录：${outDir}（含真实邮箱，别提交、别外发）`)
  for (const one of summary) {
    console.log(`  ${one.file}  ${one.table}  读 ${one.read} 行 → 写 ${one.written} 行`)
    for (const s of one.skipped) console.log(`      跳过 ${s.count} 行：${s.reason}`)
  }
  console.log('')
  console.log('下一步：node scripts/import-kol-public.mjs <云的地址>')
}

// 被 import 时（测试只拿 `renderSection` 那一半）不跑：测试永远不碰真库
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
