/**
 * WP96 交付 2：卡的十一种主体排版 + 全类共用的头与脚。
 *
 * 一种排版一个用例，钉的是"这一种的主角是什么"：改动卡的主角是 before / after 双格，
 * 金钱卡的主角是那个大金额，发布卡上排期与受众数**必现**，接管卡只给一个"打开浏览器"。
 * 另外钉两件全类的事：右下角的 → 圆钮**每张卡都有**（没按钮的卡也有），
 * 头一行末尾是提案人头像且**不印任何 id**。
 */

import type { DeckCard } from '@agentsws/deck'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

/** 造一张指定排版的卡；`payload` 覆盖 detail.payload，其余照 draftCard。 */
function layoutCard(
  layout: DeckCard['layout'],
  over: Partial<DeckCard> = {},
  payload: Record<string, unknown> = {},
): DeckCard {
  const base = draftCard()
  return draftCard({
    layout,
    id: `ap_${layout}`,
    detail: { ...base.detail, payload },
    ...over,
  })
}

function renderCard(card: DeckCard, onOpen: (c: DeckCard) => void = noop): void {
  renderWithProviders(
    <DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={onOpen} />,
  )
}

describe('① 出站文案卡', () => {
  it('正文整段给人看', () => {
    renderCard(layoutCard('outbound'))
    expect(screen.getByTestId('deck-layout-outbound')).toBeTruthy()
    expect(screen.getByTestId('deck-content').textContent).toContain('退货窗口内')
  })
})

describe('② 改动卡', () => {
  it('before / after 双格是主体，一句依据在下面', () => {
    renderCard(
      layoutCard(
        'change',
        { kind: 'staged_change' },
        { before: { price: 14.9 }, after: { price: 13.4 } },
      ),
    )
    const ba = screen.getByTestId('deck-before-after')
    expect(ba.textContent).toContain('14.9')
    expect(ba.textContent).toContain('13.4')
    expect(screen.getByTestId('deck-reason')).toBeTruthy()
  })
})

describe('③ 发布卡', () => {
  it('左预览右说明；排期时间与受众数必现（没有就是「批了就发」与 —，不留空）', () => {
    renderCard(
      layoutCard('publish', {
        kind: 'staged_change',
        highlights: [
          { type: 'scheduled', text: '明天 14:00' },
          { type: 'audience', text: '1,204 人' },
        ],
      }),
    )
    const body = screen.getByTestId('deck-layout-publish')
    expect(screen.getByTestId('deck-publish-preview')).toBeTruthy()
    expect(body.textContent).toContain('明天 14:00')
    expect(body.textContent).toContain('1,204 人')
  })

  it('没有排期与受众时那两格照样在', () => {
    renderCard(layoutCard('publish', { kind: 'staged_change', highlights: [] }))
    const body = screen.getByTestId('deck-layout-publish')
    expect(body.textContent).toContain('批了就发')
    expect(body.textContent).toContain('受众')
  })
})

describe('④ 金钱卡', () => {
  it('金额一个大字，旁边是额度与依据的键值对', () => {
    renderCard(
      layoutCard(
        'money',
        { kind: 'staged_change', highlights: [{ type: 'amount', text: 'US$45' }] },
        { caps: { 额度上限: 'US$50' }, basis: { 政策: '30 天破损全退' } },
      ),
    )
    expect(screen.getByTestId('deck-money-amount').textContent).toBe('US$45')
    const kv = screen.getByTestId('deck-money-kv')
    expect(kv.textContent).toContain('US$50')
    expect(kv.textContent).toContain('30 天破损全退')
  })
})

describe('⑤ 选择卡', () => {
  it('单选列表，不猜', async () => {
    renderCard(
      layoutCard('choice', {
        kind: 'ai_question',
        options: [
          { id: 'a', label: '店铺管理' },
          { id: 'b', label: '内容与博客' },
        ],
      }),
    )
    const box = screen.getByTestId('deck-card-options')
    expect(within(box).getAllByRole('radio')).toHaveLength(2)
    await userEvent.click(screen.getByText('内容与博客'))
    expect(within(box).getAllByRole('radio')[1]?.getAttribute('aria-checked')).toBe('true')
  })
})

describe('⑥ 变体卡', () => {
  it('缩略图格，点一张就选中它', async () => {
    renderCard(
      layoutCard(
        'variants',
        { kind: 'staged_change' },
        { variants: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }] },
      ),
    )
    const tiles = screen.getAllByTestId('deck-variant')
    expect(tiles).toHaveLength(3)
    expect(tiles[1]?.dataset.selected).toBeUndefined()
    await userEvent.click(tiles[1] as HTMLElement)
    expect(screen.getAllByTestId('deck-variant')[1]?.dataset.selected).toBe('true')
  })
})

