/**
 * WP420（自查 ads-amazon A11 / B2 / U23）：stub 运行时的**投放**与 **Amazon 运营**两套演示剧本。
 *
 * 以前：投放职责在演示里一句「还没有剧本」，查数 → 止损那条路一次都没走过；亚马逊店铺运营整域被映射到
 * 客服剧本，说「看看我的 Listing」出一张「回复草稿（收件人待定）」邮件卡，完全不对题。现在：
 *
 * - 投放（Google / Meta）：`query_ads_data` 查今天 → 判据越线的逐条 `stage_ads_stop_loss` 出止损卡
 *   （服务端照常过 guardrail，L3 自动）→ 一段话说今天花了多少、总闸还剩多少、停了哪几条；
 * - Amazon 运营：说到词 → 看词库（没有就刷新一次）；别的 → 看 Listing 体检（没体检过就体检一次；没设自家 ASIN
 *   → 工具回 `needs_setup`，运行时收尾出方案卡）。
 *
 * stub 不会编数：话里每个数都来自工具回的数据，拿不到就照实说拿不到。
 */
import type { RunRequest } from '@agentsws/contracts'
import { QUERY_ADS_DATA_TOOL, STAGE_ADS_STOP_LOSS_TOOL } from './ads-data.js'
import { READ_AMAZON_COMPETITORS_TOOL } from './amazon-competitor.js'
import { GET_AMAZON_KEYWORDS_TOOL, READ_AMAZON_KEYWORDS_TOOL } from './amazon-keywords.js'
import { GET_LISTING_CHECKUP_TOOL, READ_AMAZON_LISTINGS_TOOL } from './amazon-listing.js'
import type { ToolExecution } from './stub.js'

export interface ScriptStep {
  tool: string
  input: Record<string, unknown>
}

