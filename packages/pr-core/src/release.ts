/**
 * 结构化新闻稿（60 §2 `release.ts`）。
 *
 * 一篇新闻稿在这里是**六段**，不是一块 markdown：标题 / 导语 / 事实段 /
 * 引语 / 关于我们 / 联系方式。分段不是排版洁癖，是因为每段的规矩不一样，
 * 揉成一块正文之后这三条一条都查不了：
 *
 * 1. **事实段里的数字只能来自事实卡**（19 §3）。{@link checkFacts} 把正文里
 *    每一个数字抽出来逐个对；对不上的原样报出来，理由是"这个数字没有出处"。
 *    抽取与对照那一段在 `@agentsws/core` 的 `uncitedFigures`——与 guardrail
 *    读的是**同一份**，不是抄一遍。起草时先自查是为了早点给模型反馈，
 *    最后一道仍然在 guardrail。
 * 2. **引语必须是人给的**（60 §2 那一行加粗的话）。{@link composeRelease}
 *    的引语来自 `input.quotes`，而 `PressQuote.provided_by` 是必填——
 *    这个模块**没有**一个"生成一句引语"的函数，所以模型编不出来。
 * 3. **联系方式必须是真人**。{@link checkRelease} 查邮箱那一格在不在；
 *    `press_release` 的 `contact` 还在受保护字段里（Agent 提都不许提）。
 *
 * 这个包里没有 `Date.now()`、没有 `fetch` 的实现、没有模型调用。
 */

import type {
  Iso8601,
  PressFactCitation,
  PressQuote,
  PressRelease,
  WorkspaceId,
} from '@agentsws/contracts'
import { extractFigures, uncitedFigures } from '@agentsws/core'

/** 一段稿子哪里不对（给人看的一行 + 机器认的一个规则名）。 */
export interface ReleaseProblem {
  /** 规则名（与 guardrail 那一侧的 hit 名对得上）。 */
  rule:
    | 'headline_required'
    | 'dek_required'
    | 'body_required'
    | 'press_release_facts_required'
    | 'press_release_quote_needs_human'
    | 'boilerplate_required'
    | 'contact_required'
  /** 一句人话。 */
  message: string
  /** 出问题的那一段 / 那一个数（原样）。 */
  at?: string
}

export interface ReleaseCheck {
  ok: boolean
  problems: ReleaseProblem[]
  /** 正文里抽出来的每一个数字（卡面上"这篇稿子引了几个数"那一行读它）。 */
  figures: string[]
  /** 里面**没有出处**的那些。空数组 = 每个数都指得出是哪张卡。 */
  uncited: string[]
}

/**
 * 事实段那一关（60 §2）。
 *
 * 判据是**覆盖**，不是数量：引了十张卡但正文里多写了一个数，照样不过——
 * 被媒体登出去的是那个多出来的数，不是那十张卡。
 */
export function checkFacts(body: string, cited: readonly PressFactCitation[]): ReleaseCheck {
  const figures = extractFigures(body)
  const uncited = uncitedFigures(
    body,
    cited.map((c) => c.figure),
  )
  return {
    ok: uncited.length === 0,
    figures,
    uncited,
    problems: uncited.map((f) => ({
      rule: 'press_release_facts_required' as const,
      message: `这个数字没有出处：${f}。先在知识库里找到写着这个数的那张事实卡，把它引上；找不到就把这句话去掉——新闻稿里的数会被原样登出去。`,
      at: f,
    })),
  }
}

/**
 * 引语那一关：**必须是人给的**。
 *
 * `provided_by` 空着 = 这句话是模型替创始人说的。这不是格式问题：一句
 * "我们的 CEO 说这是行业的里程碑"会被媒体原样登出去，而那个人从来没说过。
 */
export function checkQuotes(quotes: readonly PressQuote[]): ReleaseProblem[] {
  return quotes
    .filter((q) => q.provided_by.trim() === '')
    .map((q) => ({
      rule: 'press_release_quote_needs_human' as const,
      message: `「${q.speaker}」这句引语没有写是谁给的。引语必须是人自己说的那句话——去问他要一句，别替他说。`,
      at: q.speaker,
    }))
}

