/**
 * Shopify 客户端凭据换令牌（WP25 交付 A）。
 *
 * 全程**不联网**：Shopify 的 `/admin/oauth/access_token` 由一个 fixture 回放
 * （录的是 2026-09 官方文档写明的形状：`{ access_token, scope, expires_in: 86399 }`）。
 *
 * 盯四件事：换令牌那一跳、刷新时机（到期前 1 小时）、错误映射成中文人话、
 * 以及**客户端密钥与访问令牌一个字节都不许漏出去**。
 */
import { describe, expect, it } from 'vitest'
import {
  type BrokerFetch,
  type BrokerRecordStore,
  type BrokerVault,
  createShopifyBroker,
  exchangeClientCredentials,
  mapExchangeError,
  normalizeShopDomain,
  REFRESH_LEAD_MS,
  ShopifyBrokerError,
  type ShopifyBrokerRecord,
  scrub,
} from '../src/shopify-broker.js'

const T0 = '2026-09-09T09:00:00.000Z'

/** 这个测试文件里唯一的两个"凭据"。所有零泄漏断言都盯着它们。 */
const CLIENT_SECRET = 'shopify-client-secret-Zq7-never-logged'
const ACCESS_TOKEN = 'shpat_fixture_token_never_logged_4242'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** 内存秘密库（形状与 `secret-store.ts` 的 `SecretStore` 一致的最小面）。 */
function makeVault(available = true): BrokerVault & { rows: Map<string, Record<string, string>> } {
  const rows = new Map<string, Record<string, string>>()
  return {
    rows,
    available,
    put(id, fields) {
      rows.set(id, { ...fields })
      return fields
    },
    get: (id) => rows.get(id),
    remove: (id) => rows.delete(id),
  }
}

function makeRecords(): BrokerRecordStore & { rows: ShopifyBrokerRecord[] } {
  const rows: ShopifyBrokerRecord[] = []
  return {
    rows,
    list: () => rows,
    put(record) {
      const at = rows.findIndex((r) => r.shop === record.shop)
      if (at >= 0) rows[at] = record
      else rows.push(record)
    },
    remove(shop) {
      const at = rows.findIndex((r) => r.shop === shop)
      if (at >= 0) rows.splice(at, 1)
    },
  }
}

/**
 * Shopify 的 fixture。默认档回官方文档写的那个形状；
 * `fail` 档回一条真实的错误体。记下每次请求，供断言用。
 */
function makeShopify(options: { fail?: { status: number; body: string } } = {}) {
  const calls: { url: string; body: unknown }[] = []
  let issued = 0
  const doFetch: BrokerFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as unknown })
    if (options.fail !== undefined) {
      return {
        ok: false,
        status: options.fail.status,
        text: async () => options.fail?.body ?? '',
      }
    }
    issued += 1
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: `${ACCESS_TOKEN}_${issued}`,
          scope: 'read_orders,write_orders,read_returns,write_returns,read_customers,read_products',
          expires_in: 86_399,
        }),
    }
  }
  return { doFetch, calls, issued: () => issued }
}

function makeBroker(over: Partial<Parameters<typeof createShopifyBroker>[0]> = {}) {
  const clock = makeClock()
  const vault = makeVault()
  const records = makeRecords()
  const shopify = makeShopify()
  const pushed: { shop: string; alias: string; accessToken: string }[] = []
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const broker = createShopifyBroker({
    clock,
    vault,
    records,
    fetch: shopify.doFetch,
    async pushToken(input) {
      pushed.push(input)
      return { connection_id: 'conn-shop-1', display_name: 'Acme 旗舰店' }
    },
    appendEvent: (type, payload) => {
      events.push({ type, payload })
    },
    ...over,
  })
  return { broker, clock, vault, records, shopify, pushed, events }
}

