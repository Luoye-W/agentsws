/**
 * WP246：**YouTube 字幕**（零配置那一级 `page_captions`）——给红人调研 / 竞品分析读视频的字幕、标题、简介。
 *
 * 不引任何新运行时（不要 yt-dlp、不要 Python）：打开视频页，读页面里本来就有的播放器数据
 * （`ytInitialPlayerResponse`）——标题、频道、简介、时长、字幕轨列表；再按字幕轨的地址（timedtext）
 * 取字幕。两种字幕格式都认（老的 `<text start dur>`、新的 `<p t d>`，以及 json3）。
 *
 * 拿不到就照实说是哪一种：没有这个视频 / 要登录或年龄确认 / 视频没有字幕轨 / YouTube 这次没给字幕内容
 * （它有时要额外校验）/ 要先同意 cookie 条款（欧洲网络常见）/ 被限流。拿到标题简介而没拿到字幕时，
 * 标题简介照样给，字幕那一格说清楚为什么没有。
 */
import { decodeEntities } from '@agentsws/brand-intake'
import { getPublicPage, type PublicGetOptions } from './fetch.js'

export const YOUTUBE_BASE = 'https://www.youtube.com'

/** 字幕最多给多少字（再长模型那一步只是更贵）。 */
export const TRANSCRIPT_MAX_CHARS = 60_000

/** 网址 / 短链 / Shorts / 嵌入 / 直接给 11 位 id → 视频 id。认不出回 `undefined`。 */
export function videoIdOf(input: string): string | undefined {
  const s = input.trim()
  if (/^[\w-]{11}$/u.test(s)) return s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return undefined
  }
  const host = u.hostname.toLowerCase()
  const ok = (id: string | undefined | null): string | undefined =>
    id !== undefined && id !== null && /^[\w-]{11}$/u.test(id) ? id : undefined
  if (host === 'youtu.be') return ok(u.pathname.split('/')[1])
  if (!/(^|\.)youtube(-nocookie)?\.com$/u.test(host)) return undefined
  const v = ok(u.searchParams.get('v'))
  if (v !== undefined) return v
  const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/u.exec(u.pathname)
  return ok(m?.[1])
}

export interface CaptionTrack {
  url: string
  language: string
  name: string
  auto: boolean
}

export interface PlayerInfo {
  status: string
  reason?: string
  title?: string
  channel?: string
  description?: string
  duration_seconds?: number
  tracks: CaptionTrack[]
}

