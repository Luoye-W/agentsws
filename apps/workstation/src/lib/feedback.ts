/**
 * WP475（决策 1591、1592）：左下角「反馈」的客户端。
 *
 * - 四条本机路：草稿（联系方式默认值 + 将要附上的诊断信息）、交、我的反馈、看过了；
 * - 谁都能把反馈框叫出来：左下角那颗按钮、⌘K「反馈」、铃铛里「你的反馈有了回复」（地址带 `?feedback=mine`）——
 *   都经 {@link openFeedback}，外壳里那一份 `FeedbackHost` 接着；
 * - 截图：桌面壳里一键截工坊窗口（桥上的 `captureWindow`）；浏览器里粘贴 / 拖入 / 选一张图，
 *   太大就在页面里先缩成 JPEG。
 */
import type {
  FeedbackDraftView,
  FeedbackKind,
  FeedbackScreenshot,
  LocalFeedbackItem,
  LocalFeedbackList,
  LocalFeedbackSubmit,
  LocalFeedbackSubmitted,
} from '@agentsws/contracts'
import { FEEDBACK_SCREENSHOT_MAX_BYTES } from '@agentsws/contracts'
import { api } from '@/lib/api'

export type { FeedbackDraftView, FeedbackKind, FeedbackScreenshot, LocalFeedbackItem }

export const FEEDBACK_KEY = ['feedback'] as const

export const getFeedbackDraft = (page: {
  route: string
  locale: string
  app_version?: string
  shell: 'desktop' | 'browser'
}): Promise<FeedbackDraftView> => {
  const q = new URLSearchParams({ route: page.route, locale: page.locale, shell: page.shell })
  if (page.app_version !== undefined) q.set('app_version', page.app_version)
  return api<FeedbackDraftView>(`/v1/feedback/draft?${q.toString()}`)
}

export const submitFeedback = (input: LocalFeedbackSubmit): Promise<LocalFeedbackSubmitted> =>
  api<LocalFeedbackSubmitted>('/v1/feedback', { method: 'POST', body: input })

export const listMyFeedback = (refresh: boolean): Promise<LocalFeedbackList> =>
  api<LocalFeedbackList>(`/v1/feedback${refresh ? '?refresh=1' : ''}`)

export const markFeedbackSeen = (): Promise<{ unread: number }> =>
  api<{ unread: number }>('/v1/feedback/seen', { method: 'POST' })

// ── 谁都能叫出来 ────────────────────────────────────────────────────────────

export type FeedbackTab = 'new' | 'mine'

const openers = new Set<(tab: FeedbackTab) => void>()

/** 打开反馈框（外壳里没挂 `FeedbackHost` 时什么也不做）。 */
export function openFeedback(tab: FeedbackTab = 'new'): void {
  for (const fn of openers) fn(tab)
}

export function onOpenFeedback(fn: (tab: FeedbackTab) => void): () => void {
  openers.add(fn)
  return () => {
    openers.delete(fn)
  }
}

/** 地址上的 `?feedback=1` / `?feedback=mine`（铃铛、托盘带过来的）。 */
export function feedbackTabOf(param: string | null): FeedbackTab | undefined {
  if (param === null) return undefined
  return param === 'mine' ? 'mine' : 'new'
}

// ── 截图 ──────────────────────────────────────────────────────────────────

type CaptureFn = () => Promise<{ content_type: 'image/jpeg'; data_base64: string } | null>

/** 桌面壳的一键截窗口（旧壳 / 浏览器里没有）。 */
export function captureBridge(): CaptureFn | undefined {
  const w = globalThis.window as unknown as { agentsws?: { captureWindow?: unknown } } | undefined
  const fn = w?.agentsws?.captureWindow
  return typeof fn === 'function' ? (fn.bind(w?.agentsws) as CaptureFn) : undefined
}

/** 在桌面壳里吗（有桥就算）。 */
export function inDesktop(): boolean {
  const w = globalThis.window as unknown as { agentsws?: unknown } | undefined
  return w?.agentsws !== undefined
}

/** 截图最长边（与桌面壳一致）。 */
export const SHOT_MAX_EDGE = 1600

const DIRECT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('read failed'))
    }
    reader.readAsDataURL(blob)
  })

/** 缩到最长边 1600 再编 JPEG（太大的图、不认的格式都走这里）。 */
async function shrink(blob: Blob): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined
  const bmp = await createImageBitmap(blob)
  const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob | undefined>((resolve) => {
    canvas.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.82)
  })
}

/** 粘贴 / 拖入 / 选的一张图 → 能附上的截图；不是图、太大缩不下来回 `undefined`。 */
export async function imageToScreenshot(blob: Blob): Promise<FeedbackScreenshot | undefined> {
  if (!blob.type.startsWith('image/')) return undefined
  const direct = (DIRECT_TYPES as readonly string[]).includes(blob.type)
  try {
    if (direct && blob.size <= FEEDBACK_SCREENSHOT_MAX_BYTES / 2)
      return {
        content_type: blob.type as FeedbackScreenshot['content_type'],
        data_base64: await toBase64(blob),
      }
    const small = await shrink(blob)
    if (small === undefined || small.size > FEEDBACK_SCREENSHOT_MAX_BYTES) return undefined
    return { content_type: 'image/jpeg', data_base64: await toBase64(small) }
  } catch {
    return undefined
  }
}

/** 预览用的地址。 */
export const screenshotUrl = (s: FeedbackScreenshot): string =>
  `data:${s.content_type};base64,${s.data_base64}`
