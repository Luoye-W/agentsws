/**
 * WP161（Luoye 09-27）：消息页左栏的岗位文件夹。
 *
 * - 显示名走 i18n，不露服务器真名：客服在处理 / 红人合作 / B2B 往来；
 * - B2B 岗位还在设计：消息库里没有 B2B 那只文件夹的信就**不显示**它。
 */
import type { MessageLabel } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageAccountView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const ME = 'hello@shop.example'
const T0 = '2026-09-27T01:00:00.000Z'

const base: MessageAccountView = {
  address: ME,
  unread: 0,
  folders: [
    { path: 'INBOX', kind: 'inbox', account: ME, unread: 0, total: 2 },
    { path: 'kefuagents', kind: 'support', account: ME, unread: 0, total: 1 },
    { path: 'KOLAgents', kind: 'kol', account: ME, unread: 0, total: 1 },
  ],
  backfill_floor: T0,
}

let accounts: MessageAccountView[] = [base]
const labels: MessageLabel[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageAccounts: async () => ({ accounts }),
    listMessageLabels: async () => ({ labels }),
    listMessageThreads: async () => ({ threads: [] }),
    syncMessages: async () => ({
      accounts: 1,
      folders: 3,
      fetched: 0,
      triaged: 0,
      moved: 0,
      failed: [],
    }),
  }
})

const { MessagesPage } = await import('@/pages/messages')

const folderKinds = (): string[] =>
  screen.getAllByTestId('messages-folder').map((el) => el.getAttribute('data-folder') ?? '')

describe('消息页左栏：岗位文件夹（WP161）', () => {
  it('显示名走 i18n（不露真名）；没有 B2B 那只就不画它', async () => {
    accounts = [base]
    renderWithProviders(<MessagesPage />)
    expect(await screen.findByText('客服在处理')).toBeDefined()
    expect(screen.getByText('红人合作')).toBeDefined()
    expect(screen.queryByText('kefuagents')).toBeNull()
    expect(folderKinds()).not.toContain('b2b')
    expect(screen.queryByText('B2B 往来')).toBeNull()
  })

  it('消息库里有 BtoBAgents 那只的信 → 显示「B2B 往来」', async () => {
    accounts = [
      {
        ...base,
        folders: [
          ...base.folders,
          { path: 'BtoBAgents', kind: 'b2b', account: ME, unread: 1, total: 1 },
        ],
      },
    ]
    renderWithProviders(<MessagesPage />)
    expect(await screen.findByText('B2B 往来')).toBeDefined()
    expect(folderKinds()).toContain('b2b')
  })
})
