/**
 * WP496 联调：**真的 ego** × **本机假页面**——ego 路采集红人与插件逐字段对拍。
 *
 *   npx tsx scripts/e2e-wp496-ego-capture.mts [--port 4986] [--ego <ego-browser 路径>]
 *
 * - 假页面就是 `packages/creator-capture/test/fixtures` 那一批（人名数字全是编的），开在 127.0.0.1:<port>/p<n>；
 *   每页带 `Content-Security-Policy: default-src 'none'`——页面上的图片 / 脚本一个都不去取（不出这台电脑）。
 * - 走产品里同一条路：`createEgoCreatorCapture`（ego 读页口 + capture 步 + 插件同一份换形）；
 *   假页面映射（`rewrite`）只开映射里的地址，主页上的 Linktree 也换成本机那一页。
 * - 「本机服务」是一个记录器：收到的请求体与标准答案（私有插件真代码在同一批假页面上跑出来的，
 *   `test/fixtures/pages/golden/*.json`）逐字段比；时间类的格（观测时间、相对日期换算出的发布时间）不比。
 * - 每一趟一个新空间，跑完 `finish({ keep: [] })`；最后核对 ego 里没留下「读页」空间。
 * - WP498（int/1036 补）：主页那一趟还会「存入红人池」（`saveCreator`）——请求体去掉多存的两格（加入时间、近期作品）
 *   与 `golden/save/*.json`（插件按钮那一份）逐字段比；视频页右栏要种子主题词（`seedSignature`），
 *   核对真浏览器里读出的种子频道是 `@seedchannel`（这里回「不在库里」，观测照旧与 WP496 标准答案比）。
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createEgoCreatorCapture,
  type EgoCapturePort,
} from '../apps/server/src/ego-read/capture.ts'
import { createEgoPageReader } from '../apps/server/src/ego-read/reader.ts'
import { spawnEgo } from '../packages/dsh-adapter/src/ego.ts'

const args = process.argv.slice(2)
const val = (n: string, d?: string): string | undefined =>
  args.includes(n) ? args[args.indexOf(n) + 1] : d
const port = Number(val('--port', '4986'))
const egoPath = val('--ego', join(homedir(), '.local/bin/ego-browser')) as string
const origin = `http://127.0.0.1:${port}`

const FIX = join(import.meta.dirname, '../packages/creator-capture/test/fixtures')
const CASES: { name: string; file: string; url: string }[] = [
  {
    name: 'youtube-channel',
    file: 'pages/youtube-channel.html',
    url: 'https://www.youtube.com/@deskfixture/videos',
  },
  {
    name: 'youtube-channel-reveal',
    file: 'pages/youtube-channel-reveal.html',
    url: 'https://www.youtube.com/@cablefixture',
  },
  {
    name: 'tiktok-profile',
    file: 'pages/tiktok-profile.html',
    url: 'https://www.tiktok.com/@lunchfixture',
  },
  {
    name: 'instagram-profile',
    file: 'pages/instagram-profile.html',
    url: 'https://www.instagram.com/clayfixture/',
  },
  {
    name: 'youtube-video',
    file: 'pages/youtube-video.html',
    url: 'https://www.youtube.com/watch?v=dfVid000001',
  },
  {
    name: 'tiktok-video',
    file: 'pages/tiktok-video.html',
    url: 'https://www.tiktok.com/@lunchfixture/video/7000000000000000209',
  },
  {
    name: 'instagram-post',
    file: 'pages/instagram-post.html',
    url: 'https://www.instagram.com/clayfixture/p/CFixtureP07/',
  },
  { name: 'linktree', file: 'pages/linktree.html', url: 'https://linktr.ee/deskfixture' },
  {
    name: 'youtube-watch-related',
    file: 'lists/youtube-watch.html',
    url: 'https://www.youtube.com/watch?v=SeedVideo01&list=PL1&t=42s',
  },
  {
    name: 'youtube-search',
    file: 'lists/youtube-search.html',
    url: 'https://www.youtube.com/results?search_query=standing+desk',
  },
  {
    name: 'tiktok-search',
    file: 'lists/tiktok-search.html',
    url: 'https://www.tiktok.com/search?q=meal%20prep',
  },
  { name: 'tiktok-tag', file: 'lists/tiktok-tag.html', url: 'https://www.tiktok.com/tag/mealprep' },
  {
    name: 'instagram-tag',
    file: 'lists/instagram-tag.html',
    url: 'https://www.instagram.com/explore/tags/mealprep/',
  },
  {
    name: 'instagram-search',
    file: 'lists/instagram-search.html',
    url: 'https://www.instagram.com/explore/search/keyword/?q=mealprep',
  },
]
const REWRITE: Record<string, string> = Object.fromEntries(
  CASES.map((c, i) => [c.url, `${origin}/p${i}`]),
)
const FILE_OF: Record<string, string> = Object.fromEntries(CASES.map((c, i) => [`/p${i}`, c.file]))

const seen: { method: string; path: string }[] = []
const server = createServer((req, res) => {
  seen.push({ method: req.method ?? '', path: req.url ?? '' })
  const file = FILE_OF[(req.url ?? '').split('?')[0] as string]
  if (file === undefined) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
  res.end(readFileSync(join(FIX, file)))
})
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))

/* ── 「本机服务」：只记下收到的请求体 ── */
const got: {
  observations: unknown[][]
  contents: unknown[]
  bios: unknown[]
  saves: unknown[]
  seeds: { channel: string; handle: string }[]
} = {
  observations: [],
  contents: [],
  bios: [],
  saves: [],
  seeds: [],
}
const port0: EgoCapturePort = {
  ingest: async (_s, input) => {
    got.observations.push(input.observations)
    return {
      rows: input.observations.map((o) => ({ handle: o.handle, status: 'ok' as const })),
      forwarded_to_public_library: 0,
    }
  },
  contentObservation: async (_s, input) => {
    got.contents.push(input)
    return { metric_recorded: true, deduped: false } as never
  },
  bioLinkObservation: async (_s, input) => {
    got.bios.push(input)
    return { attached_creators: 0 } as never
  },
  saveCreator: async (_s, input) => {
    const { joined_date: _j, recent_items: _r, ...pluginPart } = input as Record<string, unknown>
    got.saves.push(pluginPart)
    return { status: 'ok', creator_id: 'cr_e2e' } as never
  },
  seedSignature: async (_s, key) => {
    got.seeds.push({ channel: String(key.channel), handle: String(key.handle) })
    return undefined
  },
}
const SAVE_GOLDEN = new Set([
  'youtube-channel+linktree',
  'youtube-channel-reveal',
  'tiktok-profile',
  'instagram-profile',
])

