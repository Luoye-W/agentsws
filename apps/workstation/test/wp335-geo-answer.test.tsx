/**
 * WP335（docs/99 §5.6）：第三栏「一条回答」组件——默认折叠、品牌名高亮（我们 / 竞品分色）、
 * 编号引用（我们的站排前面、加粗）、和上周比（正文增删标色、引用标新 / 不见了）、时间线；纯函数单测。
 */
import type { GeoAnswerDetail, GeoCitationRecord } from '@agentsws/contracts'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GeoAnswerView } from '@/components/seo/geo-answer'
import { diffText, highlight, plainOf } from '@/components/seo/geo-answer-text'
import { geoAnswerAddress, parseGeoAnswerAddress } from '@/lib/geo-watch-api'
import { renderWithProviders } from './helpers'

const cite = (
  answer_id: string,
  position: number,
  domain: string,
  site_kind: GeoCitationRecord['site_kind'],
): GeoCitationRecord => ({
  answer_id,
  position,
  url: `https://${domain}/p`,
  url_norm: `https://${domain}/p`,
  domain,
  title: `${domain} page`,
  where: 'inline',
  site_kind,
})

const answer = (id: string, md: string) => ({
  id,
  run_id: 'r',
  prompt_id: 'p1',
  prompt_text: 'Best power bank for flights?',
  asked_text: 'Best power bank for flights?',
  platform: 'claude' as const,
  model: 'claude-sonnet-5',
  via: 'model_api' as const,
  market: 'US',
  language: 'en',
  status: 'ok' as const,
  answer_md: md,
  answer_hash: id,
  fetched_at: '2026-10-05T09:00:00Z',
  credits: 3.6,
})

const detail: GeoAnswerDetail = {
  week: '2026-10-05',
  answer: answer('a2', '**NordVolt Air** is great for flights.\n\nAnker is also popular [1].'),
  citations: [cite('a2', 1, 'reddit.com', 'forum'), cite('a2', 2, 'nordvolt.example', 'ours')],
  mentions: [
    {
      answer_id: 'a2',
      entity: 'ours',
      name_snapshot: 'NordVolt',
      mentioned: true,
      cited: true,
      rank: 1,
      sentiment: 'positive',
      sentiment_quote: 'NordVolt Air is great for flights.',
      rules_version: 1,
    },
  ],
  previous: {
    week: '2026-09-28',
    answer: answer('a1', 'Anker is popular.'),
    citations: [cite('a1', 1, 'anker.com', 'competitor')],
    mentions: [],
  },
  history: [
    { week: '2026-09-28', state: 'absent', answer_id: 'a1' },
    { week: '2026-10-05', state: 'mentioned', rank: 1, answer_id: 'a2' },
  ],
  names: [
    { entity: 'ours', name: 'NordVolt', terms: ['NordVolt', 'NordVolt Air', 'nordvolt.example'] },
    { entity: 'c1', name: 'Anker', terms: ['Anker', 'anker.com'] },
  ],
}

describe('WP335 一条回答', () => {
  it('顶上一行：AI · 市场 · 周 · 情感（原话进问号）；正文默认折叠、品牌名分色高亮', () => {
    renderWithProviders(<GeoAnswerView detail={detail} />)
    const head = screen.getByTestId('geo-answer')
    expect(head.textContent).toContain('Claude')
    expect(head.textContent).toContain('US')
    expect(screen.getByTestId('geo-answer-sentiment').textContent).toContain('正面')
    const text = screen.getByTestId('geo-answer-text')
    expect(text.dataset.open).toBe('false')
    expect(text.textContent).not.toContain('**')
    expect(screen.getAllByTestId('geo-mark-ours')[0]?.textContent).toBe('NordVolt Air')
    expect(screen.getAllByTestId('geo-mark-rival')[0]?.textContent).toBe('Anker')
    fireEvent.click(screen.getByTestId('geo-answer-toggle'))
    expect(screen.getByTestId('geo-answer-text').dataset.open).toBe('true')
  })

  it('引用：编号是回答里的顺序；我们的站排前面；和上周比：正文增删、引用标新、另列不见了', () => {
    renderWithProviders(<GeoAnswerView detail={detail} />)
    const rows = screen.getAllByTestId('geo-answer-source')
    expect(rows.map((r) => r.dataset.kind)).toEqual(['ours', 'forum'])
    expect(rows[0]?.textContent).toMatch(/^2\./)
    expect(screen.getByTestId('geo-answer-compare').textContent).toContain('和上周比')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getAllByTestId('geo-diff-add').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('geo-source-new')).toHaveLength(2)
    expect(screen.getByTestId('geo-source-gone').textContent).toContain('anker.com')
    expect(screen.getByTestId('geo-answer-timeline').querySelectorAll('li')).toHaveLength(2)
  })

  it('没查成：只说一句，不画正文与引用', () => {
    renderWithProviders(
      <GeoAnswerView
        detail={{ ...detail, answer: { ...detail.answer, status: 'failed', answer_md: '' } }}
      />,
    )
    expect(screen.getByTestId('geo-answer').textContent).toContain('没查成')
    expect(screen.queryByTestId('geo-answer-sources')).toBeNull()
  })
})

describe('WP335 一条回答的纯函数', () => {
  it('markdown 收成纯文字（链接留字、引用编号留着）', () => {
    expect(plainOf('# Top\n**Bold** and [link](https://x.y) [2]')).toBe('Top\nBold and link [2]')
  })
  it('高亮：长名字先认、按词边界、不分大小写', () => {
    const parts = highlight('nordvolt air beats Ankerite and Anker.', detail.names)
    expect(parts.filter((p) => p.entity !== undefined).map((p) => [p.text, p.entity])).toEqual([
      ['nordvolt air', 'ours'],
      ['Anker', 'c1'],
    ])
  })
  it('逐词比：拼得回原文', () => {
    const d = diffText('a b c', 'a x c')
    expect(
      d
        .filter((p) => p.kind !== 'add')
        .map((p) => p.text)
        .join(''),
    ).toBe('a b c')
    expect(
      d
        .filter((p) => p.kind !== 'del')
        .map((p) => p.text)
        .join(''),
    ).toBe('a x c')
  })
  it('第三栏地址来回认得', () => {
    expect(parseGeoAnswerAddress(geoAnswerAddress('asg 1', 'a/1'))).toEqual({
      assignment: 'asg 1',
      answer_id: 'a/1',
    })
    expect(parseGeoAnswerAddress('agentsws://connect/x')).toBeUndefined()
  })
})
