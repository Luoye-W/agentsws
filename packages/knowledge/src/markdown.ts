import type { FactCard } from '@agentsws/contracts'
import { invalidInput } from './errors.js'

/**
 * 19 §5「整库可导出 markdown 文件夹（零锁定）」。人可读的正文 + 一段机器可读的
 * 注释信封（完整字段，含 id 与出处），保证 export → import 往返后 id 与 provenance 不变。
 */
const OPEN = '<!-- agentsws:fact-card v1'
const CLOSE = '-->'
const ENVELOPE = /<!-- agentsws:fact-card v1\n([\s\S]*?)\n-->/g

export interface MarkdownFile {
  path: string
  content: string
}

const provenanceLine = (p: FactCard['provenance'][number]): string => {
  const bits = [`- ${p.source} \`${p.ref}\``]
  if (p.locator !== undefined) bits.push(`（${p.locator}）`)
  if (p.quote !== undefined) bits.push(`：“${p.quote}”`)
  bits.push(` — ${p.at}`)
  return bits.join('')
}

export function cardToMarkdown(card: FactCard): MarkdownFile {
  const body = [
    // `-->` 会提前关闭信封，转成 >；JSON.parse 会还原。
    `${OPEN}\n${JSON.stringify(card, null, 2).replace(/-->/g, '--\\u003e')}\n${CLOSE}`,
    '',
    `# ${card.subject.key}`,
    '',
    `- 层：${card.layer}　域：${card.domain}　敏感度：${card.sensitivity}　状态：${card.status}`,
    `- 负责人：${card.owner}　置信度：${card.confidence.state}（${card.confidence.value}）`,
    '',
    card.statement,
    '',
    '## 出处',
    ...card.provenance.map(provenanceLine),
  ]
  if (card.conflicts && card.conflicts.length > 0) {
    body.push('', '## 冲突（双值并存，不覆盖）')
    for (const c of card.conflicts) body.push(`- ${c.with}：${c.note}`)
  }
  return { path: `${card.layer}/${card.id}.md`, content: `${body.join('\n')}\n` }
}

/** 从一份（或多份拼接的）markdown 里取回事实卡。缺信封 = 不是本仓导出的文件。 */
export function cardsFromMarkdown(content: string): FactCard[] {
  const out: FactCard[] = []
  ENVELOPE.lastIndex = 0
  for (const m of content.matchAll(ENVELOPE)) {
    const json = m[1]
    if (json === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (e) {
      throw invalidInput('事实卡信封不是合法 JSON', { cause: String(e) })
    }
    const card = parsed as FactCard
    if (typeof card.id !== 'string' || card.id === '')
      throw invalidInput('事实卡信封缺少 id，导入会丢失身份')
    if (!Array.isArray(card.provenance) || card.provenance.length === 0)
      throw invalidInput('事实卡信封缺少出处', { id: card.id })
    out.push(card)
  }
  if (out.length === 0) throw invalidInput('markdown 里没有事实卡信封')
  return out
}
