/**
 * 上传表的本地校验（docs/101 §5.1② 第 2 步）。
 *
 * 在交给插件之前先在本机查一遍：字数、必填、文案禁用词、编号、预算额度。
 * `error` 级的一条都不放行（{@link buildAdUploadBundle} 有错就不出表）；
 * `warning` 照出，但原样上卡面让人看见。
 *
 * 「新建一律暂停」不在这里查 op——op 里压根没有让调用方写状态的格子；
 * 生成器写完表以后再按**表里的行**复查一遍（`checkNewRowsPaused`，在 build 里）。
 */

import { AD_COPY_FORBIDDEN } from '@agentsws/core'
import { budgetDelta, daySpendGate } from '../budget.js'
import { checkAdCopy } from '../variants.js'
import { META_CALL_TO_ACTIONS } from './meta-columns.js'
import type { AdEntityRef, AdSheetOp, SheetContext, SheetPlatform, SheetProblem } from './types.js'

/** 自适应搜索广告的硬上限（[关于自适应搜索广告](https://support.google.com/google-ads/answer/7684791?hl=en)）。 */
export const GOOGLE_RSA_LIMITS = {
  headlines: { min: 3, max: 15, chars: 30 },
  descriptions: { min: 2, max: 4, chars: 90 },
  path_chars: 15,
} as const

/**
 * Meta 的建议字数（与 `spec.ts` 里 Meta 信息流那一条同数）。超了平台会折叠 / 截断，
 * 不拦，只提醒。
 */
export const META_COPY_LIMITS = { body: 125, title: 40 } as const

/** 一次改到这么多条就必须走上传表（决策 552）。 */
export const SHEET_THRESHOLD = 3

const DOUBLE_WIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u

/**
 * Google 的字数算法：中日韩等双宽字每个算 2（[关于文字广告](https://support.google.com/google-ads/answer/1704389?hl=en)）。
 */
export function googleTextLength(text: string): number {
  let n = 0
  for (const ch of text) n += DOUBLE_WIDTH.test(ch) ? 2 : 1
  return n
}

/**
 * 这一批改动走上传表还是让插件直接点（决策 552）。
 *
 * 只有「暂停 / 启用、改预算」两类、而且不到 3 条的才直接点；有新建、或 3 条以上一律走表。
 */
export function routeAdChange(ops: readonly AdSheetOp[]): {
  route: 'sheet' | 'form'
  reason: string
} {
  if (ops.some((op) => op.kind.startsWith('create_') || op.kind === 'add_keyword'))
    return { route: 'sheet', reason: '里面有新建，一律走上传表（平台会先给预览，确认了才生效）。' }
  if (ops.length >= SHEET_THRESHOLD)
    return { route: 'sheet', reason: `一次改 ${ops.length} 条，3 条以上走上传表。` }
  return { route: 'form', reason: `只有 ${ops.length} 条暂停 / 改预算，插件直接点。` }
}

/** 找出文案里命中的禁用词（与 guardrail 那道 block 同一份词表）+ 品牌禁用词。 */
export function forbiddenCopyHits(text: string, bannedTerms: readonly string[] = []): string[] {
  const lower = text.toLowerCase()
  return [...AD_COPY_FORBIDDEN, ...bannedTerms].filter(
    (w) => w.trim() !== '' && lower.includes(w.trim().toLowerCase()),
  )
}

const isHttpUrl = (u: string): boolean => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u.trim())
const isDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d)

/** 逐条查。回来的是全部问题（不在第一条就停，卡面上一次看全）。 */
export function validateAdSheetOps(
  platform: SheetPlatform,
  ops: readonly AdSheetOp[],
  ctx: SheetContext = {},
): SheetProblem[] {
  const problems: SheetProblem[] = []
  if (ops.length === 0)
    problems.push({ severity: 'error', code: 'empty', message: '这张表里一条改动都没有。' })
  ops.forEach((op, i) => {
    const push = (
      severity: SheetProblem['severity'],
      code: string,
      message: string,
      field?: string,
    ): void => {
      problems.push({
        severity,
        code,
        op_index: i,
        ...(field === undefined ? {} : { field }),
        message,
      })
    }
    checkOp(platform, op, ctx, push)
  })
  checkDuplicates(ops, problems)
  checkSpendGate(platform, ops, ctx, problems)
  return problems
}

type Push = (
  severity: SheetProblem['severity'],
  code: string,
  message: string,
  field?: string,
) => void

/** 名字：不能空，不能带换行 / 制表符（会把表拆坏）。 */
function checkName(value: string | undefined, what: string, field: string, push: Push): void {
  if (value === undefined || value.trim() === '')
    push('error', 'missing', `${what}没写名字。`, field)
  else if (/[\t\r\n]/.test(value))
    push('error', 'bad_char', `${what}「${value}」里有换行或制表符。`, field)
}

