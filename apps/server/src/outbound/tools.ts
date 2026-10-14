/**
 * WP323：Run 里**记录去处**的三个工具真接上（定义在 `@agentsws/stand-ins` 的 `runtime/record-sink.ts`）。
 *
 * 这里没有业务逻辑，只做三件事：
 * 1. **按这次运行所在的品牌**找发出记录（`request.workspace_id`）；
 * 2. **白名单出参**：列名、填什么、去处名字与状态、一句原因与那一家要做的那一步——不带表格的 token、
 *    不带应用凭据、不带任何记录正文；
 * 3. **失败说人话**。配置只出「定规矩」卡（`propose`），工具本身不让任何去处生效。
 */
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import {
  LIST_RECORD_SINKS_TOOL,
  PROPOSE_RECORD_SINK_TOOL,
  READ_RECORD_TARGET_TOOL,
} from '@agentsws/stand-ins'
import type { OutboundLog } from './log.js'
import { sourceLabel } from './mapping.js'

const STATE_ZH: Readonly<Record<string, string>> = {
  pending_confirm: '等你确认',
  active: '在记',
  paused: '停了',
  broken: '写不进去',
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

/** 模型给的一列（扁平写法）→ 对照里的来源（服务端再校验一遍）。 */
function columnOf(raw: unknown): { column: string; source: unknown } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const column = str(o.column)
  if (column === undefined) return undefined
  if (o.empty === true) return { column, source: { empty: true } }
  if (typeof o.value === 'string' && o.field === undefined)
    return { column, source: { value: o.value } }
  return {
    column,
    source: {
      field: o.field,
      format: {
        ...(o.date === undefined ? {} : { date: o.date }),
        ...(o.max_chars === undefined ? {} : { max_chars: o.max_chars }),
        ...(o.map === undefined ? {} : { map: o.map }),
      },
    },
  }
}

export function createRecordSinkToolExecutor(options: {
  /** 懒取：发出记录比运行时晚建。 */
  log(): OutboundLog | undefined
}): ToolExecutor {
  return async (call): Promise<ToolExecution> => {
    const log = options.log()
    if (log === undefined) return { status: 'error', reason: '这个进程没接发出记录' }
    const ws = call.request.workspace_id
    const input = (call.input ?? {}) as Record<string, unknown>
    switch (bare(call.name)) {
      case READ_RECORD_TARGET_TOOL: {
        const url = str(input.url)
        if (url === undefined) return { status: 'error', reason: '缺表格链接' }
        const r = await log.inspect(ws, url)
        if (!r.ok)
          return {
            status: 'ok',
            data: {
              ok: false,
              message: r.message,
              ...(r.hint === undefined ? {} : { hint: r.hint }),
            },
          }
        return {
          status: 'ok',
          data: {
            ok: true,
            ...(r.title === undefined ? {} : { title: r.title }),
            columns: r.columns,
            samples: r.samples,
            fields: r.fields,
          },
        }
      }
      case PROPOSE_RECORD_SINK_TOOL: {
        const url = str(input.url)
        if (url === undefined) return { status: 'error', reason: '缺表格链接' }
        const columns = Array.isArray(input.columns)
          ? input.columns.map(columnOf).filter((c) => c !== undefined)
          : undefined
        const channels = strings(input.channels)
        const actions = strings(input.actions)
        const actor = call.request.actor
        const r = await log.propose(ws, {
          url,
          instruction: str(input.instruction) ?? '',
          ...(str(input.name) === undefined ? {} : { name: str(input.name) as string }),
          ...(columns === undefined ? {} : { columns }),
          filter: {
            ...(channels === undefined ? {} : { channels }),
            ...(actions === undefined ? {} : { actions }),
          },
          ...(str(input.sink_id) === undefined ? {} : { sink_id: str(input.sink_id) as string }),
          actor: {
            person_id: actor.person_id,
            assignment_id: actor.assignment_id,
            role_id: actor.role_id,
            ...(call.request.work_item?.id === undefined
              ? {}
              : { matter_id: call.request.work_item.id }),
          },
        })
        if (!r.ok)
          return {
            status: 'ok',
            data: {
              ok: false,
              message: r.message,
              ...(r.hint === undefined ? {} : { hint: r.hint }),
            },
          }
        return {
          status: 'ok',
          data: {
            ok: true,
            name: r.name,
            revision: r.revision,
            card: r.card_id !== undefined,
            columns: r.columns,
            unknown: r.unknown,
            preview: r.preview,
            preview_is_sample: r.sample,
          },
        }
      }
      case LIST_RECORD_SINKS_TOOL:
        return {
          status: 'ok',
          data: {
            sinks: log.sinks(ws).map((s) => ({
              id: s.id,
              name: s.name,
              state: STATE_ZH[s.state] ?? s.state,
              written: s.written,
              pending: s.pending,
              columns: s.columns.map((c) => ({ column: c.column, fill: sourceLabel(c.source) })),
              ...(s.last_error === undefined ? {} : { problem: s.last_error.message }),
            })),
          },
        }
      default:
        return { status: 'error', reason: 'unsupported_tool' }
    }
  }
}
