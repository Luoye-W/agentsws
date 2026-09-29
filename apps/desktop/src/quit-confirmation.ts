/**
 * WP184（docs/79 §3.1）：退出前问一句——官方场景里可能有正在跑的任务。
 *
 * 移植自官方桌面端（MIT）`deepseek-ai/deepseek-harness@4878cdabd87d4041bdaff61d04c966883b9fd07a`
 * `apps/desktop/src/quit-confirmation.ts`：`resolveDesktopQuitPrompt` 与「一次只开一个确认框、
 * 重复点退出就把那个框提到前面」的类，原样搬；只把文案表与 electron 类型换成我们自己的。
 *
 * 官方是在自己的 Host 进程里挂了一个查询口（`apps/desktop-host/src/quit-inspection.ts`）问
 * 「有没有在跑的任务 / 定时提醒」；我们起的是标准 `dsh --profile web`，没有那条进程内通道，
 * 所以只要有官方场景在跑，查询就回 `unknown`——照官方的规矩，查不到当作「可能有任务」，问一句再退。
 */

/** 退出现在会影响到什么。 */
export interface DesktopQuitInspection {
  activeTasks: boolean
  scheduledTasks: boolean
}

export type DesktopQuitPrompt =
  | 'quitActiveTasks'
  | 'quitScheduledTasks'
  | 'quitActiveAndScheduledTasks'
  | undefined

/** 查询结果 → 用哪句话问；查不到（`unknown`）按「有任务在跑」问，不悄悄退出。 */
export function resolveDesktopQuitPrompt(
  inspection: DesktopQuitInspection | 'unknown',
): DesktopQuitPrompt {
  if (inspection === 'unknown') return 'quitActiveTasks'
  if (inspection.activeTasks && inspection.scheduledTasks) return 'quitActiveAndScheduledTasks'
  if (inspection.activeTasks) return 'quitActiveTasks'
  if (inspection.scheduledTasks) return 'quitScheduledTasks'
  return undefined
}

export interface QuitMessages {
  title: string
  message: string
  quitActiveTasks: string
  quitScheduledTasks: string
  quitActiveAndScheduledTasks: string
  quit: string
  cancel: string
}

export interface QuitBoxOptions {
  type: 'warning' | 'none'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

export interface DesktopQuitConfirmationOptions {
  messages: () => QuitMessages
  /** 开始一次查询；没有官方场景在跑时回 `undefined`（直接退）。 */
  inspect: () => Promise<DesktopQuitInspection | 'unknown'> | undefined
  /** 原生消息框（不挂在哪个窗口上：隐藏的窗口保持隐藏，框自己到最前）。 */
  show: (options: QuitBoxOptions) => Promise<{ response: number }>
  /** 框已经开着时又点了一次退出：把它提到前面。 */
  focus: () => void
  platform?: string
}

/** 一次只做一个退出决定；重复的退出请求加入正开着的那个，不叠框。 */
export class DesktopQuitConfirmation {
  private pending: Promise<boolean> | undefined
  private disposed = false

  constructor(private readonly options: DesktopQuitConfirmationOptions) {}

  /** `true` = 现在退；`false` = 用户点了取消。 */
  confirm(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.pending !== undefined) {
      this.options.focus()
      return this.pending
    }
    const pending = this.decide().finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  /** 走了不问的退出路径（系统关机等）：没决定完的一律算 `false`，之后的也不再开框。 */
  dispose(): void {
    this.disposed = true
  }

  private async decide(): Promise<boolean> {
    const inspection = this.options.inspect()
    if (inspection === undefined) return true
    const prompt = resolveDesktopQuitPrompt(await inspection.catch(() => 'unknown' as const))
    if (this.disposed) return false
    if (prompt === undefined) return true
    const messages = this.options.messages()
    const windows = (this.options.platform ?? process.platform) === 'win32'
    // 按钮顺序随平台：macOS 从右往左排（「退出」在「取消」右边），Windows 按数组顺序
    const result = await this.options.show({
      type: windows ? 'none' : 'warning',
      title: messages.title,
      message: messages.message,
      detail: messages[prompt],
      buttons: [messages.quit, messages.cancel],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (this.disposed) return false
    return result.response === 0
  }
}