/** 文案：禁用词拦，承诺类说法提醒；Google 不许以 `=` / `@` 开头（表格软件会当公式）。 */
function checkCopy(
  platform: SheetPlatform,
  text: string,
  field: string,
  ctx: SheetContext,
  push: Push,
): void {
  const hits = forbiddenCopyHits(text, ctx.banned_terms)
  if (hits.length > 0)
    push(
      'error',
      'forbidden_copy',
      `「${text}」里有禁用词（${hits.join('、')}）。广告挂在付费流量上给所有人看，这类话不写。`,
      field,
    )
  const scan = checkAdCopy(text)
  if (!scan.ok && hits.length === 0)
    push(
      'warning',
      'commitment_copy',
      `「${text}」读起来像在承诺（${scan.hits.join('、')}），请人看一眼。`,
      field,
    )
  if (platform === 'google' && /^[=@]/.test(text))
    push('error', 'formula_like', `「${text}」以 = 或 @ 开头，表格软件会把它当公式。`, field)
}

function checkLen(
  text: string,
  max: number,
  what: string,
  field: string,
  push: Push,
  google: boolean,
): void {
  const n = google ? googleTextLength(text) : [...text].length
  if (n > max)
    push(
      google ? 'error' : 'warning',
      'too_long',
      google
        ? `${what}「${text}」算 ${n} 个字符，Google 最多 ${max}（中日韩字算 2 个），会被拒。`
        : `${what}「${text}」${n} 个字，Meta 建议不超过 ${max}，超出的部分会被折叠。`,
      field,
    )
}

function checkOp(platform: SheetPlatform, op: AdSheetOp, ctx: SheetContext, push: Push): void {
  const google = platform === 'google'
  switch (op.kind) {
    case 'create_campaign': {
      checkName(op.campaign, '广告系列', 'campaign', push)
      if (google) {
        if (op.daily_budget === undefined || !(op.daily_budget > 0))
          push(
            'error',
            'missing',
            `新广告系列「${op.campaign}」要写日预算（大于 0）。`,
            'daily_budget',
          )
        const g = op.google ?? {}
        const cid = g.customer_id ?? ctx.customer_id
        if (cid !== undefined && !/^\d{3}-\d{3}-\d{4}$/.test(cid))
          push(
            'error',
            'bad_format',
            `客户编号「${cid}」要写成 123-456-7890 的样子。`,
            'customer_id',
          )
        for (const [f, d] of [
          ['start_date', g.start_date],
          ['end_date', g.end_date],
        ] as const)
          if (d !== undefined && !isDate(d))
            push('error', 'bad_format', `日期「${d}」要写成 2026-10-14 的样子。`, f)
        if (g.start_date !== undefined && g.end_date !== undefined && g.end_date < g.start_date)
          push('error', 'bad_range', '结束日期早于开始日期。', 'end_date')
      } else {
        if (op.daily_budget !== undefined)
          push(
            'error',
            'unsupported',
            'Meta 的预算写在广告组上（官方模板没有广告系列日预算这一列）。',
            'daily_budget',
          )
        if (op.meta?.objective === undefined || op.meta.objective.trim() === '')
          push(
            'error',
            'missing',
            `新广告系列「${op.campaign}」要写目标（Campaign Objective）。`,
            'objective',
          )
      }
      return
    }
    case 'create_ad_group': {
      checkName(op.campaign, '广告系列', 'campaign', push)
      checkName(op.ad_group, '广告组', 'ad_group', push)
      if (google) {
        if (op.google?.max_cpc !== undefined && !(op.google.max_cpc > 0))
          push('error', 'bad_number', '单次点击出价要大于 0。', 'max_cpc')
        return
      }
      const m = op.meta ?? {}
      const budgets = [m.daily_budget, m.lifetime_budget].filter((b) => b !== undefined)
      if (budgets.length !== 1)
        push(
          'error',
          'missing',
          `广告组「${op.ad_group}」要写日预算或总预算（二选一）。`,
          'daily_budget',
        )
      else if (!((budgets[0] as number) > 0))
        push('error', 'bad_number', '预算要大于 0。', 'daily_budget')
      for (const cc of m.countries ?? [])
        if (!/^[A-Z]{2}$/.test(cc))
          push('error', 'bad_format', `国家「${cc}」要写两位大写代码（US）。`, 'countries')
      if (m.age_min !== undefined && (m.age_min < 13 || m.age_min > 65))
        push('error', 'bad_range', '最小年龄要在 13–65 之间。', 'age_min')
      if (m.age_max !== undefined && (m.age_max < 13 || m.age_max > 65))
        push('error', 'bad_range', '最大年龄要在 13–65 之间。', 'age_max')
      if (m.age_min !== undefined && m.age_max !== undefined && m.age_min > m.age_max)
        push('error', 'bad_range', '最小年龄大于最大年龄。', 'age_min')
      return
    }
    // create_ad / add_keyword / set_budget / set_status 见下一节
    default:
      checkOpPart2(platform, op, ctx, push)
  }
}

