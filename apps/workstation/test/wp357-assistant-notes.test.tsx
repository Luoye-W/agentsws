/**
 * WP357 工作台：
 * - 决策 902：知识库里助理记下的那条带出处与改 / 删（改 = 就地改正文、删 = 退役），别的知识没有这两个钮；
 * - 决策 904：输入框附资料认 .xlsx / .csv。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeRow } from '@/components/library/knowledge-groups'
import type { KnowledgeCardRow } from '@/lib/api'
import { DOC_EXTENSIONS, isDocFile } from '@/lib/free-chat'
import { renderWithProviders } from './helpers'

const calls = vi.hoisted(() => ({
  edit: [] as [string, string][],
  remove: [] as string[],
  fail: undefined as string | undefined,
}))

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return {
    ...actual,
    editAssistantNote: async (id: string, text: string) => {
      if (calls.fail !== undefined) throw new Error(calls.fail)
      calls.edit.push([id, text])
      return {}
    },
    removeAssistantNote: async (id: string) => {
      calls.remove.push(id)
      return { retired: true }
    },
  }
})

const card = (over: Partial<KnowledgeCardRow> = {}): KnowledgeCardRow => ({
  id: 'fc_1',
  layer: 'fact',
  subject: { type: 'assistant_note', id: 'customer-care', key: 'fanout:fan_1:i5' },
  statement: '退货期统一 30 天',
  status: 'active',
  updated_at: '2026-10-16T00:00:00.000Z',
  provenance: [
    { source: 'meeting', ref: 'assistant:fan_1', locator: '10-16 周会', quote: '客服记住：…' },
  ],
  ...over,
})

const row = (c: KnowledgeCardRow) =>
  renderWithProviders(
    <ul>
      <KnowledgeRow card={c} />
    </ul>,
  )

beforeEach(() => {
  calls.edit = []
  calls.remove = []
  calls.fail = undefined
})

describe('WP357 助理记下的口径：知识库里可改可删（决策 902）', () => {
  it('带出处；改：就地改正文后保存', async () => {
    row(card())
    const li = screen.getByTestId('knowledge-row')
    expect(li.textContent).toContain('来自「10-16 周会」')
    await userEvent.click(within(li).getByTestId('assistant-note-edit'))
    const input = screen.getByTestId('assistant-note-input') as HTMLTextAreaElement
    expect(input.value).toBe('退货期统一 30 天')
    await userEvent.clear(input)
    await userEvent.type(input, '退货期统一 45 天')
    await userEvent.click(screen.getByTestId('assistant-note-save'))
    await waitFor(() => expect(calls.edit).toEqual([['fc_1', '退货期统一 45 天']]))
    await waitFor(() => expect(screen.queryByTestId('assistant-note-form')).toBeNull())
  })

  it('删：一下就退役；服务端不让改时照实说', async () => {
    row(card())
    await userEvent.click(screen.getByTestId('assistant-note-remove'))
    await waitFor(() => expect(calls.remove).toEqual(['fc_1']))
    calls.fail = '这条是别人让助理记的，改不了'
    await userEvent.click(screen.getByTestId('assistant-note-edit'))
    await userEvent.type(screen.getByTestId('assistant-note-input'), '！')
    await userEvent.click(screen.getByTestId('assistant-note-save'))
    expect(await screen.findByText('这条是别人让助理记的，改不了')).toBeDefined()
  })

  it('别的知识、退役了的那条：没有改 / 删', () => {
    row(card({ id: 'fc_2', subject: { type: 'faq', key: 'faq:1' } }))
    row(card({ id: 'fc_3', status: 'retired' }))
    expect(screen.queryAllByTestId('assistant-note-actions')).toEqual([])
  })
})

describe('WP357 附件认表格（决策 904）', () => {
  it('.xlsx / .csv 能附，.xls 仍不收', () => {
    expect([...DOC_EXTENSIONS]).toEqual(['txt', 'md', 'docx', 'pdf', 'xlsx', 'csv'])
    expect(isDocFile('周会安排.XLSX')).toBe(true)
    expect(isDocFile('口径.csv')).toBe(true)
    expect(isDocFile('老表.xls')).toBe(false)
  })
})
