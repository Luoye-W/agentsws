/**
 * WP126：自带数据接口的两块本地件。
 *
 * 1. `createByoSourceStore`：配置落本地文件，**密钥只进本机加密库**——
 *    文件里一个字节的密钥都没有，只有加密库 key 名；
 * 2. `byoSearch` / `byoTestConnection`：超时、限流、密钥不对、回得不对，
 *    各有一句人话；服务自己的 `message` 原样带回去（不吞、不编）。
 *
 * 全部替身，不联网。
 */
import { describe, expect, it } from 'vitest'
import {
  byoEndpointOf,
  byoSearch,
  byoTestConnection,
  createByoSourceStore,
} from '../src/kol-byo.js'
import type { SecretStore } from '../src/secret-store.js'

/** 内存版加密库（形状与 SecretStore 对齐）。 */
function memorySecrets(): SecretStore & { dump(): Map<string, Record<string, string>> } {
  const map = new Map<string, Record<string, string>>()
  return {
    available: true,
    put: (_id, fields) => {
      map.set('last', fields)
      return { connection_id: 'x', fields, created_at: '' } as never
    },
    get: (id) => map.get(id),
    dump: () => map,
  } as never
}

const config = {
  service_url: 'https://byo.example',
  secret_ref: 'kol.byo.youtube',
  format: 'byo/v1' as const,
}

const secrets = () => 'byo-key'

function okFetch(body: unknown, status = 200): (url: string, init: never) => Promise<Response> {
  return (url, init) => {
    void init
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as Promise<Response>
  }
}

describe('WP126 自带数据接口 · 配置仓', () => {
  it('密钥只进加密库；文件（返回的 record）里只有引用', () => {
    const store = createByoSourceStore({
      secrets: memorySecrets(),
      now: () => '2026-09-21T00:00:00.000Z',
    })
    const rec = store.set('youtube', { service_url: 'https://byo.example', api_key: 'sk-secret' })
    expect(rec.secret_ref).toBe('kol.byo.youtube')
    expect(JSON.stringify(rec)).not.toContain('sk-secret')
    // 路由第②级拿到的那份配置：地址 + 引用 + 格式，没有明文
    expect(store.get('youtube')).toEqual({
      service_url: 'https://byo.example',
      secret_ref: 'kol.byo.youtube',
      format: 'byo/v1',
    })
    expect(store.clear('youtube')).toBe(true)
    expect(store.get('youtube')).toBeUndefined()
  })
})

describe('WP126 自带数据接口 · 适配器纪律', () => {
  it('端点地址：服务地址 + /byo/v1/<动作>', () => {
    expect(byoEndpointOf(config, 'search')).toBe('https://byo.example/byo/v1/search')
    // 结尾多了斜杠也不出双斜杠
    expect(byoEndpointOf({ ...config, service_url: 'https://byo.example/' }, 'contacts')).toBe(
      'https://byo.example/byo/v1/contacts',
    )
  })

  it('搜索成功：归一化行带回来；别的渠道的数据不混进来', async () => {
    const out = await byoSearch(
      config,
      secrets,
      { channel: 'youtube', q: '美妆' },
      new Set(),
      okFetch({
        creators: [
          {
            channel: 'youtube',
            handle: 'a',
            display_name: 'A',
            url: 'https://x.example/a',
            observed_at: '2026-09-21T00:00:00.000Z',
          },
          {
            channel: 'instagram',
            handle: 'wrong',
            display_name: 'Wrong',
            url: 'https://x.example/w',
            observed_at: '2026-09-21T00:00:00.000Z',
          },
        ],
      }),
    )
    expect(out.ok).toBe(true)
    expect(out.data?.rows).toHaveLength(1)
    expect(out.data?.rows[0]?.handle).toBe('a')
  })

  it('限流：服务自己的那句人话原样带回来', async () => {
    const out = await byoSearch(
      config,
      secrets,
      { channel: 'youtube' },
      new Set(),
      okFetch({ code: 'rate_limited', message: '你今天已经问了我 800 回了' }, 429),
    )
    expect(out.ok).toBe(false)
    expect(out.message).toContain('800 回')
    expect(out.reason).toBe('rate_limited')
  })

  it('密钥读不出来：不发起请求，直接一句人话', async () => {
    let called = false
    const out = await byoSearch(
      config,
      () => undefined,
      { channel: 'youtube' },
      new Set(),
      (_url, _init) => {
        called = true
        return Promise.resolve(new Response('{}')) as unknown as Promise<Response>
      },
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_secret')
    expect(called).toBe(false)
  })

  it('回的不是 JSON：bad_response，一句人话', async () => {
    const out = await byoSearch(
      config,
      secrets,
      { channel: 'youtube' },
      new Set(),
      (() => Promise.resolve(new Response('<html>hi</html>'))) as never,
    )
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('bad_response')
  })
})

describe('WP126 自带数据接口 · 测试连接', () => {
  it('200 与 404（查无此人）都算通', async () => {
    const ok = await byoTestConnection(
      config,
      secrets,
      'youtube',
      okFetch({ creator: {}, sample_size: 0, insufficient_samples: true, risk_flags: [] }),
    )
    expect(ok.ok).toBe(true)
    const notFound = await byoTestConnection(
      config,
      secrets,
      'youtube',
      okFetch({ code: 'not_found', message: '没有这个人' }, 404),
    )
    expect(notFound.ok).toBe(true)
  })

  it('401 不算通，且说的是"密钥不对"', async () => {
    const out = await byoTestConnection(config, secrets, 'youtube', okFetch({}, 401))
    expect(out.ok).toBe(false)
    expect(out.message).toContain('密钥')
  })
})
