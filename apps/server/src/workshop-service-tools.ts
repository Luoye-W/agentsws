/**
 * WP390（docs/105 §4 / §7）：`find_service` / `draft_service_order` 两个工具的服务端执行器（定义在
 * `@agentsws/stand-ins` 的 `runtime/workshop-service.ts`）。
 *
 * - `find_service`：按这个品牌缓存的服务目录匹配（意向 + 这次运行的岗位，自营排第一），回白名单出参（没有后台备注、
 *   没有合作方名字）；顺手告诉模型这一轮会不会挂推荐卡。**没匹配上**的意向上报（P8：只有那句说法 + 岗位）。
 *   推荐卡挂不挂由运行时在这一轮收尾时问 {@link WorkshopServices.offerFor}（分寸都在那里判）。
 * - `draft_service_order`：出价目单 / 需求单——**只出卡，不下单**。
 */
import type { RunRequest } from '@agentsws/contracts'
import { SERVICE_PROVIDER_LABEL_TEXT, serviceStartCredits } from '@agentsws/contracts'
import {
  DRAFT_SERVICE_ORDER_TOOL,
  type DraftServiceOrderData,
  FIND_SERVICE_TOOL,
  type FindServiceData,
  type FoundService,
  isThemeRole,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { WorkshopServices } from './workshop-services.js'

/** 建站 / 网站运营那几条职责（主题副本落到它们的发布审批卡上）。 */
export const isThemeRoleId = (role_id: string): boolean => isThemeRole(role_id)

/** 这一次运行是不是在后台（定时任务 / 巡查）：后台不推（P7）。 */
export const isBackgroundRun = (req: Pick<RunRequest, 'kind' | 'trigger'>): boolean =>
  req.kind !== 'work_item' || req.trigger.source === 'schedule' || req.trigger.source === 'sentinel'

export interface WorkshopServiceToolOptions {
  /** 这个品牌那一份（没关联 / 没装配回 `undefined`）。 */
  services: (req: RunRequest) => Promise<WorkshopServices | undefined>
  /** 这次运行落在哪个岗位（模板 id）。 */
  positionOf: (req: RunRequest) => string | undefined
  /** 运行时记下「这一轮 AI 查到了哪一项」，收尾时据此挂推荐卡。 */
  onFound?: (req: RunRequest, service_id: string) => void
}

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

export function createWorkshopServiceTools(options: WorkshopServiceToolOptions): ToolExecutor {
  return async (call) => {
    const name = bare(call.name)
    const req = call.request
    const svc = await options.services(req).catch(() => undefined)
    if (svc === undefined)
      return { status: 'error', reason: 'not_connected：工坊服务要先关联 Agents 工坊账号。' }
    const position_id = options.positionOf(req)
    const actor = {
      person_id: req.actor.person_id,
      role_id: req.actor.role_id,
      assignment_id: req.actor.assignment_id,
      ...(position_id === undefined ? {} : { position_id }),
    }
    if (name === FIND_SERVICE_TOOL) {
      const intent = typeof call.input.intent === 'string' ? call.input.intent.trim() : ''
      if (intent === '')
        return { status: 'error', reason: 'invalid_input：intent 写一句意向说法。' }
      const matches = (await svc.find(intent, position_id)).slice(0, 3)
      if (matches.length === 0) {
        if (!isBackgroundRun(req)) await svc.reportIntent(intent, position_id)
        const data: FindServiceData = {
          ok: true,
          services: [],
          will_offer: false,
          message: '工坊服务里没有对应的一项。照常回答，不要推销。',
        }
        return { status: 'ok', data }
      }
      const first = matches[0]?.service
      const background = isBackgroundRun(req)
      const willOffer = first !== undefined && !background && !svc.isDeclined(first.id)
      if (first !== undefined) options.onFound?.(req, first.id)
      const services: FoundService[] = matches.map(({ service: s }) => {
        const from = serviceStartCredits(s)
        return {
          id: s.id,
          name: s.label_zh,
          kind: s.kind,
          by: SERVICE_PROVIDER_LABEL_TEXT[s.provider_label].zh,
          summary: s.summary_zh,
          ...(from === undefined ? {} : { from_credits: from }),
          ...(s.kind === 'custom'
            ? {
                questions: s.questions.map((q) => ({
                  id: q.id,
                  label: q.label_zh,
                  required: q.required === true,
                  ...(q.hint_zh === undefined ? {} : { hint: q.hint_zh }),
                  ...(q.options === undefined ? {} : { options: q.options }),
                })),
              }
            : {
                menu: (s.menu ?? []).map((m) => ({
                  id: m.id,
                  label: m.label_zh,
                  unit: m.unit_zh,
                  credits_per_unit: m.credits_per_unit,
                  min: m.min_quantity,
                  max: m.max_quantity,
                  targets: m.target_fields.map((f) => f.name),
                })),
              }),
        }
      })
      const data: FindServiceData = {
        ok: true,
        services,
        will_offer: willOffer,
        message: background
          ? '这是后台 / 定时任务：不推荐，照常做事。'
          : first !== undefined && svc.isDeclined(first.id)
            ? '用户说过这一项先不用：不要推，照常回答。'
            : '照常回答；界面会在你回答末尾挂一行推荐（同一对话只挂一次），正文里不要推销、不写风险和合作方名字。',
      }
      return { status: 'ok', data }
    }
    if (name === DRAFT_SERVICE_ORDER_TOOL) {
      const service_id = typeof call.input.service_id === 'string' ? call.input.service_id : ''
      if (service_id === '') return { status: 'error', reason: 'invalid_input：要 service_id。' }
      const lines = (Array.isArray(call.input.lines) ? call.input.lines : [])
        .map(rec)
        .filter((l) => typeof l.item_id === 'string')
        .map((l) => {
          // 两种写法都认：`[{ name, value }]`（dsh 严格参数表）或 `{ post_url: … }`
          const target = Array.isArray(l.target)
            ? Object.fromEntries(
                l.target
                  .map(rec)
                  .filter((x) => typeof x.name === 'string' && typeof x.value === 'string')
                  .map((x) => [String(x.name), String(x.value)]),
              )
            : rec(l.target)
          return {
            item_id: String(l.item_id),
            quantity: Number(l.quantity ?? 0),
            ...(Object.keys(target).length === 0 ? {} : { target }),
          }
        })
      const answers = (Array.isArray(call.input.answers) ? call.input.answers : [])
        .map(rec)
        .filter((a) => typeof a.question_id === 'string' && typeof a.answer === 'string')
        .map((a) => ({ question_id: String(a.question_id), answer: String(a.answer) }))
      try {
        const out = await svc.draftCard(
          {
            service_id,
            lines,
            answers,
            ...(req.work_item === undefined ? {} : { matter_id: req.work_item.id }),
            run_id: req.id,
          },
          actor,
        )
        const data: DraftServiceOrderData = {
          ok: true,
          form: out.form === 'service_menu' ? 'service_menu' : 'service_requirements',
          approval_item_id: out.card.id,
          message:
            '出了卡。跟用户说一声「在下面这张卡上看一眼」就停；不要说已经下单，下单要他自己点。',
        }
        return { status: 'ok', data }
      } catch (e) {
        return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
      }
    }
    return { status: 'error', reason: `unsupported_tool：${call.name}` }
  }
}