/** 整篇稿子过一遍（起草那一跳自查用；最后一道仍然在 guardrail）。 */
export function checkRelease(
  release: Pick<
    PressRelease,
    'headline' | 'dek' | 'body' | 'quotes' | 'boilerplate' | 'contact' | 'facts_cited'
  >,
): ReleaseCheck {
  const facts = checkFacts(release.body, release.facts_cited)
  const problems: ReleaseProblem[] = [...facts.problems, ...checkQuotes(release.quotes)]
  if (release.headline.trim() === '')
    problems.push({ rule: 'headline_required', message: '没有标题。' })
  if (release.dek.trim() === '')
    problems.push({
      rule: 'dek_required',
      message: '没有导语。第一段要在三句话里说清楚：谁、做了什么、什么时候、在哪儿、为什么。',
    })
  if (release.body.trim() === '')
    problems.push({ rule: 'body_required', message: '事实段是空的。' })
  if (release.boilerplate.trim() === '')
    problems.push({
      rule: 'boilerplate_required',
      message: '没有「关于我们」。这一段是媒体复制粘贴用的，不写他们会自己编一段。',
    })
  if (release.contact.name.trim() === '' || release.contact.email.trim() === '')
    problems.push({
      rule: 'contact_required',
      message: '联系方式要留一个**真人**：记者会照着这一行打过来。',
    })
  return { ...facts, ok: problems.length === 0, problems }
}

/** 起草一篇稿子要递进来的东西。**引语与事实卡都由调用方给，这里不生成**。 */
export interface ComposeReleaseInput {
  id: string
  workspace_id: WorkspaceId
  headline: string
  dek: string
  body: string
  /** 人给的引语（一条都没有也行——**没有比编一条好**）。 */
  quotes?: readonly PressQuote[]
  boilerplate: string
  contact: PressRelease['contact']
  facts_cited: readonly PressFactCitation[]
  embargo_until?: Iso8601
  now: Iso8601
}

/**
 * 把六段拼成一条 {@link PressRelease}（状态恒为 `draft`）。
 *
 * **不会拼出 `distributed`**：分发是另一跳，要人点（`press_release` 的
 * `after.distributed === true` 在 guardrail 里升 L1）。这个函数做不到那件事，
 * 所以那条路上不存在"起草顺手发出去"。
 */
export function composeRelease(input: ComposeReleaseInput): PressRelease {
  return {
    id: input.id,
    workspace_id: input.workspace_id,
    status: 'draft',
    headline: input.headline.trim(),
    dek: input.dek.trim(),
    body: input.body,
    quotes: [...(input.quotes ?? [])],
    boilerplate: input.boilerplate,
    contact: input.contact,
    facts_cited: [...input.facts_cited],
    ...(input.embargo_until === undefined ? {} : { embargo_until: input.embargo_until }),
    created_at: input.now,
    updated_at: input.now,
  }
}

/**
 * 六段拼成给人看的那一份纯文本（卡面预览、发给媒体的正文都用它）。
 *
 * 顺序是新闻稿的老规矩，不是我们定的：标题 → 导语 → 事实段 → 引语 →
 * 关于我们 → 联系方式 → `###`（行业里"稿件到此结束"的记号）。
 */
export function renderRelease(
  release: Pick<
    PressRelease,
    'headline' | 'dek' | 'body' | 'quotes' | 'boilerplate' | 'contact' | 'embargo_until'
  >,
): string {
  const lines: string[] = []
  if (release.embargo_until !== undefined) lines.push(`【禁发至 ${release.embargo_until}】`)
  lines.push(release.headline, '', release.dek, '', release.body)
  for (const q of release.quotes) lines.push('', `「${q.text}」——${q.speaker}`)
  lines.push('', '关于我们', release.boilerplate)
  lines.push(
    '',
    '媒体联系',
    `${release.contact.name}　${release.contact.email}${
      release.contact.phone === undefined ? '' : `　${release.contact.phone}`
    }`,
  )
  lines.push('', '###')
  return lines.join('\n')
}