describe('WP25 §A 店铺域名归一', () => {
  it('几种写法都收敛成 xxx.myshopify.com', () => {
    expect(normalizeShopDomain('acme')).toBe('acme.myshopify.com')
    expect(normalizeShopDomain('acme.myshopify.com')).toBe('acme.myshopify.com')
    expect(normalizeShopDomain('https://acme.myshopify.com/')).toBe('acme.myshopify.com')
    expect(normalizeShopDomain('  ACME.MyShopify.com ')).toBe('acme.myshopify.com')
    // 新后台的地址栏——非技术用户最容易直接复制它
    expect(normalizeShopDomain('https://admin.shopify.com/store/acme-store')).toBe(
      'acme-store.myshopify.com',
    )
    expect(normalizeShopDomain('admin.shopify.com/store/acme/orders')).toBe('acme.myshopify.com')
  })

  it('看不懂的写法抛中文人话，而不是把垃圾发给 Shopify', () => {
    for (const bad of ['', '   ', 'not a domain!', 'https://例子.com']) {
      const thrown = (() => {
        try {
          normalizeShopDomain(bad)
          return undefined
        } catch (e) {
          return e
        }
      })()
      expect(thrown, bad).toBeInstanceOf(ShopifyBrokerError)
      expect((thrown as ShopifyBrokerError).code, bad).toBe('invalid_shop')
    }
  })
})

describe('WP25 §A 错误映射（上游机器码 → 中文）', () => {
  it('shop_not_permitted：应用和店铺不在同一个组织', () => {
    const m = mapExchangeError(400, JSON.stringify({ error: 'shop_not_permitted' }))
    expect(m.code).toBe('shop_not_permitted')
    expect(m.message).toContain('同一个 Dev Dashboard 组织')
    expect(m.message).toContain('Install app')
  })

  it('invalid_client：客户端 ID 或密钥不对', () => {
    const m = mapExchangeError(400, JSON.stringify({ error: 'invalid_client' }))
    expect(m.code).toBe('invalid_client')
    expect(m.message).toContain('客户端 ID 或密钥不对')
  })

  it('401 没给 error 字段也算 invalid_client', () => {
    expect(mapExchangeError(401, 'Unauthorized').code).toBe('invalid_client')
  })

  it('纯文本里带机器码也认得出来（Shopify 偶尔不回 JSON）', () => {
    expect(mapExchangeError(400, '[API] shop_not_permitted').code).toBe('shop_not_permitted')
  })

  it('404 / 429 / 其它各有各的说法，全是中文', () => {
    expect(mapExchangeError(404, '').code).toBe('invalid_shop')
    expect(mapExchangeError(429, '').code).toBe('rate_limited')
    expect(mapExchangeError(500, '<html>').code).toBe('unexpected_response')
    for (const status of [404, 429, 500]) {
      expect(mapExchangeError(status, '').message).toMatch(/[一-龥]/)
    }
  })

  it('invalid_grant 提示"这个应用要在 Dev Dashboard 里建"', () => {
    const m = mapExchangeError(400, JSON.stringify({ error: 'invalid_grant' }))
    expect(m.code).toBe('invalid_grant')
    expect(m.message).toContain('Dev Dashboard')
  })
})

describe('WP25 §A scrub：出口再筛一次', () => {
  it('疑似令牌与长十六进制串一律抹掉', () => {
    expect(scrub(`token=${ACCESS_TOKEN} ok`)).not.toContain(ACCESS_TOKEN)
    expect(scrub(`secret ${'a'.repeat(40)}`)).not.toContain('a'.repeat(40))
    expect(scrub('x'.repeat(1000)).length).toBeLessThanOrEqual(300)
  })
})

