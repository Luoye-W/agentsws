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

/**
 * WP100（09-18 画布收口）：**按钮上的字按排版走，头一行的类别写人话**。
 *
 * 一种排版一行，钉的是"人按下去之前读到的那个字"与"这是哪个岗位的什么活儿"——
 * 十一种卡共用"批准 / 驳回 / 指导"等于把这两件事都从界面上抹掉。
 * 动作本身一个没换：`data-action` 还是 `approve`，换的只有文案与位置。
 */
describe('WP100：十一种各有主动词，头一行的类别写人话', () => {
  const table: [DeckCard['layout'], Partial<DeckCard>, string, string][] = [
    ['outbound', { kind: 'outbound_draft' }, '发送', '回信'],
    ['change', { kind: 'staged_change', change_kind: 'price_change' }, '批准', '改价'],
    ['publish', { kind: 'staged_change', change_kind: 'publish_post' }, '批准发布', '发布'],
    ['money', { kind: 'staged_change', change_kind: 'refund' }, '批准退款', '退款'],
    ['choice', { kind: 'ai_question' }, '就这条', '路由'],
    ['variants', { kind: 'staged_change', change_kind: 'design_variant' }, '就这张', '变体'],
    ['aftermath', { kind: 'staged_change', change_kind: 'pause_ad' }, '恢复投放', '止损后'],
    ['person', { kind: 'staged_change', change_kind: 'community_membership' }, '通过', '入群'],
    ['handoff', { kind: 'claim' }, '认领', '转交'],
    ['takeover', { kind: 'dev_handoff_result' }, '打开浏览器', '请你接管'],
    ['policy', { kind: 'policy_change' }, '批准', '策略变更'],
  ]

  for (const [layout, over, verb, category] of table) {
    it(`${layout}：主动词是「${verb}」，类别是「${category}」`, () => {
      renderCard(layoutCard(layout, over))
      const bar = screen.getByTestId('deck-action-bar')
      const primary = within(bar).getByText(verb).closest('button')
      expect(primary?.dataset.action).toBe('approve')
      expect(primary?.dataset.rank).toBe('primary')
      expect(screen.getByTestId('deck-band').textContent).toBe(category)
    })
  }

  it('金钱卡的主动词按账本条目类型换（退款 / 补发 / 发码 / 合作）', () => {
    renderCard(layoutCard('money', { kind: 'staged_change', change_kind: 'reship' }))
    expect(within(screen.getByTestId('deck-action-bar')).getByText('批准补发')).toBeTruthy()
  })

  it('没登记的 kind 回退到原来的写法，不编一个类别名', () => {
    renderCard(layoutCard('change', { kind: 'staged_change', change_kind: 'no_such_kind' }))
    // `kind.staged_change` = 「变更待批」：一句不好看的实话，好过一句好看的错话
    expect(screen.getByTestId('deck-band').textContent).toBe('变更待批')
    expect(within(screen.getByTestId('deck-action-bar')).getByText('批准')).toBeTruthy()
  })

  it('「指导」在选择卡上排不进按钮行，收进 ···（动作还在，位置换了）', async () => {
    renderCard(layoutCard('choice', { kind: 'ai_question' }))
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).queryByText('我来说')).toBeNull()
    await userEvent.click(screen.getByTestId('deck-more'))
    const menu = screen.getByTestId('deck-more-menu')
    expect(within(menu).getByText('我来说').closest('button')?.dataset.action).toBe('instruct')
  })
})

describe('WP141：卡面上的字段名与值说人话', () => {
  it('业务边界卡：late_return_grace_days: 0 → 7 写成「过了退货期还能宽限：0 天 → 7 天」', () => {
    renderCard(
      layoutCard(
        'policy',
        { kind: 'policy_change' },
        { before: { late_return_grace_days: 0 }, after: { late_return_grace_days: 7 } },
      ),
    )
    const ba = screen.getByTestId('deck-before-after').textContent ?? ''
    expect(ba).toContain('过了退货期还能宽限: 0 天')
    expect(ba).toContain('过了退货期还能宽限: 7 天')
    expect(ba).not.toContain('late_return_grace_days')
  })

  it('红人挑人清单卡：按渠道列名字，不是「没 · 没写名字」', () => {
    renderCard(
      layoutCard(
        'person',
        { kind: 'kol_campaign' },
        {
          campaign_id: 'cmp_1',
          by_channel: [
            {
              channel: 'youtube',
              role_id: 'kol.youtube',
              allowed: true,
              picks: [{ display_name: 'Gadget Jonas' }, { display_name: 'Desk Rosa' }],
            },
          ],
        },
      ),
    )
    const box = screen.getByTestId('deck-campaign-groups').textContent ?? ''
    expect(box).toContain('YouTube · 2 人')
    expect(box).toContain('Gadget Jonas、Desk Rosa')
    expect(screen.queryByText('没写名字')).toBeNull()
  })
})
