/**
 * WP139（docs/78 阻断 #2）：试聊 / 聊天窗 / 连接页「自带数据接口」按「要什么职责」挑自己的分配；
 * 403 与 501 分开说；聊天窗有常驻入口。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ByoSourceCard } from '@/components/connections/data-source-route'
import { ApiClientError, type Assignment, type Me } from '@/lib/api'
import { apiErrorText, isPermissionDenied } from '@/lib/error-text'
import { translate } from '@/lib/i18n'
import { ChatSandboxPage } from '@/pages/chat-sandbox'
import { renderWithProviders } from './helpers'

const zh = (k: string, v?: Record<string, string | number>): string => translate('zh', k, v)
const STORE = [{ kind: 'store', id: 'store_main' }]
const OWNER: Assignment = { id: 'asg_owner', role_id: 'common.owner', ranges: [] }
const CHAT: Assignment = { id: 'asg_chat', role_id: 'dtc.live-chat', ranges: STORE }
const YT: Assignment = { id: 'asg_yt', role_id: 'kol.youtube', ranges: STORE }

const me = (assignments: Assignment[]): Me => ({
  person: { id: 'p_me', email: 'me@example.com', name: '我' },
  workspace: { id: 'ws_1', name: '演示' },
  assignments,
})

/** 网关判权限拒的那种 403（details 带 domain / op） */
const denied = (): ApiClientError =>
  new ApiClientError(403, {
    code: 'forbidden',
    message: '无权限：customer.read（range=assigned）',
    details: { domain: 'customer', op: 'read' },
  } as never)
const notInstalled = (): ApiClientError =>
  new ApiClientError(501, {
    code: 'not_implemented',
    message: '这个服务进程没有装在线客服（48 §4 #11）',
  })

const mocks = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  openChatSession: vi.fn(),
  getKolByoSources: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: mocks.ensureSession,
    openChatSession: mocks.openChatSession,
    getChatMessages: async () => ({
      session: { id: 'cs_1', status: 'open' },
      messages: [],
    }),
    getKolByoSources: mocks.getKolByoSources,
    listMessageAccounts: async () => ({ accounts: [] }),
  }
})

beforeEach(() => {
  mocks.ensureSession.mockReset()
  mocks.openChatSession.mockReset()
  mocks.getKolByoSources.mockReset()
  mocks.openChatSession.mockResolvedValue({ id: 'cs_1', status: 'open' })
  mocks.getKolByoSources.mockResolvedValue({ rows: [] })
})

describe('apiErrorText：403 与 501 分开说', () => {
  it('网关判权限拒的 403 → 「这条职责没有这项权限」，不露 customer.read', () => {
    const text = apiErrorText(denied(), zh)
    expect(text).toBe(zh('error.forbidden'))
    expect(text).not.toContain('customer.read')
    expect(isPermissionDenied(denied())).toBe(true)
  })

  it('501 → 「这台没装」，不露 GatewayDeps 这种开发者字眼', () => {
    expect(apiErrorText(notInstalled(), zh)).toBe(zh('error.not_implemented'))
    expect(apiErrorText(notInstalled(), zh)).not.toBe(apiErrorText(denied(), zh))
  })

  it('一页可以把两句换成更具体的', () => {
    const o = { forbidden: zh('chat.forbidden'), not_implemented: zh('chat.unavailable') }
    expect(apiErrorText(denied(), zh, o)).toBe(zh('chat.forbidden'))
    expect(apiErrorText(notInstalled(), zh, o)).toBe(zh('chat.unavailable'))
  })

  it('业务自己写的 403 本来就是人话，原样给；429 / 连不上各一句', () => {
    const own = new ApiClientError(403, { code: 'forbidden', message: '只有 owner 改得动' })
    expect(apiErrorText(own, zh)).toBe('只有 owner 改得动')
    expect(isPermissionDenied(own)).toBe(false)
    expect(
      apiErrorText(new ApiClientError(429, { code: 'budget_exhausted', message: 'x' }), zh),
    ).toBe(zh('error.rate_limited'))
    expect(apiErrorText(new TypeError('Failed to fetch'), zh)).toBe(zh('error.network'))
  })
})

describe('试聊页挑自己的分配', () => {
  it('当前岗位是店主时，用名下「网站在线客服」那条开会话', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER, CHAT]))
    renderWithProviders(<ChatSandboxPage />, '/chat', 'asg_owner')
    await screen.findByTestId('chat-sandbox')
    expect(mocks.openChatSession).toHaveBeenCalledWith('asg_chat')
  })

  it('名下没有这条职责：说清楚缺什么、去哪加，不发请求', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER]))
    renderWithProviders(<ChatSandboxPage />, '/chat', 'asg_owner')
    const box = await screen.findByTestId('chat-duty-needed')
    expect(box.textContent).toContain('你名下没有「网站在线客服」这条职责')
    expect(screen.getByTestId('chat-duty-needed-org').getAttribute('href')).toBe(
      '/org?tab=positions',
    )
    expect(screen.getByTestId('chat-duty-needed-onboarding')).toBeTruthy()
    expect(mocks.openChatSession).not.toHaveBeenCalled()
  })

  it('这条职责范围为空：说去分配，不发必 403 的请求', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER, { ...CHAT, ranges: [] }]))
    renderWithProviders(<ChatSandboxPage />, '/chat', 'asg_owner')
    const box = await screen.findByTestId('chat-duty-needed')
    expect(box.getAttribute('data-kind')).toBe('no_range')
    expect(mocks.openChatSession).not.toHaveBeenCalled()
  })

  it('403：说「没有网站在线客服的权限」，不说「没装」；有「重试」', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER, CHAT]))
    mocks.openChatSession.mockRejectedValueOnce(denied())
    renderWithProviders(<ChatSandboxPage />, '/chat', 'asg_owner')
    const text = await screen.findByTestId('chat-error-text')
    expect(text.textContent).toBe(zh('chat.forbidden'))
    expect(text.textContent).not.toContain('没有装')
    fireEvent.click(screen.getByTestId('chat-error-retry'))
    await screen.findByTestId('chat-sandbox')
  })

  it('501：说「这台服务上没有装在线客服」', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER, CHAT]))
    mocks.openChatSession.mockRejectedValue(notInstalled())
    renderWithProviders(<ChatSandboxPage />, '/chat', 'asg_owner')
    const text = await screen.findByTestId('chat-error-text')
    expect(text.textContent).toBe(zh('chat.unavailable'))
  })
})

describe('连接页「自带数据接口」挑红人职责', () => {
  it('用名下的红人职责读，不用店主那条', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER, YT]))
    renderWithProviders(<ByoSourceCard channel="youtube" />, '/connections', 'asg_owner')
    await waitFor(() => {
      expect(mocks.getKolByoSources).toHaveBeenCalledWith('asg_yt')
    })
  })

  it('没有红人职责：一句话 + 去哪加，不发请求', async () => {
    mocks.ensureSession.mockResolvedValue(me([OWNER]))
    renderWithProviders(<ByoSourceCard channel="youtube" />, '/connections', 'asg_owner')
    const line = await screen.findByTestId('byo-duty-needed')
    expect(line.textContent).toContain('红人营销')
    expect(mocks.getKolByoSources).not.toHaveBeenCalled()
  })
})
