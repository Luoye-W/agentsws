/**
 * WP265：连接页 Shopify 卡的「连接 Shopify」一键授权，卡片各状态。
 *
 * - 没登录：一句话 + 「登录」→ 就地出注册 / 登录表单；
 * - 老令牌缺 store：「重新登录」→ 登录页签、邮箱预填、验码带 `refresh: true`；
 * - 连不上：「再试一次」；
 * - 自动带上店铺域名 → 点「连接 Shopify」→ 打开授权页 + 「在浏览器里点安装」+ 取消 → 连上；
 * - 没有任何来源：出一格域名；云上 501：照实说 + 问号；
 * - 已连接：店名、域名、能管什么、测试连接、断开；失效 / 缺权限：「重新授权」；
 * - 卡片：老的客户端 ID 表单收进「高级」，默认看不到。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderCard } from '@/components/connections/provider-card'
import { ShopifyConnect, scopeWords } from '@/components/connections/shopify-connect'
import type { ProviderView, ShopifyConnectView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const opened: string[] = []
vi.mock('@/components/connections/bridge', () => ({
  openExternal: (url: string) => {
    opened.push(url)
  },
}))

const IDLE: ShopifyConnectView = {
  linked: true,
  email: 'owner@example.com',
  connections: [],
  suggested_shop: '6suegp-md.myshopify.com',
  candidates: [{ shop: '6suegp-md.myshopify.com', source: 'profile' }],
}

const CONNECTED: ShopifyConnectView = {
  ...IDLE,
  connections: [
    {
      shop: '6suegp-md.myshopify.com',
      name: 'Rollout',
      app: 'rollout',
      status: 'connected',
      scopes: ['read_products', 'write_products', 'read_orders'],
      missing_scopes: [],
    },
  ],
  candidates: [],
}

const state = {
  view: IDLE as ShopifyConnectView,
  starts: [] as ({ shop?: string } | undefined)[],
  attempt: 'pending' as 'pending' | 'connected' | 'failed' | 'expired',
  startError: undefined as { reason: string; message: string; status: number } | undefined,
  verify: [] as Record<string, unknown>[],
  tests: [] as string[],
  disconnects: [] as string[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getShopifyConnect: async () => state.view,
    startShopifyConnect: async (input: { shop?: string }) => {
      state.starts.push(input)
      if (state.startError !== undefined)
        throw new actual.ApiClientError(state.startError.status, {
          code: 'not_implemented',
          message: state.startError.message,
          details: { reason: state.startError.reason },
        })
      return {
        attempt_id: 'sha_1',
        authorize_url: 'https://shopify.demo.invalid/admin/oauth/authorize?state=sha_1',
        shop: input.shop ?? '6suegp-md.myshopify.com',
        expires_at: '2026-10-08T10:00:00.000Z',
      }
    },
    getShopifyConnectAttempt: async () => {
      if (state.attempt === 'connected') state.view = CONNECTED
      return { status: state.attempt, shop: '6suegp-md.myshopify.com' }
    },
    testShopifyConnect: async (shop: string) => {
      state.tests.push(shop)
      return { ok: true, shop, name: 'Rollout', domain: shop, checked_at: '2026-10-08T00:00:00Z' }
    },
    disconnectShopifyConnect: async (shop: string) => {
      state.disconnects.push(shop)
      state.view = IDLE
      return { disconnected: true }
    },
    cloudLoginCode: async () => ({
      expires_at: '2026-10-08T00:05:00Z',
      delivered: 'email' as const,
    }),
    cloudLoginCodeVerify: async (input: Record<string, unknown>) => {
      state.verify.push(input)
      state.view = IDLE
      return { linked: true, cloud_base_url: 'x' }
    },
    getCloudAuthConfig: async () => ({
      password_min: 8,
      otp_length: 6,
      otp_ttl_seconds: 300,
      terms_version: '2026-10-05',
    }),
  }
})

beforeEach(() => {
  state.view = IDLE
  state.starts = []
  state.attempt = 'pending'
  state.startError = undefined
  state.verify = []
  state.tests = []
  state.disconnects = []
  opened.length = 0
})

describe('WP265 卡片：点不了的几种', () => {
  it('没登录：一句话 + 登录 → 就地出注册 / 登录表单', async () => {
    state.view = {
      linked: false,
      blocked: { reason: 'not_linked', message: 'x' },
      connections: [],
      candidates: [],
    }
    renderWithProviders(<ShopifyConnect assignment="asg_owner" />)
    expect(await screen.findByText('先登录 Agents 工坊账号，再一键连 Shopify')).toBeTruthy()
    expect(screen.queryByTestId('shopconnect-connect')).toBeNull()
    fireEvent.click(screen.getByTestId('shopconnect-login'))
    expect(await screen.findByTestId('shopconnect-auth')).toBeTruthy()
  })

  it('老令牌缺 store：重新登录 = 登录页签、邮箱预填、验码带 refresh', async () => {
    state.view = {
      linked: true,
      email: 'owner@example.com',
      blocked: { reason: 'scope_missing', message: 'x' },
      connections: [],
      candidates: [],
    }
    renderWithProviders(<ShopifyConnect assignment="asg_owner" />)
    expect(await screen.findByText('账号授权要更新一下，重新登录一次就好')).toBeTruthy()
    fireEvent.click(screen.getByTestId('shopconnect-relogin'))
    const form = await screen.findByTestId('shopconnect-auth')
    expect(form.getAttribute('data-tab')).toBe('login')
    expect((screen.getByTestId('shopconnect-email') as HTMLInputElement).value).toBe(
      'owner@example.com',
    )
    // 注册 / 登录两个页签藏起来了（只能用同一个账号重新登录）
    expect(screen.getByRole('tablist', { hidden: true }).className).toContain('hidden')
  })

  it('连不上云：再试一次', async () => {
    state.view = {
      linked: true,
      blocked: { reason: 'offline', message: 'x' },
      connections: [],
      candidates: [],
    }
    renderWithProviders(<ShopifyConnect />)
    expect(await screen.findByTestId('shopconnect-retry')).toBeTruthy()
  })
})

describe('WP265 卡片：一键授权', () => {
  it('自动带店铺域名 → 连接 → 打开授权页、等安装 → 连上之后是已连接', async () => {
    renderWithProviders(<ShopifyConnect assignment="asg_owner" />)
    expect((await screen.findByTestId('shopconnect-suggested')).textContent).toContain(
      '6suegp-md.myshopify.com',
    )
    fireEvent.click(screen.getByTestId('shopconnect-connect'))
    expect(await screen.findByText('在浏览器里点「安装」，回来就好')).toBeTruthy()
    expect(state.starts).toEqual([{ shop: '6suegp-md.myshopify.com' }])
    expect(opened).toEqual(['https://shopify.demo.invalid/admin/oauth/authorize?state=sha_1'])
    state.attempt = 'connected'
    const row = await screen.findByTestId('shopconnect-row', {}, { timeout: 5000 })
    expect(row.textContent).toContain('Rollout')
    expect(screen.queryByTestId('shopconnect-waiting')).toBeNull()
  })

  it('取消：不再等，回到连接按钮', async () => {
    renderWithProviders(<ShopifyConnect />)
    fireEvent.click(await screen.findByTestId('shopconnect-connect'))
    fireEvent.click(await screen.findByTestId('shopconnect-cancel'))
    expect(await screen.findByTestId('shopconnect-connect')).toBeTruthy()
  })

  it('授权没成：失败与过期各一句', async () => {
    state.attempt = 'failed'
    renderWithProviders(<ShopifyConnect />)
    fireEvent.click(await screen.findByTestId('shopconnect-connect'))
    const line = await screen.findByTestId('shopconnect-outcome', {}, { timeout: 5000 })
    expect(line.getAttribute('data-kind')).toBe('failed')
  })

  it('没有任何来源：出一格域名，填了才能点', async () => {
    state.view = { ...IDLE, suggested_shop: undefined, candidates: [] }
    renderWithProviders(<ShopifyConnect />)
    const input = (await screen.findByTestId('shopconnect-shop')) as HTMLInputElement
    expect((screen.getByTestId('shopconnect-connect') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'inmo-global.myshopify.com' } })
    expect((screen.getByTestId('shopconnect-connect') as HTMLButtonElement).disabled).toBe(false)
  })

  it('云上 501：照实说暂不支持（等公开应用）', async () => {
    state.startError = { status: 501, reason: 'unsupported', message: '不在范围' }
    renderWithProviders(<ShopifyConnect />)
    fireEvent.click(await screen.findByTestId('shopconnect-connect'))
    const line = await screen.findByTestId('shopconnect-outcome')
    expect(line.getAttribute('data-kind')).toBe('unsupported')
    expect(line.textContent).toContain('暂不支持一键授权')
  })
})

describe('WP265 卡片：已连接', () => {
  it('店名、域名、能管什么；测试连接、断开', async () => {
    state.view = CONNECTED
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    renderWithProviders(<ShopifyConnect />)
    const row = await screen.findByTestId('shopconnect-row')
    expect(row.textContent).toContain('Rollout')
    expect(row.textContent).toContain('6suegp-md.myshopify.com')
    expect(screen.getByTestId('shopconnect-can').textContent).toBe('能管：商品、订单（只看）')
    expect(screen.queryByTestId('shopconnect-reauth')).toBeNull()
    fireEvent.click(screen.getByTestId('shopconnect-test'))
    expect((await screen.findByTestId('shopconnect-test-result')).textContent).toBe('通了：Rollout')
    fireEvent.click(screen.getByTestId('shopconnect-disconnect'))
    await waitFor(() => {
      expect(state.disconnects).toEqual(['6suegp-md.myshopify.com'])
    })
  })

  it('授权失效 / 缺权限：重新授权（对这家店再起一次）', async () => {
    state.view = {
      ...CONNECTED,
      connections: [
        {
          shop: '6suegp-md.myshopify.com',
          status: 'reauth_required',
          reauth_reason: 'app_uninstalled',
          scopes: [],
          missing_scopes: ['read_orders'],
        },
      ],
    }
    renderWithProviders(<ShopifyConnect />)
    expect((await screen.findByTestId('shopconnect-missing')).textContent).toBe(
      '还缺：订单（只看）',
    )
    fireEvent.click(screen.getByTestId('shopconnect-reauth'))
    await waitFor(() => {
      expect(state.starts).toEqual([{ shop: '6suegp-md.myshopify.com' }])
    })
  })
})

describe('WP265 Shopify 卡：老表单收进「高级」', () => {
  const provider = {
    service: 'shopify_admin',
    label: 'Shopify',
    auth: 'custom_credential',
    available: true,
    fields: [],
    setup_guide: { summary: '', steps: [], links: [] },
  } as unknown as ProviderView

  it('默认只看到一键授权；点「高级」才出老的连接按钮', async () => {
    renderWithProviders(
      <ProviderCard
        provider={provider}
        highlighted={false}
        connected={false}
        phase="idle"
        fields={undefined}
        result={undefined}
        oauthUrl={undefined}
        assignment={undefined}
        onStart={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        oneClick={<div data-testid="one-click-slot" />}
        advancedLabel="高级：用自己的 Shopify 应用"
      />,
    )
    expect(screen.getByTestId('one-click-slot')).toBeTruthy()
    expect(screen.queryByTestId('provider-legacy')).toBeNull()
    fireEvent.click(screen.getByTestId('provider-advanced-toggle'))
    expect(screen.getByTestId('provider-legacy')).toBeTruthy()
  })

  it('权限名翻人话：读写只说名字，只读标「只看」，认不得的原样', () => {
    const t = (k: string, v?: Record<string, string | number>) =>
      k === 'shopconnect.scope.read_only'
        ? `${String(v?.name)}（只看）`
        : k === 'shopconnect.scope.products'
          ? '商品'
          : k
    expect(scopeWords(['read_products', 'write_products', 'read_gift_cards'], t)).toEqual([
      '商品',
      'gift_cards（只看）',
    ])
  })
})