function checkOpPart2(platform: SheetPlatform, op: AdSheetOp, ctx: SheetContext, push: Push): void {
  const google = platform === 'google'
  switch (op.kind) {
    case 'create_ad': {
      checkName(op.campaign, '广告系列', 'campaign', push)
      checkName(op.ad_group, '广告组', 'ad_group', push)
      if (!isHttpUrl(op.final_url))
        push('error', 'bad_url', `落地页「${op.final_url}」要写全，带 https://。`, 'final_url')
      if (google) {
        const g = op.google
        if (g === undefined) {
          push(
            'error',
            'missing',
            'Google 广告要写标题和描述（google.headlines / descriptions）。',
            'google',
          )
          return
        }
        const L = GOOGLE_RSA_LIMITS
        if (g.headlines.length < L.headlines.min || g.headlines.length > L.headlines.max)
          push(
            'error',
            'count',
            `标题要 ${L.headlines.min}–${L.headlines.max} 条，这里 ${g.headlines.length} 条。`,
            'headlines',
          )
        if (
          g.descriptions.length < L.descriptions.min ||
          g.descriptions.length > L.descriptions.max
        )
          push(
            'error',
            'count',
            `描述要 ${L.descriptions.min}–${L.descriptions.max} 条，这里 ${g.descriptions.length} 条。`,
            'descriptions',
          )
        if (new Set(g.headlines.map((h) => h.trim().toLowerCase())).size !== g.headlines.length)
          push('warning', 'duplicate_copy', '有两条标题一样，Google 会当成一条。', 'headlines')
        g.headlines.forEach((h, k) => {
          checkLen(h, L.headlines.chars, `标题 ${k + 1}`, 'headlines', push, true)
          checkCopy(platform, h, 'headlines', ctx, push)
        })
        g.descriptions.forEach((d, k) => {
          checkLen(d, L.descriptions.chars, `描述 ${k + 1}`, 'descriptions', push, true)
          checkCopy(platform, d, 'descriptions', ctx, push)
        })
        for (const [f, p] of [
          ['path1', g.path1],
          ['path2', g.path2],
        ] as const)
          if (p !== undefined) checkLen(p, L.path_chars, '显示路径', f, push, true)
        return
      }
      const m = op.meta
      if (m === undefined) {
        push(
          'error',
          'missing',
          'Meta 广告要写正文、主页和图片（meta.body / page_id / image_*）。',
          'meta',
        )
        return
      }
      if (m.body.trim() === '') push('error', 'missing', '正文（Body）没写。', 'body')
      if (!/^\d+$/.test(m.page_id))
        push(
          'error',
          'bad_format',
          `主页编号「${m.page_id}」只写数字，表里会写成 o:编号。`,
          'page_id',
        )
      const imgs = [m.image_file, m.image_hash].filter((x) => x !== undefined && x !== '')
      if (imgs.length !== 1)
        push(
          'error',
          'missing',
          '图片要给一个：随表上传的文件名，或已上传图片的哈希（二选一）。',
          'image',
        )
      if (m.image_hash !== undefined && !/^(\d+:)?[0-9a-f]{32}$/i.test(m.image_hash))
        push(
          'error',
          'bad_format',
          `图片哈希「${m.image_hash}」格式不对（32 位十六进制，可带「账户编号:」前缀）。`,
          'image_hash',
        )
      if (m.call_to_action !== undefined && !META_CALL_TO_ACTIONS.includes(m.call_to_action))
        push(
          'error',
          'bad_value',
          `行动号召「${m.call_to_action}」不在官方取值里。`,
          'call_to_action',
        )
      checkLen(m.body, META_COPY_LIMITS.body, '正文', 'body', push, false)
      if (m.title !== undefined)
        checkLen(m.title, META_COPY_LIMITS.title, '标题', 'title', push, false)
      for (const [f, t] of [
        ['body', m.body],
        ['title', m.title],
        ['link_description', m.link_description],
      ] as const)
        if (t !== undefined && t !== '') checkCopy(platform, t, f, ctx, push)
      return
    }
    case 'add_keyword': {
      if (!google) {
        push('error', 'unsupported', 'Meta 没有关键词。', 'keyword')
        return
      }
      checkName(op.ad_group, '广告组', 'ad_group', push)
      if (op.text.trim() === '') push('error', 'missing', '关键词是空的。', 'text')
      if (/[[\]"]/.test(op.text))
        push(
          'error',
          'bad_char',
          `关键词「${op.text}」里别带 [ ] 或引号，匹配方式写在 match 里。`,
          'text',
        )
      if (op.max_cpc !== undefined && !(op.max_cpc > 0))
        push('error', 'bad_number', '单次点击出价要大于 0。', 'max_cpc')
      checkCopy(platform, op.text, 'text', ctx, push)
      return
    }
    case 'set_budget': {
      const want = google ? 'campaign' : 'ad_group'
      if (op.level !== want)
        push(
          'error',
          'unsupported',
          google ? 'Google 的预算在广告系列上。' : 'Meta 的预算在广告组上。',
          'level',
        )
      checkIds(platform, op.level, op.ref, push)
      if (!(op.after > 0)) push('error', 'bad_number', '新预算要大于 0（要停就用暂停）。', 'after')
      const v = budgetDelta(op.before, op.after, ctx.caps)
      if (!v.within)
        push(
          ctx.allow_over_cap === true ? 'warning' : 'error',
          'budget_over_cap',
          v.reason,
          'after',
        )
      return
    }
    case 'set_status': {
      if (!google && op.level === 'keyword') {
        push('error', 'unsupported', 'Meta 没有关键词。', 'level')
        return
      }
      checkIds(platform, op.level, op.ref, push)
      return
    }
    default:
      return
  }
}

/**
 * 改已有对象要带编号。Meta 尤其要紧：**编号空着的行会被当成新建**
 * （[用 Excel 新建广告](https://www.facebook.com/business/help/257638938498557)）。
 */
function checkIds(platform: SheetPlatform, level: string, ref: AdEntityRef, push: Push): void {
  const need: Record<string, [string | undefined, string]> = {
    campaign: [ref.campaign_id, '广告系列编号'],
    ad_group: [ref.ad_group_id, '广告组编号'],
    ad: [ref.ad_id, '广告编号'],
  }
  if (level === 'keyword') {
    if (ref.ad_group === undefined || ref.keyword === undefined || ref.match === undefined)
      push('error', 'missing', '改关键词要写广告组、关键词和匹配方式。', 'ref')
    return
  }
  const [id, what] = need[level] ?? [undefined, '编号']
  if (id === undefined || id.trim() === '') {
    const strict = platform === 'meta' || level !== 'ad_group'
    push(
      strict ? 'error' : 'warning',
      'missing_id',
      platform === 'meta'
        ? `改已有的要带${what}——Meta 会把没编号的行当成新建。`
        : `改已有的要带${what}（Google 认名字也认编号，带上编号不会改错对象）。`,
      'ref',
    )
  }
}

/** 同一批里重复新建同一个东西（同名同层同上级）。 */
function checkDuplicates(ops: readonly AdSheetOp[], problems: SheetProblem[]): void {
  const seen = new Map<string, number>()
  ops.forEach((op, i) => {
    let key: string | undefined
    if (op.kind === 'create_campaign') key = `c|${op.campaign}`
    else if (op.kind === 'create_ad_group') key = `g|${op.campaign}|${op.ad_group}`
    else if (op.kind === 'add_keyword')
      key = `k|${op.campaign}|${op.ad_group}|${op.match}|${op.text.toLowerCase()}`
    else if (op.kind === 'create_ad' && op.meta?.ad_name !== undefined)
      key = `a|${op.campaign}|${op.ad_group}|${op.meta.ad_name}`
    if (key === undefined) return
    const first = seen.get(key)
    if (first === undefined) seen.set(key, i)
    else
      problems.push({
        severity: 'error',
        code: 'duplicate',
        op_index: i,
        message: `第 ${i + 1} 条和第 ${first + 1} 条新建的是同一个东西。`,
      })
  })
}

/**
 * 岗位级日花费总闸（docs/57 §6）：只算**正在跑的**预算往上提的那一截。
 * 新建的一律暂停，今天不花钱，不算进去。
 */
function checkSpendGate(
  platform: SheetPlatform,
  ops: readonly AdSheetOp[],
  ctx: SheetContext,
  problems: SheetProblem[],
): void {
  if (ctx.spend_today_by_platform === undefined) return
  const adding = ops.reduce(
    (sum, op) =>
      op.kind === 'set_budget' && op.after > op.before ? sum + (op.after - op.before) : sum,
    0,
  )
  if (adding === 0) return
  const gate = daySpendGate({
    spend_by_platform: ctx.spend_today_by_platform,
    adding,
    ...(ctx.caps?.max_daily_spend === undefined
      ? {}
      : { caps: { max_daily_spend: ctx.caps.max_daily_spend } }),
  })
  if (!gate.open)
    problems.push({
      severity: ctx.allow_over_cap === true ? 'warning' : 'error',
      code: 'daily_cap',
      message: `${gate.reason}（${platform === 'google' ? 'Google' : 'Meta'} 这张表要再提 ${adding}）`,
    })
}
