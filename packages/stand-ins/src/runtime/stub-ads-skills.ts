/**
 * WP452（docs/109 §5.2 #12–15）：stub 运行时里投放第二批技能的演示剧本——体检、保本线、广告与落地页、实验读结果。
 *
 * 话里点到哪样就走哪样（都没点到回 `undefined`，照旧走查数 → 止损那套）。**stub 不编数**：工具要的数只从话里
 * 原样抽（「客单价 39」「毛利 40%」「基准 21200/424」），抽不到就不给，让工具照实列缺什么；回的话里每个数都来自工具。
 */
import {
  CALC_BREAK_EVEN_TOOL,
  CHECK_AD_LANDING_TOOL,
  DESIGN_ADS_EXPERIMENT_TOOL,
  READ_ADS_EXPERIMENT_TOOL,
  RUN_ADS_AUDIT_TOOL,
} from './ads-data.js'
import type { ToolExecution } from './stub.js'
import type { ScriptOutcome, ScriptStep } from './stub-ads-amazon.js'

type Exec = (step: ScriptStep) => Promise<ToolExecution>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const numIn = (text: string, re: RegExp): number | undefined => {
  const m = re.exec(text)
  return m?.[1] === undefined ? undefined : Number(m[1])
}
const bare = (t: string): string => (t.includes('.') ? t.slice(t.lastIndexOf('.') + 1) : t)

const VERDICT_ZH: Record<string, string> = { keep: '保留', stop: '停', retest: '再测' }

/** 话里点到的那一样（工具面里得真有）。 */
function pick(text: string, allow: ReadonlySet<string>): string | undefined {
  if (/实验/u.test(text) && /结果/u.test(text) && allow.has(READ_ADS_EXPERIMENT_TOOL))
    return READ_ADS_EXPERIMENT_TOOL
  if (/落地页|landing/iu.test(text) && allow.has(CHECK_AD_LANDING_TOOL))
    return CHECK_AD_LANDING_TOOL
  if (/保本|盈亏|break-?even|目标\s*CPA/iu.test(text) && allow.has(CALC_BREAK_EVEN_TOOL))
    return CALC_BREAK_EVEN_TOOL
  if (/体检|audit|check-?up/iu.test(text) && allow.has(RUN_ADS_AUDIT_TOOL))
    return RUN_ADS_AUDIT_TOOL
  return undefined
}