const TIME_KEYS = new Set(['observed_at', 'captured_at', 'capturedAt'])
/** 时间类的格不比：观测时间；相对日期（「2 days ago」）按「现在」换算出的发布时间。 */
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm)
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  const relative = typeof o.publishedText === 'string' && /ago|前/u.test(o.publishedText as string)
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) {
    if (TIME_KEYS.has(k)) continue
    if (relative && k === 'publishedAt') continue
    out[k] = norm(x)
  }
  return out
}
function diff(a: unknown, e: unknown, path: string, out: string[]): void {
  if (e !== null && typeof e === 'object') {
    if (a === null || typeof a !== 'object') {
      out.push(`${path}: 期望对象，得到 ${JSON.stringify(a)}`)
      return
    }
    const ak = Object.keys(a as object)
    const ek = Object.keys(e as object)
    for (const k of new Set([...ak, ...ek]))
      diff(
        (a as Record<string, unknown>)[k],
        (e as Record<string, unknown>)[k],
        `${path}.${k}`,
        out,
      )
    return
  }
  if (JSON.stringify(a) !== JSON.stringify(e))
    out.push(
      `${path}: ego ${JSON.stringify(a)?.slice(0, 120)} ≠ 插件 ${JSON.stringify(e)?.slice(0, 120)}`,
    )
}