describe('⑦ 事后决定卡', () => {
  it('判据键值对是主体（系统已经做了，问的是要不要改回来）', () => {
    renderCard(
      layoutCard(
        'aftermath',
        { kind: 'staged_change' },
        { facts: { ROAS: '0.6（线 1.0）', 今日花费: 'US$400' } },
      ),
    )
    const kv = screen.getByTestId('deck-aftermath-kv')
    expect(kv.textContent).toContain('0.6（线 1.0）')
    expect(kv.textContent).toContain('US$400')
  })
})

describe('⑧ 人物卡', () => {
  it('头像 + 资料摘要', () => {
    renderCard(
      layoutCard(
        'person',
        { kind: 'membership' },
        { person: { name: 'maria_k', profile: '加入 Discord 2 年 · 3 个共同群' } },
      ),
    )
    expect(screen.getByTestId('deck-person-avatar').textContent).toBe('m')
    expect(screen.getByTestId('deck-layout-person').textContent).toContain('3 个共同群')
  })
})

describe('⑨ 转交 / 认领卡', () => {
  it('主体是原话', () => {
    renderCard(
      layoutCard(
        'handoff',
        { kind: 'claim' },
        { quote: '订单 #1088 上周下的，物流一直没动', reason: '客户问题' },
      ),
    )
    expect(screen.getByTestId('deck-quote').textContent).toContain('物流一直没动')
    expect(screen.getByTestId('deck-layout-handoff').textContent).toContain('分类依据：客户问题')
  })
})

describe('⑩ 接管卡', () => {
  it('只说发生了什么 + 一个「打开浏览器」，Agent 不重试', async () => {
    const onOpen = vi.fn()
    const card = layoutCard('takeover', { kind: 'dev_handoff_result' }, { url: 'about:blank' })
    renderCard(card, onOpen)
    await userEvent.click(screen.getByTestId('deck-takeover-open'))
    expect(onOpen).toHaveBeenCalledWith(card)
  })
})

describe('⑪ 策略卡', () => {
  it('配置 diff + 只有 owner 能批那一句', () => {
    renderCard(
      layoutCard(
        'policy',
        { kind: 'policy_change' },
        { before: { 改价额度: '≤ 20%' }, after: { 改价额度: '≤ 25%' } },
      ),
    )
    expect(screen.getByTestId('deck-before-after').textContent).toContain('≤ 25%')
    expect(screen.getByTestId('deck-layout-policy').textContent).toContain('owner')
  })

  it('它同时是问句：diff 与单选列表都在（裸 approve 服务端会拒）', () => {
    renderCard(
      layoutCard(
        'policy',
        {
          kind: 'policy_change',
          options: [
            { id: 'after', label: '按提议改' },
            { id: 'before', label: '维持现状' },
          ],
        },
        { before: { 改价额度: '≤ 20%' }, after: { 改价额度: '≤ 25%' } },
      ),
    )
    expect(screen.getByTestId('deck-before-after')).toBeTruthy()
    expect(screen.getByTestId('deck-card-options')).toBeTruthy()
  })
})

describe('全类共用的头与脚', () => {
  it('每张卡右下角都有 → 圆钮，点它进这件事', async () => {
    const onOpen = vi.fn()
    const card = layoutCard('change', { kind: 'staged_change' }, { before: 1, after: 2 })
    renderCard(card, onOpen)
    await userEvent.click(screen.getByTestId('ws-go'))
    expect(onOpen).toHaveBeenCalledWith(card)
  })

  it('**没按钮的卡也有** → 圆钮', () => {
    renderCard(
      layoutCard('aftermath', {
        kind: 'digest',
        status: 'applied',
        available_actions: ['open'],
        action_labels: { open: '打开' },
      }),
    )
    expect(screen.getByTestId('ws-go')).toBeTruthy()
  })

  it('头一行末尾是提案人头像，且不印任何 id', () => {
    const { container } = renderWithProviders(
      <DeckCardView
        card={layoutCard('outbound')}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const row = screen.getByTestId('deck-tag-row')
    const avatar = within(row).getByTestId('ws-avatar')
    expect(avatar.textContent).toBe('AI')
    expect(container.textContent ?? '').not.toContain('售后客服 Agent')
  })

  it('卡壳走 .ws-card（圆角 16、无边框、浅阴影都在这一个 class 里）', () => {
    renderCard(layoutCard('outbound'))
    const card = screen.getByTestId('deck-card')
    expect(card.className).toContain('ws-card')
    expect(card.dataset.layout).toBe('outbound')
  })
})