export async function runAdsSkillScript(
  exec: Exec,
  text: string,
  allowList: readonly string[],
): Promise<ScriptOutcome | undefined> {
  const allow = new Set(allowList.map(bare))
  const tool = pick(text, allow)
  if (tool === undefined) return undefined
  const readTools: string[] = []
  const staged: string[] = []
  const fail = (r: ToolExecution): ScriptOutcome => ({
    answer: `这一步没走通：${r.reason ?? '工具没回数'}。`,
    staged,
    readTools,
  })

  if (tool === RUN_ADS_AUDIT_TOOL) {
    const r = await exec({ tool, input: {} })
    if (r.status !== 'ok' || !isRecord(r.data)) return fail(r)
    readTools.push(tool)
    if (typeof r.data.app_only === 'string') return { answer: r.data.app_only, staged, readTools }
    const items = (Array.isArray(r.data.items) ? r.data.items : []).filter(isRecord)
    const v = isRecord(r.data.verdicts) ? r.data.verdicts : {}
    const bad = items.filter((i) => i.verdict === 'fail')
    return {
      answer: [
        `体检：过 ${v.pass ?? 0}、不过 ${v.fail ?? 0}、未知 ${v.unknown ?? 0}。`,
        ...bad.map((i) => `不过：${isRecord(i.title) ? i.title.zh : ''}——${String(i.note ?? '')}`),
        '未知的那几项没有证据，我不下结论；去后台哪一页看写在右栏「体检」里。',
      ].join('\n'),
      staged,
      readTools,
    }
  }

  if (tool === CALC_BREAK_EVEN_TOOL) {
    const input: Record<string, number> = {}
    const put = (k: string, v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v)) input[k] = v
    }
    put('aov', numIn(text, /客单价\s*\$?\s*(\d+(?:\.\d+)?)/u))
    put('gross_margin_pct', numIn(text, /毛利(?:率)?\s*(\d+(?:\.\d+)?)\s*%/u))
    put('cogs', numIn(text, /货本\s*\$?\s*(\d+(?:\.\d+)?)/u))
    put('shipping', numIn(text, /运费\s*\$?\s*(\d+(?:\.\d+)?)/u))
    put('payment_fee_pct', numIn(text, /手续费\s*(\d+(?:\.\d+)?)\s*%/u))
    put('return_rate_pct', numIn(text, /退货(?:率)?\s*(\d+(?:\.\d+)?)\s*%/u))
    put('target_profit_pct', numIn(text, /利润\s*(\d+(?:\.\d+)?)\s*%/u))
    const r = await exec({ tool, input })
    if (r.status !== 'ok' || !isRecord(r.data)) return fail(r)
    readTools.push(tool)
    const d = r.data
    const ask = Array.isArray(d.ask) ? d.ask.map(String) : []
    if (d.computable !== true)
      return {
        answer: `算不了：${String(d.note ?? '')}${ask.length > 0 ? ` 还缺：${ask.join('、')}。` : ''}`,
        staged,
        readTools,
      }
    return {
      answer: [
        `保本 ROAS ${String(d.break_even_roas)}，保本 CPA ${String(d.break_even_cpa)}。`,
        ...(d.target_cpa === undefined
          ? []
          : [`目标 CPA ${String(d.target_cpa)}，目标 ROAS ${String(d.target_roas)}。`]),
        String(d.formula ?? ''),
        ...(ask.length === 0
          ? []
          : [`这几项你还没给，我没算：${ask.join('、')}——告诉我数再算一次。`]),
      ].join('\n'),
      staged,
      readTools,
    }
  }

  if (tool === CHECK_AD_LANDING_TOOL) {
    const url = /https?:\/\/[^\s，。」]+/u.exec(text)?.[0]
    const quoted = [...text.matchAll(/「([^」]+)」/gu)].map((m) => m[1] as string)
    if (url === undefined || quoted.length === 0)
      return {
        answer: '要核对的话，把落地页网址和广告文案（用「」括起来）发给我。',
        staged,
        readTools,
      }
    const r = await exec({
      tool,
      input: { url, ad_label: quoted[0]?.slice(0, 30), texts: quoted },
    })
    if (r.status !== 'ok' || !isRecord(r.data)) return fail(r)
    readTools.push(tool)
    const items = (Array.isArray(r.data.items) ? r.data.items : []).filter(isRecord)
    const opened = (Array.isArray(r.data.opened) ? r.data.opened : []).filter(isRecord)
    return {
      answer: [
        ...items.map((i) => `- ${String(i.note ?? '')}`),
        ...opened.map((o) =>
          o.fix === 'page'
            ? '要改页面的已经交给网站运营开了一件事。'
            : '要改广告的给我自己开了一件事。',
        ),
      ].join('\n'),
      staged,
      readTools,
    }
  }

  // 实验读结果：先按话里的数设计（记进实验记忆），再读结果出卡
  const pairs = [...text.matchAll(/(\d+)\s*\/\s*(\d+)/gu)].map((m) => [Number(m[1]), Number(m[2])])
  const base = pairs[0]
  const variant = pairs[1]
  const mde = numIn(text, /提升\s*(\d+(?:\.\d+)?)\s*%/u)
  const daily = numIn(text, /每天\s*(\d+)/u)
  if (base === undefined || variant === undefined || mde === undefined || daily === undefined)
    return {
      answer:
        '读结果要这几样：基准和新版各自的「展示 / 点击」（比如 21200/424），想看出的提升（比如提升 20%），每天的量（比如每天 6000）。',
      staged,
      readTools,
    }
  const d = await exec({
    tool: DESIGN_ADS_EXPERIMENT_TOOL,
    input: {
      hypothesis: /假设[:：]\s*([^，。\n]+)/u.exec(text)?.[1] ?? '新版点击率更高',
      change: /改了[:：]\s*([^，。\n]+)/u.exec(text)?.[1] ?? '只换了一样',
      metric: 'ctr',
      baseline_rate: (base[1] as number) / (base[0] as number),
      mde_rel_pct: mde,
      daily_units: daily,
    },
  })
  if (d.status !== 'ok' || !isRecord(d.data) || typeof d.data.experiment_id !== 'string')
    return fail(d)
  readTools.push(DESIGN_ADS_EXPERIMENT_TOOL)
  const r = await exec({
    tool: READ_ADS_EXPERIMENT_TOOL,
    input: {
      experiment_id: d.data.experiment_id,
      arms: [
        { id: 'base', label: '基准', units: base[0], successes: base[1] },
        { id: 'v1', label: '新版', units: variant[0], successes: variant[1] },
      ],
    },
  })
  if (r.status !== 'ok' || !isRecord(r.data)) return fail(r)
  readTools.push(READ_ADS_EXPERIMENT_TOOL)
  const readout = isRecord(r.data.readout) ? r.data.readout : {}
  const reasons = Array.isArray(readout.reasons) ? readout.reasons.map(String) : []
  return {
    answer: [
      `建议「${VERDICT_ZH[String(readout.verdict)] ?? '再测'}」。`,
      ...reasons,
      typeof r.data.card_id === 'string'
        ? '出了一张「保留 / 停 / 再测」卡，你选了我就记进实验记忆（不改广告）。'
        : String(r.data.message ?? ''),
    ].join('\n'),
    staged,
    readTools,
  }
}