describe('WP25 §A 换令牌', () => {
  it('body 就是官方那三个字段，URL 打在店铺自己的域名上', async () => {
    const shopify = makeShopify()
    const issued = await exchangeClientCredentials(
      { shop: 'acme.myshopify.com', client_id: 'cid', client_secret: CLIENT_SECRET },
      shopify.doFetch,
    )
    expect(shopify.calls[0]?.url).toBe('https://acme.myshopify.com/admin/oauth/access_token')
    expect(shopify.calls[0]?.body).toEqual({
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    })
    expect(issued.expires_in).toBe(86_399)
    expect(issued.scope).toContain('read_orders')
  })

  it('网络不通抛 shop_unreachable，且原文经过 scrub', async () => {
    await expect(
      exchangeClientCredentials(
        { shop: 'acme.myshopify.com', client_id: 'cid', client_secret: CLIENT_SECRET },
        async () => {
          throw new Error(`fetch failed for ${ACCESS_TOKEN}`)
        },
      ),
    ).rejects.toMatchObject({ code: 'shop_unreachable' })
  })

  it('回了 200 但没有 access_token：明确报错，不假装成功', async () => {
    await expect(
      exchangeClientCredentials(
        { shop: 'acme.myshopify.com', client_id: 'cid', client_secret: CLIENT_SECRET },
        async () => ({ ok: true, status: 200, text: async () => '{"scope":"x"}' }),
      ),
    ).rejects.toMatchObject({ code: 'unexpected_response' })
    await expect(
      exchangeClientCredentials(
        { shop: 'acme.myshopify.com', client_id: 'cid', client_secret: CLIENT_SECRET },
        async () => ({ ok: true, status: 200, text: async () => 'not json' }),
      ),
    ).rejects.toMatchObject({ code: 'unexpected_response' })
  })

  it('上游没给 expires_in 时按 Shopify 的 86399 秒兜底', async () => {
    const issued = await exchangeClientCredentials(
      { shop: 'a.myshopify.com', client_id: 'c', client_secret: CLIENT_SECRET },
      async () => ({ ok: true, status: 200, text: async () => '{"access_token":"t"}' }),
    )
    expect(issued.expires_in).toBe(86_399)
    expect(issued.scope).toBe('')
  })
})

describe('WP25 §A 接管一家店', () => {
  it('换令牌 → 推进 OpenConnector → 记到期时间；密钥进加密库、令牌不进', async () => {
    const { broker, vault, records, pushed, events } = makeBroker()
    const record = await broker.connect({
      shop: 'https://admin.shopify.com/store/acme',
      alias: '主店',
      client_id: 'cid-123',
      client_secret: CLIENT_SECRET,
    })

    expect(record.shop).toBe('acme.myshopify.com')
    expect(record.connection_id).toBe('conn-shop-1')
    // 24 小时后过期
    expect(Date.parse(record.expires_at) - Date.parse(T0)).toBe(86_399_000)
    expect(records.rows).toHaveLength(1)

    // 令牌只去了一个地方：OpenConnector
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.accessToken).toContain('shpat_')

    // 加密库里存的是**应用凭据**，不是令牌
    const stored = vault.rows.get('shopify_app:acme.myshopify.com')
    expect(stored).toEqual({
      shop: 'acme.myshopify.com',
      client_id: 'cid-123',
      client_secret: CLIENT_SECRET,
    })
    expect(JSON.stringify(stored)).not.toContain('shpat_')

    // ── 零泄漏：返回值与事件里没有密钥、没有令牌、连 client_id 都没有
    const wire = JSON.stringify({ record, events })
    expect(wire).not.toContain(CLIENT_SECRET)
    expect(wire).not.toContain('shpat_')
    expect(wire).not.toContain('cid-123')
    expect(events.map((e) => e.type)).toEqual(['connect.shopify_token_issued'])
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      'connection_id',
      'expires_at',
      'scope',
      'shop',
    ])
  })

  it('换不到令牌时不把密钥留在本机（用户多半是填错了）', async () => {
    const clock = makeClock()
    const vault = makeVault()
    const records = makeRecords()
    const shopify = makeShopify({
      fail: { status: 400, body: JSON.stringify({ error: 'shop_not_permitted' }) },
    })
    const broker = createShopifyBroker({
      clock,
      vault,
      records,
      fetch: shopify.doFetch,
      pushToken: async () => ({ connection_id: 'x' }),
    })
    await expect(
      broker.connect({
        shop: 'acme',
        alias: '主店',
        client_id: 'cid',
        client_secret: CLIENT_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'shop_not_permitted' })
    expect(vault.rows.size).toBe(0)
    expect(records.rows).toEqual([])
  })

  it('没有秘密库密钥时直接拒，并说清楚后果', async () => {
    const { broker } = makeBroker({ vault: makeVault(false) })
    await expect(
      broker.connect({ shop: 'acme', alias: 'a', client_id: 'c', client_secret: CLIENT_SECRET }),
    ).rejects.toMatchObject({ code: 'vault_unavailable' })
  })
})