/** 跑完一套剧本回的东西（stub 主体照它出事件、收尾）。 */
export interface ScriptOutcome {
  answer: string
  staged: string[]
  readTools: string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const strOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 这条职责在演示里走哪套（不归这两套回 `undefined`）。工具面里得真有那个工具。 */
export function adsAmazonScriptOf(req: RunRequest): 'ads' | 'amazon' | undefined {
  const allow = new Set(
    req.tools.allow.map((t) => (t.includes('.') ? t.slice(t.lastIndexOf('.') + 1) : t)),
  )
  const role = req.actor.role_id
  if ((role === 'ads.google' || role === 'ads.meta') && allow.has(QUERY_ADS_DATA_TOOL)) return 'ads'
  if (
    role === 'amz.store' &&
    (allow.has(GET_LISTING_CHECKUP_TOOL) || allow.has(GET_AMAZON_KEYWORDS_TOOL))
  )
    return 'amazon'
  return undefined
}

type Exec = (step: ScriptStep) => Promise<ToolExecution>

/** 投放：查今天 → 越线的出止损卡 → 一段话。 */
export async function runAdsScript(exec: Exec): Promise<ScriptOutcome> {
  const readTools: string[] = []
  const staged: string[] = []
  const q = await exec({ tool: QUERY_ADS_DATA_TOOL, input: { period: 'today' } })
  if (q.status !== 'ok' || !isRecord(q.data))
    return { answer: `没查到广告数据：${q.reason ?? '这一步没走通'}。`, staged, readTools }
  readTools.push(QUERY_ADS_DATA_TOOL)
  const d = q.data
  if (d.needs_setup !== undefined) return { answer: '还没设是哪个广告账户。', staged, readTools }
  if (d.needs_connection !== undefined || d.connection_card === true)
    return {
      answer: '插件还没连上你的广告后台，今天的数导不进来：已出一张连接卡，连好我接着查。',
      staged,
      readTools,
    }
  const gate = isRecord(d.spend_gate) ? d.spend_gate : {}
  const spent = num(gate.spent)
  const remaining = num(gate.remaining)
  const lines: string[] = []
  lines.push(
    spent === undefined
      ? '今天还没有花费的数。'
      : `今天一共花了 ${spent}${remaining === undefined ? '' : `，总闸还剩 ${remaining}`}。`,
  )
  const stops = (Array.isArray(d.stop_loss) ? d.stop_loss : []).filter(isRecord)
  const hits = stops.filter((s) => s.outcome === 'trigger')
  for (const s of hits) {
    const id = strOf(s.campaign_id)
    if (id === undefined) continue
    const r = await exec({ tool: STAGE_ADS_STOP_LOSS_TOOL, input: { campaign_id: id } })
    const data = isRecord(r.data) ? r.data : {}
    const change = strOf(data.change_id)
    if (r.status === 'ok' && data.staged === true && change !== undefined) {
      staged.push(change)
      lines.push(`止损：「${strOf(s.name) ?? id}」${strOf(s.reason) ?? ''}——已出止损卡。`)
    } else
      lines.push(
        `止损：「${strOf(s.name) ?? id}」判据成立，但没出成卡（${strOf(data.message) ?? r.reason ?? '没走通'}）。`,
      )
  }
  if (hits.length === 0)
    lines.push(
      stops.length === 0
        ? '没有在跑、今天有花费的广告系列，不用判止损。'
        : '没有越线的广告系列，不用止损。',
    )
  return { answer: lines.join('\n'), staged, readTools }
}

const KEYWORD_RE = /词|关键词|keyword/iu
const COMPETITOR_RE = /竞品|对标|competitor/iu

/** Amazon 运营：竞品 / 词库 / Listing 体检。 */
export async function runAmazonScript(
  exec: Exec,
  text: string,
  allow: readonly string[] = [],
): Promise<ScriptOutcome> {
  const readTools: string[] = []
  const staged: string[] = []
  if (COMPETITOR_RE.test(text) && allow.some((t) => t.endsWith(READ_AMAZON_COMPETITORS_TOOL))) {
    const r = await exec({ tool: READ_AMAZON_COMPETITORS_TOOL, input: {} })
    if (r.status !== 'ok' || !isRecord(r.data))
      return { answer: `没读成竞品：${r.reason ?? '这一步没走通'}。`, staged, readTools }
    readTools.push(READ_AMAZON_COMPETITORS_TOOL)
    const d = r.data
    return {
      answer:
        d.needs_setup !== undefined
          ? '还没定盯哪几款对标款。'
          : (strOf(d.say) ?? strOf(d.message) ?? '读了一次，变化在右边面板「竞品动向」里。'),
      staged,
      readTools,
    }
  }
  if (KEYWORD_RE.test(text)) {
    let r = await exec({ tool: GET_AMAZON_KEYWORDS_TOOL, input: {} })
    if (r.status === 'ok' && isRecord(r.data) && r.data.ok === false) {
      readTools.push(GET_AMAZON_KEYWORDS_TOOL)
      r = await exec({ tool: READ_AMAZON_KEYWORDS_TOOL, input: {} })
    }
    if (r.status !== 'ok' || !isRecord(r.data))
      return { answer: `没看成词库：${r.reason ?? '这一步没走通'}。`, staged, readTools }
    readTools.push(GET_AMAZON_KEYWORDS_TOOL)
    const total = num(r.data.total)
    const gaps = num(r.data.gap_terms)
    return {
      answer:
        total === undefined
          ? `词库还是空的：${strOf(r.data.message) ?? '没刷新成'}。`
          : `词库里 ${total} 个词，${gaps ?? 0} 个是竞品写了、你没写的差距词。详细在右边面板「词库」里。`,
      staged,
      readTools,
    }
  }
  let r = await exec({ tool: GET_LISTING_CHECKUP_TOOL, input: {} })
  if (r.status === 'ok' && isRecord(r.data) && r.data.ok === false) {
    readTools.push(GET_LISTING_CHECKUP_TOOL)
    r = await exec({ tool: READ_AMAZON_LISTINGS_TOOL, input: {} })
  }
  if (r.status !== 'ok' || !isRecord(r.data))
    return { answer: `没体检成：${r.reason ?? '这一步没走通'}。`, staged, readTools }
  readTools.push(GET_LISTING_CHECKUP_TOOL)
  const d = r.data
  if (d.needs_setup !== undefined)
    return {
      answer:
        // WP420（自查 U16）：「在下面这张卡上点头」卡头已经说了，这里不再说一遍
        '还不知道你在 Amazon 上卖的是哪几个商品。',
      staged,
      readTools,
    }
  const sum = isRecord(d.summary) ? d.summary : {}
  const checked = num(sum.checked)
  const issues = num(sum.issues)
  if (checked === undefined)
    return {
      answer: strOf(d.message) ?? strOf(d.stopped_message) ?? '这次没读到页面。',
      staged,
      readTools,
    }
  return {
    answer: `体检了 ${checked} 个 ASIN，${issues ?? 0} 处要改。每处的出处和建议在右边面板「Listing 体检」里。`,
    staged,
    readTools,
  }
}
