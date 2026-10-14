/**
 * WP323（决策 665）：记录去处的**适配器**口子——去处的种类藏在通用机制后面，不内置任何一家。
 *
 * 用户交代「记到这张表」时，AI 把链接交给 {@link SinkAdapters.forUrl}，认得出的那个适配器负责：
 * 读表头（{@link SinkAdapter.inspect}）、写一行（{@link SinkAdapter.append}），以及在出问题时
 * 给出**那一家**要用户做的那一步（{@link SinkAdapter.setupHint}：权限、共享）——
 * 由 AI 在配置那一步按需转述，界面上不为任何一家单独做设置区。
 *
 * 本单实现了飞书（`feishu.ts`）；Google Sheets 与钉钉只认链接、照实说「还接不上」（留接口）。
 */
import type { SinkErrorCode, WorkspaceId } from '@agentsws/contracts'
import type { RenderedCell, TargetColumn } from './mapping.js'

export type SinkResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: SinkErrorCode; message: string }

/** 读表头读出来的那一份。 */
export interface SinkTargetInfo {
  /** 适配器 id（`feishu_bitable` / `feishu_sheet`）。 */
  adapter: string
  /** 从链接 / 接口认出来的定位（存进去处，之后写就用它）。 */
  ref: Record<string, string>
  /** 表名 / 页签名（AI 起去处名字时参考）。 */
  title?: string
  columns: TargetColumn[]
  /** 已有的几行（按列顺序转成字，给 AI 看格式）。 */
  samples: string[][]
}

export interface SinkAppendInput {
  workspace_id: WorkspaceId
  url: string
  ref: Record<string, string>
  cells: readonly RenderedCell[]
  /** 去重键（同一条记录写同一个去处永远是同一把；对方接口支持幂等就带上）。 */
  key: string
}

export interface SinkAppendResult {
  /** 对方表里那一行的引用。 */
  row_ref?: string
  /** 写完要改的定位（例如新表第一次写了表头，之后不再写）。 */
  ref_patch?: Record<string, string>
}

export interface SinkAdapter {
  /** 适配器 id（只给机器看）。一个适配器可以认几种表（飞书：多维表格 / 电子表格）。 */
  readonly id: string
  /** 认不认这个链接。 */
  matches(url: string): boolean
  inspect(workspace_id: WorkspaceId, url: string): Promise<SinkResult<SinkTargetInfo>>
  append(input: SinkAppendInput): Promise<SinkResult<SinkAppendResult>>
  /** 这一家要用户做的那一步（权限、共享、先接上应用…）；按错误种类给，没错给第一次配置的那一句。 */
  setupHint(code?: SinkErrorCode): string
}

export interface SinkAdapters {
  forUrl(url: string): SinkAdapter | undefined
  /** 去处存的是表的种类（`feishu_bitable`）；按前缀找回适配器。 */
  byKind(kind: string): SinkAdapter | undefined
  readonly all: readonly SinkAdapter[]
}

export function createSinkAdapters(list: readonly SinkAdapter[]): SinkAdapters {
  return {
    all: list,
    forUrl: (url) => list.find((a) => a.matches(url.trim())),
    byKind: (kind) => list.find((a) => kind === a.id || kind.startsWith(`${a.id}_`)),
  }
}

/** 认得链接、但这一版还写不进去的那几家（只留口子与一句实话）。 */
function notYet(id: string, host: RegExp, label: string): SinkAdapter {
  const no = <T>(): Promise<SinkResult<T>> =>
    Promise.resolve({
      ok: false,
      code: 'not_supported',
      message: `${label}这一版还写不进去。`,
    })
  return {
    id,
    matches: (url) => {
      try {
        return host.test(new URL(url).host + new URL(url).pathname)
      } catch {
        return false
      }
    },
    inspect: () => no(),
    append: () => no(),
    setupHint: () =>
      `${label}还接不上。可以先换一张飞书表，或者在「发出记录」里导出 CSV 自己贴进去。`,
  }
}

/** Google Sheets：留口子（正式做要用我们自己的 Google 应用 + 一键授权，docs/102 §5.2）。 */
export const googleSheetsPlaceholder: SinkAdapter = notYet(
  'google_sheets',
  /^docs\.google\.com\/spreadsheets\//,
  'Google 表格',
)

/** 钉钉在线文档 / 多维表：留口子（接口与授权方式待实测）。 */
export const dingtalkPlaceholder: SinkAdapter = notYet(
  'dingtalk',
  /^(alidocs\.dingtalk\.com|docs\.dingtalk\.com)\//,
  '钉钉在线表格',
)