const capture = createEgoCreatorCapture({
  reader: createEgoPageReader({ egoPath: () => egoPath }),
  port: () => port0,
  now: () => new Date().toISOString(),
})
const actor = { workspace_id: 'ws_e2e' as never, person_id: 'pr_e2e' }

let failed = 0
const fieldCount: Record<string, number> = {}
for (const c of CASES) {
  got.observations = []
  got.contents = []
  got.bios = []
  got.saves = []
  got.seeds = []
  const t0 = Date.now()
  // youtube-channel 带着 Linktree 一起读（顺手读 link-in-bio）→ 对的是「看过 Linktree」那一份标准答案
  const [page] = await capture.capture(actor, [c.url], { lang: 'en', rewrite: REWRITE })
  const goldenName = c.name === 'youtube-channel' ? 'youtube-channel+linktree' : c.name
  const golden = JSON.parse(readFileSync(join(FIX, `pages/golden/${goldenName}.json`), 'utf8'))
  const problems: string[] = []
  if (page?.ok !== true) problems.push(`没读到：${page?.why ?? ''}`)
  diff(norm(got.observations), norm(golden.observation_batches), 'observations', problems)
  diff(norm(got.contents), norm(golden.content_observations), 'content_observations', problems)
  diff(norm(got.bios), norm(golden.bio_link_observations), 'bio_link_observations', problems)
  // WP498 1740 B：主页存入红人池那一份 = 插件按钮那一份；别的页不存
  const saveGolden = SAVE_GOLDEN.has(goldenName)
    ? JSON.parse(readFileSync(join(FIX, `pages/golden/save/${goldenName}.json`), 'utf8'))
        .save_creator
    : []
  diff(norm(got.saves), norm(saveGolden), 'save_creator', problems)
  // WP498 1742 C：视频页右栏读出种子频道、拿去问本机主题词；别的页不问
  const wantSeeds =
    c.name === 'youtube-watch-related' ? [{ channel: 'youtube', handle: '@seedchannel' }] : []
  diff(got.seeds, wantSeeds, 'seed_signature', problems)
  let fields = 0
  const count = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(count)
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(count)
    else fields += 1
  }
  count(norm(golden.observation_batches))
  count(norm(golden.content_observations))
  count(norm(golden.bio_link_observations))
  count(norm(saveGolden))
  fieldCount[goldenName] = fields
  const ms = Date.now() - t0
  if (problems.length === 0) console.log(`✓ ${goldenName}（${fields} 个值逐字段一致，${ms} 毫秒）`)
  else {
    failed += 1
    console.log(`✗ ${goldenName}（${ms} 毫秒）`)
    for (const p of problems.slice(0, 12)) console.log(`    ${p}`)
  }
}

// 只有 GET、只开了假页面
const nonGet = seen.filter((s) => s.method !== 'GET')
console.log(`本机假页面一共收到 ${seen.length} 个请求（${nonGet.length} 个不是 GET）`)
if (nonGet.length > 0) failed += 1

// ego 里没留下「读页」空间
const list = await spawnEgo({
  egoPath,
  args: ['nodejs'],
  stdin:
    'const s = await listTaskSpaces();\nconsole.log("@@LEFT " + JSON.stringify(s.map((x) => x.name).filter((n) => /读页/.test(String(n)))));\n',
  timeoutMs: 30_000,
})
const left = /@@LEFT (.*)/u.exec(`${list.stdout}\n${list.stderr}`)?.[1] ?? '?'
console.log(`ego 里剩下的「读页」空间：${left}`)
if (left !== '[]') failed += 1
const notice = /\[ego-browser:notice\][^\n]*/u.exec(`${list.stdout}\n${list.stderr}`)?.[0]
if (notice !== undefined) console.log(`（ego 提示：${notice.slice(0, 80)}…——这一单不升级）`)

server.close()
console.log(failed === 0 ? '全部通过' : `${failed} 项没过`)
process.exit(failed === 0 ? 0 : 1)
