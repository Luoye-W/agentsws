/**
 * WP452：投放第二批技能在服务端的几处接线（拼卡、选了之后写回、素材疲劳那一轮）——放这里，`server.ts` 只接一下。
 */
import {
  type AdsReportRow,
  creativeFatigue,
  EXPERIMENT_VERDICT_LABEL,
  type FatigueThresholds,
  fatigueDesignNeed,
} from '@agentsws/ads-core'
import type {
  AdsBreakEvenResult,
  AdsExperimentReadoutPayload,
  AdsExperimentVerdict,
  ApprovalItem,
  CreateApprovalInput,
  CreativeFatigueRow,
  LandingCheckResult,
  ObjectRef,
  RunRequest,
} from '@agentsws/contracts'
import { ADS_SKILL_STATE } from './skill-tools.js'
import type { AdsDataRow } from './store.js'

const VERDICTS: readonly AdsExperimentVerdict[] = ['keep', 'stop', 'retest']

/** 右栏那三块读的（保本线、素材疲劳、落地页核对；没有就不给）。 */
export function adsSkillDeckData(src: { getState?<T>(key: string): T | undefined }): {
  break_even_calc?: AdsBreakEvenResult & { at?: string; margin_from?: string }
  fatigue?: CreativeFatigueRow[]
  landing?: LandingCheckResult[]
} {
  const be = src.getState?.<AdsBreakEvenResult & { at?: string; margin_from?: string }>(
    ADS_SKILL_STATE.breakEven,
  )
  const fatigue = src.getState?.<CreativeFatigueRow[]>(ADS_SKILL_STATE.fatigue)
  const landing = src.getState?.<LandingCheckResult[]>(ADS_SKILL_STATE.landing)
  return {
    ...(be === undefined ? {} : { break_even_calc: be }),
    ...(fatigue === undefined ? {} : { fatigue }),
    ...(landing === undefined ? {} : { landing }),
  }
}

/** 「保留 / 停 / 再测」卡的建卡入参（挂在这件事上；L1：人选）。 */
export function experimentReadoutCard(
  req: RunRequest,
  payload: AdsExperimentReadoutPayload,
): CreateApprovalInput<AdsExperimentReadoutPayload> {
  const rec = EXPERIMENT_VERDICT_LABEL[payload.recommended]
  return {
    workspace_id: req.workspace_id,
    schema_version: 1,
    kind: 'ads_experiment_readout',
    role_id: req.actor.role_id,
    subject: {
      object: { type: 'ad_experiment', id: payload.experiment_id ?? 'unrecorded' },
      ...(req.work_item === undefined ? {} : { matter_id: req.work_item.id as never }),
    },
    dedupe_key: `${req.workspace_id}:ads_experiment_readout:${payload.experiment_id ?? req.id}`,
    title: `实验结果：${[...payload.hypothesis].slice(0, 30).join('')}`,
    summary: `建议「${rec.split('：')[0]}」。${payload.readout.reasons[0] ?? ''}`,
    payload,
    // 建议的那一个排第一（主按钮）
    options: [payload.recommended, ...VERDICTS.filter((v) => v !== payload.recommended)].map(
      (v) => ({
        id: v,
        label: `${EXPERIMENT_VERDICT_LABEL[v]}${v === payload.recommended ? '（建议）' : ''}`,
      }),
    ),
    evidence: {
      run_id: req.id as never,
      source_events: [],
      provenance: {
        seen:
          payload.experiment_id === undefined
            ? []
            : [{ type: 'ad_experiment', id: payload.experiment_id } satisfies ObjectRef],
      },
      precheck: {},
    },
    proposer: {
      kind: 'agent',
      id: req.actor.role_id,
      assignment_id: req.actor.assignment_id as never,
    },
    // 只记结论、不改广告；但「换不换」是人的判断——L1，人选
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: req.actor.person_id as never, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 72, business_hours: true, chain: [], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
  } as unknown as CreateApprovalInput<AdsExperimentReadoutPayload>
}

/** 选了哪个 → 写回实验记忆的那一句「结果」（没选 / 驳回回 `undefined`）。 */
export function experimentResultText(item: ApprovalItem): string | undefined {
  const p = item.payload as AdsExperimentReadoutPayload | undefined
  if (p?.form !== 'ads_experiment_readout') return undefined
  if (item.state !== 'approved' && item.state !== 'approved_edited') return undefined
  const pick = item.decision?.selected_option_id as AdsExperimentVerdict | undefined
  if (pick === undefined || !VERDICTS.includes(pick)) return undefined
  const top = p.readout.comparisons
    .map(
      (c) =>
        `${c.arm} ${Math.round(c.rate * 10000) / 100}% 对基准 ${Math.round(c.control_rate * 10000) / 100}%（${c.lift_pct > 0 ? '+' : ''}${c.lift_pct}%，p=${c.p_value}）`,
    )
    .join('；')
  const label = EXPERIMENT_VERDICT_LABEL[pick].split('：')[0]
  return [
    ...`${label}。${top}${pick === p.recommended ? '' : `（建议是「${EXPERIMENT_VERDICT_LABEL[p.recommended].split('：')[0]}」）`}`,
  ]
    .slice(0, 300)
    .join('')
}

/**
 * 素材疲劳那一轮（每日止损那一轮顺带）：广告那一层近 30 天的行 → 有迹象的出建议，按开关下换素材需求单
 * （同名单设计岗那边不重下）。结论存进状态，右栏「素材疲劳」读它。
 */
export async function fatigueRound(input: {
  platform: string
  rows: readonly AdsDataRow[]
  today: string
  thresholds: FatigueThresholds
  /** 要不要自动下换素材单（`thresholds.fatigue_auto_request`，默认 1 = 要）。 */
  autoRequest: boolean
  /** 一天最多下几张（`request_design` 那一格额度）。 */
  maxRequests: number
  requestDesign?(need: { title: string; need: string }): Promise<string | undefined>
  getState<T>(key: string): T | undefined
  setState(key: string, value: unknown): void
}): Promise<CreativeFatigueRow[]> {
  const out: CreativeFatigueRow[] = []
  for (const account of new Set(input.rows.map((r) => r.account)))
    out.push(
      ...creativeFatigue({
        rows: input.rows.filter((r) => r.account === account) as AdsReportRow[],
        platform: input.platform,
        account,
        today: input.today,
        thresholds: input.thresholds,
      }),
    )
  let budget = input.maxRequests
  if (input.autoRequest && input.requestDesign !== undefined)
    for (const row of out) {
      if (budget <= 0) break
      const id = await input.requestDesign(fatigueDesignNeed(row)).catch(() => undefined)
      if (id !== undefined) {
        row.design_request_id = id
        budget -= 1
      }
    }
  const prev = input.getState<CreativeFatigueRow[]>(ADS_SKILL_STATE.fatigue) ?? []
  input.setState(ADS_SKILL_STATE.fatigue, [
    ...prev.filter((r) => r.platform !== input.platform),
    ...out,
  ])
  return out
}
