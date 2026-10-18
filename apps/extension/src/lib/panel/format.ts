/**
 * WP413：侧边栏上那几句短话（纯函数，测试里钉死）。界面少字：一块一行、数字说话，长说明放 `title` 提示里。
 * 时间按**这台电脑的本地时间**说（人就坐在这台电脑前）。
 */
import type {
  PanelProgress,
  PanelReadPart,
  PanelReadPartView,
  PanelWrite,
} from '@agentsws/browser-action'

export const PART_LABEL: Readonly<Record<PanelReadPart, string>> = {
  inbox: '收件箱',
  own_sub: '自家版块',
  watch_sub: '重点版块',
  external: '外部关键词',
}

/** 一块读得怎样 → 图标语气（好 / 在等 / 没读 / 要处理 / 坏了）。 */
export type PartTone = 'good' | 'wait' | 'idle' | 'warn' | 'bad'

export function partTone(p: Pick<PanelReadPartView, 'status'>): PartTone {
  switch (p.status) {
    case 'ok':
      return 'good'
    case 'waiting':
      return 'wait'
    case 'skipped':
      return 'idle'
    case 'needs_connection':
    case 'needs_setup':
      return 'warn'
    case 'failed':
      return 'bad'
  }
}

/** 一块那一行右边的字：读成了说条数（新几条），别的说状态。 */
export function partLine(p: PanelReadPartView): string {
  switch (p.status) {
    case 'ok':
      return p.fresh > 0 ? `${p.fetched} 条 · 新 ${p.fresh}` : `${p.fetched} 条`
    case 'waiting':
      return '在读…'
    case 'skipped':
      return '这次不读'
    case 'needs_connection':
      return '缺连接'
    case 'needs_setup':
      return '没设好'
    case 'failed':
      return '没读成'
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 「10:42」/「昨天 21:05」/「10-16 09:00」/「明天 09:00」（本地时间）。 */
export function clock(iso: string | undefined, now: Date = new Date()): string {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day = (x: Date): number =>
    Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000)
  const diff = day(d) - day(now)
  if (diff === 0) return hm
  if (diff === -1) return `昨天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** 进度那一块顶上一行：在读 / 上次几点读完 / 还没读过。 */
export function progressHead(p: PanelProgress, now: Date = new Date()): string {
  if (!p.configured) return '巡查还没设好'
  if (p.reading) return '正在读…'
  const done = p.last_run?.finished_at
  if (done === undefined) return '还没读过'
  return `${clock(done, now)} 读完`
}

/** 「下次约 明天 09:00」。没有就空。 */
export function nextLine(p: PanelProgress, now: Date = new Date()): string {
  return p.next_run_at === undefined ? '' : `下次约 ${clock(p.next_run_at, now)}`
}

/** 一条写现在怎样（「要你处理」里那一行的状态字）。 */
export function writeLine(w: PanelWrite): string {
  switch (w.state) {
    case 'queued':
      return '正在打开 Reddit…'
    case 'filling':
      return '填好了，去页面上点 Reply'
    case 'sent':
      return w.record_id === undefined ? '已发' : '已发 · 已记录'
    case 'failed':
      return w.message ?? '没发出去'
  }
}

export type WriteTone = 'wait' | 'good' | 'bad'

export function writeTone(w: PanelWrite): WriteTone {
  return w.state === 'sent' ? 'good' : w.state === 'failed' ? 'bad' : 'wait'
}

/** 发出记录的动作 → 人话。 */
export const ACTION_LABEL: Readonly<Record<string, string>> = {
  reply: '回复',
  comment: '回帖',
  post: '发帖',
}

/**
 * WP419：工坊里一张卡的本机地址（侧边栏「去定」打开它）。id 只认字母数字、下划线、连字符——别的一律不拼。
 */
export function workshopCardUrl(port: number, id: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id) || !Number.isInteger(port) || port <= 0 || port > 65535)
    return undefined
  return `http://127.0.0.1:${port}/cards/${id}`
}

/** WP419：起草那一头卡在哪一步——那一行的色调（要你动手的是 warn）。 */
export function stageTone(kind: string): 'warn' | 'wait' {
  return kind === 'reading_thread' || kind === 'drafting' ? 'wait' : 'warn'
}

/** WP419：一道检查 → 卡上那一枚小标签。 */
export const CHECK_LABEL: Readonly<Record<string, string>> = {
  ungrounded: '没依据的已改掉',
  persona: '口吻',
  thread: '整串没现读成',
  contradiction: '和以前说的矛盾',
}

/** WP419（决策 1231）：插件「打开发帖页」只认这几家（与契约 `SOCIAL_COMPOSE_HOSTS` 同一份写法）。 */
export const COMPOSE_HOSTS: readonly string[] = [
  'x.com',
  '*.threads.net',
  '*.linkedin.com',
  '*.facebook.com',
  '*.instagram.com',
  '*.tiktok.com',
  'studio.youtube.com',
]

/** 这个地址能不能由插件打开（https、主机在上面那张表里）。 */
export function composeUrlAllowed(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return COMPOSE_HOSTS.some((h) =>
      h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h,
    )
  } catch {
    return false
  }
}
