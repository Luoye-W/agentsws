/**
 * WP167：连接页那只邮箱卡上的三个开关（影子模式 / 挪进 KefuAgents / 标已读）。
 *
 * 老产品 KefuAgent 的四个开关里，第四个「接管」就是**这只邮箱开没开客服**——客服岗位开着
 * 就接管，那是岗位页的事，这里不另存一份（两处各存一份的话，迟早说法对不上）。
 *
 * 三件事：
 *
 * 1. **按邮箱各存一份**（键是小写地址），跟着品牌的数据目录走（一个 JSON 文件）；
 *    没有数据目录（测试）就只在内存里。
 * 2. **改了立刻生效**：消息同步每封信现查（`MailboxSync.support_mailbox`），这里不缓存给谁。
 * 3. **改开关写事件**（`mailbox.switches_changed`：谁、哪只邮箱（遮过）、改了哪几个），
 *    由装配方写——这个文件不认识事件日志。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SUPPORT_MAILBOX_DEFAULTS } from '@agentsws/channels'

/** 界面上那几个开关（`folder_enabled` 不在这里：接管 = 客服岗位开没开）。 */
export interface MailboxSwitchSettings {
  /** 只看不动：流程照跑，邮箱一下都不动。 */
  shadow_mode: boolean
  /** 客服信挪进 `KefuAgents`。 */
  move: boolean
  /** 客服信标已读。 */
  mark_read: boolean
  /**
   * WP172（docs/84 §5 第 3 条）：这只邮箱收 B2B 信（判成 B2B 的挪进 `BtoBAgents`、交给 B2B 那一路）。
   * **缺省开**：发开发信专用的那只邮箱也要开，回信会回到它那里。B2B 岗位没开时它不起作用。
   */
  b2b: boolean
}

export type MailboxSwitchPatch = Partial<MailboxSwitchSettings>

export const MAILBOX_SWITCH_KEYS: readonly (keyof MailboxSwitchSettings)[] = [
  'shadow_mode',
  'move',
  'mark_read',
  'b2b',
]

const DEFAULTS: MailboxSwitchSettings = {
  shadow_mode: SUPPORT_MAILBOX_DEFAULTS.shadow_mode,
  move: SUPPORT_MAILBOX_DEFAULTS.move,
  mark_read: SUPPORT_MAILBOX_DEFAULTS.mark_read,
  b2b: true,
}

interface StateFile {
  version: 1
  mailboxes: Record<string, MailboxSwitchPatch>
}

const keyOf = (address: string): string => address.trim().toLowerCase()

export class MailboxSwitchStore {
  private readonly file: string | undefined
  private state: StateFile

  /** `dir` 给了就落盘（`mailbox-switches.json`）；不给全内存。 */
  constructor(options: { dir?: string } = {}) {
    this.file = options.dir === undefined ? undefined : join(options.dir, 'mailbox-switches.json')
    this.state = this.load()
  }

  /** 这只邮箱现在的开关（没改过的按老产品默认值：影子关、挪信开、标已读开；WP172 收 B2B 信开）。 */
  get(address: string): MailboxSwitchSettings {
    const saved = this.state.mailboxes[keyOf(address)] ?? {}
    return {
      shadow_mode: saved.shadow_mode ?? DEFAULTS.shadow_mode,
      move: saved.move ?? DEFAULTS.move,
      mark_read: saved.mark_read ?? DEFAULTS.mark_read,
      b2b: saved.b2b ?? DEFAULTS.b2b,
    }
  }

  /** 改几个开关；回改之前、改之后与**真变了的**那几个（没变就是空数组，调用方不写事件）。 */
  set(
    address: string,
    patch: MailboxSwitchPatch,
  ): {
    before: MailboxSwitchSettings
    after: MailboxSwitchSettings
    changed: (keyof MailboxSwitchSettings)[]
  } {
    const before = this.get(address)
    const after: MailboxSwitchSettings = { ...before }
    const changed: (keyof MailboxSwitchSettings)[] = []
    for (const k of MAILBOX_SWITCH_KEYS) {
      const v = patch[k]
      if (typeof v !== 'boolean' || v === before[k]) continue
      after[k] = v
      changed.push(k)
    }
    if (changed.length > 0) {
      this.state = {
        ...this.state,
        mailboxes: { ...this.state.mailboxes, [keyOf(address)]: { ...after } },
      }
      this.save()
    }
    return { before, after, changed }
  }

  private load(): StateFile {
    const empty: StateFile = { version: 1, mailboxes: {} }
    if (this.file === undefined || !existsSync(this.file)) return empty
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>
      const mailboxes: Record<string, MailboxSwitchPatch> = {}
      for (const [k, v] of Object.entries(parsed.mailboxes ?? {})) {
        if (v === null || typeof v !== 'object') continue
        const row: MailboxSwitchPatch = {}
        for (const key of MAILBOX_SWITCH_KEYS) {
          const b = (v as Record<string, unknown>)[key]
          if (typeof b === 'boolean') row[key] = b
        }
        mailboxes[k] = row
      }
      return { version: 1, mailboxes }
    } catch {
      // 文件坏了：按默认值走（默认值就是老产品的默认值），下一次改开关时重写
      return empty
    }
  }

  private save(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`)
  }
}