describe('WP25 §A 刷新', () => {
  it('还早的时候不换；进到期前 1 小时才换', async () => {
    const { broker, clock, shopify, pushed } = makeBroker()
    await broker.connect({
      shop: 'acme',
      alias: '主店',
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
    })
    expect(shopify.issued()).toBe(1)

    // 还剩两小时：不动
    clock.advance(86_399_000 - 2 * REFRESH_LEAD_MS)
    expect(await broker.refreshDue()).toEqual([])
    expect(shopify.issued()).toBe(1)

    // 只剩 59 分钟：换一张
    clock.advance(REFRESH_LEAD_MS + 60_000)
    const rotated = await broker.refreshDue()
    expect(rotated).toHaveLength(1)
    expect(shopify.issued()).toBe(2)
    // 新令牌又推了一次；两次的令牌不是同一串
    expect(pushed).toHaveLength(2)
    expect(pushed[0]?.accessToken).not.toBe(pushed[1]?.accessToken)
    // 到期时间往后推了
    expect(Date.parse(rotated[0]?.expires_at ?? '')).toBeGreaterThan(Date.parse(T0) + 86_399_000)
  })

  it('强制刷新（上游 401 那条路）用的是加密库里那份密钥', async () => {
    const { broker, shopify, vault } = makeBroker()
    await broker.connect({
      shop: 'acme',
      alias: '主店',
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
    })
    await broker.refresh('conn-shop-1')
    expect(shopify.issued()).toBe(2)
    expect(shopify.calls[1]?.body).toMatchObject({
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    })
    expect(vault.rows.size).toBe(1)
  })

  it('不是本经纪人管的连接：refresh 抛 not_found', async () => {
    const { broker } = makeBroker()
    await expect(broker.refresh('conn-nope')).rejects.toMatchObject({ code: 'not_found' })
    expect(broker.recordOf('conn-nope')).toBeUndefined()
  })

  it('密钥被人从加密库里删了：refresh 报 not_found 并让用户重填', async () => {
    const { broker, vault, clock } = makeBroker()
    await broker.connect({
      shop: 'acme',
      alias: '主店',
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
    })
    vault.rows.clear()
    await expect(broker.refresh('conn-shop-1')).rejects.toMatchObject({ code: 'not_found' })
    // 巡检那条路不抛——一家换不到不该拖垮别家
    clock.advance(86_399_000)
    expect(await broker.refreshDue()).toEqual([])
  })

  it('巡检里换失败发一条事件，payload 里只有域名与原因码', async () => {
    const { broker, vault, clock, events } = makeBroker()
    await broker.connect({
      shop: 'acme',
      alias: '主店',
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
    })
    vault.rows.clear()
    clock.advance(86_399_000)
    await broker.refreshDue()
    const failed = events.find((e) => e.type === 'connect.shopify_token_refresh_failed')
    expect(failed?.payload).toEqual({
      shop: 'acme.myshopify.com',
      connection_id: 'conn-shop-1',
      reason: 'not_found',
    })
  })

  it('断开一家店：密钥与记录一起没了；断一条不认识的是空操作', async () => {
    const { broker, vault, records } = makeBroker()
    await broker.connect({
      shop: 'acme',
      alias: '主店',
      client_id: 'cid',
      client_secret: CLIENT_SECRET,
    })
    broker.forget('conn-nope')
    expect(records.rows).toHaveLength(1)
    broker.forget('conn-shop-1')
    expect(vault.rows.size).toBe(0)
    expect(records.rows).toEqual([])
    expect(broker.list()).toEqual([])
  })
})