/** 从页面里抠出 `ytInitialPlayerResponse = {...}` 那一段 JSON（按括号配对，字符串里的括号不算）。 */
export function playerResponseOf(html: string): Record<string, unknown> | undefined {
  const at = html.search(/ytInitialPlayerResponse\s*=\s*\{/u)
  if (at < 0) return undefined
  const start = html.indexOf('{', at)
  let depth = 0
  let inStr = false
  for (let i = start; i < html.length; i += 1) {
    const c = html[i]
    if (inStr) {
      if (c === '\\') i += 1
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const textOf = (v: unknown): string | undefined => {
  const o = obj(v)
  return (
    str(o.simpleText) ??
    (Array.isArray(o.runs)
      ? o.runs.map((r) => str(obj(r).text) ?? '').join('') || undefined
      : undefined)
  )
}

export function playerInfoOf(player: Record<string, unknown>, pageUrl: string): PlayerInfo {
  const play = obj(player.playabilityStatus)
  const details = obj(player.videoDetails)
  const list = obj(obj(player.captions).playerCaptionsTracklistRenderer)
  const tracks: CaptionTrack[] = []
  for (const t of Array.isArray(list.captionTracks) ? list.captionTracks : []) {
    const o = obj(t)
    const base = str(o.baseUrl)
    if (base === undefined) continue
    let url: string
    try {
      url = new URL(base, pageUrl).href
    } catch {
      continue
    }
    tracks.push({
      url,
      language: str(o.languageCode) ?? '',
      name: textOf(o.name) ?? str(o.languageCode) ?? '',
      auto: o.kind === 'asr',
    })
  }
  const seconds = Number(details.lengthSeconds)
  const reason = textOf(play.reason) ?? str(play.reason)
  const title = str(details.title)
  const channel = str(details.author)
  const description = str(details.shortDescription)
  return {
    status: str(play.status) ?? 'UNKNOWN',
    ...(reason === undefined ? {} : { reason }),
    ...(title === undefined ? {} : { title }),
    ...(channel === undefined ? {} : { channel }),
    ...(description === undefined ? {} : { description }),
    ...(Number.isFinite(seconds) && seconds > 0 ? { duration_seconds: seconds } : {}),
    tracks,
  }
}

/** 挑一条字幕轨：指定语言优先（人工的先于自动的）→ 英文人工 → 任一人工 → 英文自动 → 任一。 */
export function pickTrack(
  tracks: readonly CaptionTrack[],
  lang?: string,
): CaptionTrack | undefined {
  const want = lang?.toLowerCase().split(/[-_]/u)[0]
  const match = (t: CaptionTrack, l: string): boolean =>
    t.language.toLowerCase().split(/[-_]/u)[0] === l
  const order: ((t: CaptionTrack) => boolean)[] = [
    ...(want === undefined
      ? []
      : [(t: CaptionTrack) => match(t, want) && !t.auto, (t: CaptionTrack) => match(t, want)]),
    (t) => match(t, 'en') && !t.auto,
    (t) => !t.auto,
    (t) => match(t, 'en'),
    () => true,
  ]
  for (const pred of order) {
    const hit = tracks.find(pred)
    if (hit !== undefined) return hit
  }
  return undefined
}

export interface Cue {
  start: number
  text: string
}

const clean = (s: string): string =>
  // timedtext 里常是双重转义（`&amp;#39;`）：解两遍；行内标签（`<s>` `<font>`）去掉
  decodeEntities(decodeEntities(s.replace(/<[^>]+>/gu, '')))
    .replace(/\s+/gu, ' ')
    .trim()

/** 字幕原文 → 一条条（认 json3、`<text start>`、`<p t>` 三种）。认不出回空数组。 */
export function parseCaptions(raw: string): Cue[] {
  const body = raw.trim()
  const out: Cue[] = []
  if (body.startsWith('{')) {
    try {
      const events = obj(JSON.parse(body)).events
      for (const e of Array.isArray(events) ? events : []) {
        const o = obj(e)
        const segs = Array.isArray(o.segs) ? o.segs : []
        const text = clean(segs.map((s) => str(obj(s).utf8) ?? '').join(''))
        if (text !== '') out.push({ start: Number(o.tStartMs ?? 0) / 1000, text })
      }
    } catch {
      return []
    }
    return out
  }
  for (const m of body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gu)) {
    const start = Number(/start="([\d.]+)"/u.exec(m[1] ?? '')?.[1] ?? 0)
    const text = clean(m[2] ?? '')
    if (text !== '') out.push({ start, text })
  }
  if (out.length > 0) return out
  for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gu)) {
    const start = Number(/\bt="(\d+)"/u.exec(m[1] ?? '')?.[1] ?? 0) / 1000
    const text = clean(m[2] ?? '')
    if (text !== '') out.push({ start, text })
  }
  return out
}

const stamp = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 一条条 → 带时间标记的段落（约每 30 秒一段，方便引用「第几分钟说了什么」）。 */
export function cuesToText(
  cues: readonly Cue[],
  maxChars = TRANSCRIPT_MAX_CHARS,
): { text: string; truncated: boolean } {
  const paras: string[] = []
  let cur: string[] = []
  let at = cues[0]?.start ?? 0
  for (const c of cues) {
    if (cur.length > 0 && c.start - at >= 30) {
      paras.push(`[${stamp(at)}] ${cur.join(' ')}`)
      cur = []
      at = c.start
    }
    cur.push(c.text)
  }
  if (cur.length > 0) paras.push(`[${stamp(at)}] ${cur.join(' ')}`)
  const text = paras.join('\n')
  return text.length > maxChars
    ? { text: `${text.slice(0, maxChars)}\n…（后面还有，截断了）`, truncated: true }
    : { text, truncated: false }
}

export type TranscriptFailure =
  | 'bad_input'
  | 'unreachable'
  | 'blocked'
  | 'consent'
  | 'no_video'
  | 'unplayable'
  | 'no_captions'
  | 'captions_empty'
  | 'unparsable'

export interface TranscriptResult {
  ok: boolean
  video_id?: string
  url?: string
  title?: string
  channel?: string
  description?: string
  duration_seconds?: number
  /** 拿到的字幕（带 `[分:秒]`）。 */
  transcript?: string
  language?: string
  auto_generated?: boolean
  truncated?: boolean
  /** 这个视频有哪些字幕轨。 */
  tracks?: { language: string; name: string; auto: boolean }[]
  /** 没拿到字幕时：哪一种、一句人话。 */
  failure?: TranscriptFailure
  message?: string
}

export interface TranscriptOptions extends PublicGetOptions {
  /** 视频页的站点根（生产是 {@link YOUTUBE_BASE}；测试指向本地假站点）。 */
  base?: string
}

/** 读一个视频的字幕 + 标题简介。永不抛。 */
export async function readYoutubeTranscript(
  options: TranscriptOptions,
  input: { video: string; lang?: string },
): Promise<TranscriptResult> {
  const id = videoIdOf(input.video)
  if (id === undefined)
    return {
      ok: false,
      failure: 'bad_input',
      message: '认不出视频：给 YouTube 视频网址或 11 位视频 id。',
    }
  const base = options.base ?? YOUTUBE_BASE
  const pageUrl = `${base}/watch?v=${id}&hl=en`
  const page = await getPublicPage(pageUrl, options)
  const shell = { video_id: id, url: `https://www.youtube.com/watch?v=${id}` }
  if (!page.ok)
    return {
      ok: false,
      ...shell,
      failure: page.kind === 'blocked' ? 'blocked' : 'unreachable',
      message: `打不开视频页：${page.message}`,
    }
  if (/(^|\.)consent\.(youtube|google)\.com$/u.test(new URL(page.url).hostname))
    return {
      ok: false,
      ...shell,
      failure: 'consent',
      message: 'YouTube 要先同意 cookie 条款（欧洲网络常见），我们不替你点同意，这次没读到。',
    }
  if (/\/sorry\/|unusual traffic/iu.test(page.url + page.body.slice(0, 5000)))
    return {
      ok: false,
      ...shell,
      failure: 'blocked',
      message: 'YouTube 觉得请求异常（要人机验证），已停下。',
    }
  const player = playerResponseOf(page.body)
  if (player === undefined)
    return {
      ok: false,
      ...shell,
      failure: 'unparsable',
      message: '视频页打开了，但没认出播放器数据（页面可能改版了）。',
    }
  const info = playerInfoOf(player, page.url)
  const meta = {
    ...shell,
    ...(info.title === undefined ? {} : { title: info.title }),
    ...(info.channel === undefined ? {} : { channel: info.channel }),
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(info.duration_seconds === undefined ? {} : { duration_seconds: info.duration_seconds }),
    tracks: info.tracks.map(({ language, name, auto }) => ({ language, name, auto })),
  }
  if (info.status === 'ERROR')
    return {
      ok: false,
      ...meta,
      failure: 'no_video',
      message: `没有这个视频（${info.reason ?? '已删除或不存在'}）。`,
    }
  if (info.status !== 'OK' && info.tracks.length === 0)
    return {
      ok: false,
      ...meta,
      failure: 'unplayable',
      message: `这个视频要登录或年龄确认才能看（${info.reason ?? info.status}），我们不登录，字幕没读到。`,
    }
  const track = pickTrack(info.tracks, input.lang)
  if (track === undefined)
    return {
      ok: false,
      ...meta,
      failure: 'no_captions',
      message: '这个视频没有字幕轨（作者没传、也没有自动字幕）。只有标题与简介。',
    }
  const host = new URL(track.url).hostname
  const baseHost = new URL(base).hostname
  if (host !== baseHost && !/(^|\.)youtube\.com$/u.test(host))
    return {
      ok: false,
      ...meta,
      failure: 'unparsable',
      message: '字幕轨的地址不在 YouTube 站内，没去取。',
    }
  const cap = await getPublicPage(track.url, options, 'text/xml,application/json;q=0.9,*/*;q=0.5')
  if (!cap.ok)
    return {
      ok: false,
      ...meta,
      failure: cap.kind === 'blocked' ? 'blocked' : 'unreachable',
      message: `字幕没取到：${cap.message}`,
    }
  const cues = parseCaptions(cap.body)
  if (cues.length === 0)
    return {
      ok: false,
      ...meta,
      failure: cap.body.trim() === '' ? 'captions_empty' : 'unparsable',
      message:
        cap.body.trim() === ''
          ? 'YouTube 这次没给字幕内容（它有时要额外校验），只拿到了标题与简介。'
          : '字幕取回来了，但格式认不出。只拿到了标题与简介。',
    }
  const { text, truncated } = cuesToText(cues)
  return {
    ok: true,
    ...meta,
    transcript: text,
    language: track.language,
    auto_generated: track.auto,
    truncated,
  }
}
