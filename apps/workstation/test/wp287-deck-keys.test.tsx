/**
 * WP287（Luoye 10-09 真机：复盘卡下面写「→ 就这条 · ← 都不是 · ↑ 稍后」，和卡上的按钮对不上）：
 * 通用规则——键盘提示由卡上实际按钮生成，没有对应按钮的方向键不出提示也不做事。
 * 遍历所有卡型：每一个方向键都要在卡上找得到同一个字的按钮。
 */
import {
  actionsFor,
  type DeckAction,
  type DeckCard,
  type DeckKind,
  LAYOUT_BY_KIND,
  labelsFor,
} from '@agentsws/deck'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { deckKeyHints, deckKeys } from '@/components/deck/deck-keys'
import { translate } from '@/lib/i18n'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const t = (key: string): string => translate('zh', key)

const cardOf = (kind: DeckKind, over: Partial<DeckCard> = {}): DeckCard => {
  const actions = actionsFor(kind, 'pending')
  return draftCard({
    id: `ap_${kind}`,
    kind,
    layout: LAYOUT_BY_KIND[kind as keyof typeof LAYOUT_BY_KIND],
    available_actions: actions,
    action_labels: labelsFor(kind, actions),
    ...over,
  })
}

/** 卡上画出来的按钮：动作行（含 `···` 里的）+ 选项按钮，按 data-action / data-option 收字。 */
function rendered(card: DeckCard): {
  actions: Map<string, string[]>
  options: Map<string, string>
} {
  renderWithProviders(
    <DeckCardView
      card={card}
      mode="zh_summary"
      onDecide={() => undefined}
      onOpen={() => undefined}
    />,
  )
  const more = screen.queryByTestId('deck-more')
  if (more !== null) fireEvent.click(more)
  const actions = new Map<string, string[]>()
  for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    const a = b.getAttribute('data-action') as string
    actions.set(a, [...(actions.get(a) ?? []), (b.textContent ?? '').trim()])
  }
  const options = new Map<string, string>()
  for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-option]'))
    options.set(b.getAttribute('data-option') as string, (b.textContent ?? '').trim())
  return { actions, options }
}

afterEach(() => {
  cleanup()
})

const KINDS = Object.keys(LAYOUT_BY_KIND) as DeckKind[]

describe('WP287 键盘跟着卡上的按钮走（遍历所有卡型）', () => {
  it.each(KINDS)('%s：每个方向键在卡上都有同一个字的按钮', (kind) => {
    const card = cardOf(kind)
    const keys = deckKeys(card, t)
    const { actions, options } = rendered(card)
    for (const k of keys) {
      if (k.option !== undefined) {
        expect(options.get(k.option)).toBe(k.label)
        continue
      }
      expect(actions.get(k.action) ?? [], `${kind} ${k.direction}`).toContain(k.label)
    }
    // 选择题那套字只在真有选项的卡上
    if ((card.options ?? []).length === 0)
      for (const k of keys) expect(['就这条', '都不是']).not.toContain(k.label)
  })

  it('复盘卡：按钮与提示都是「按建议排明天 / 我来排 / 稍后」，不是「就这条 / 都不是」', () => {
    const card = cardOf('review')
    expect(deckKeyHints(card, t)).toEqual(['→ 按建议排明天', '← 我来排', '↑ 稍后'])
    const { actions } = rendered(card)
    expect(actions.get('approve')).toContain('按建议排明天')
    expect(actions.get('reject')).toContain('我来排')
  })

  it('有选项要先选的问句：→ 不出（没选中不存在「同意」）', () => {
    const card = cardOf('seo_topic', {
      options: [
        { id: 'a', label: '写「秋季穿搭」' },
        { id: 'b', label: '写「通勤包」' },
      ],
    })
    expect(deckKeys(card, t).some((k) => k.direction === 'right')).toBe(false)
  })

  it('「走哪条职责」这种选项就是按钮的卡：方向键都不做事', () => {
    const card = cardOf('claim', {
      layout: 'choice',
      options: [
        { id: 'dtc.store', label: '走「店铺管理」' },
        { id: 'dtc.content', label: '走「内容与博客」' },
      ],
    })
    expect(deckKeys(card, t)).toEqual([])
  })

  it('动作不在动作行上的（收在 `···` 里的「指导」）：↓ 不出——按了也开不了面板', () => {
    const card = cardOf('review')
    const actions: DeckAction[] = [...card.available_actions, 'instruct']
    const keys = deckKeys({ ...card, available_actions: actions }, t)
    expect(keys.some((k) => k.direction === 'down')).toBe(false)
  })
})
