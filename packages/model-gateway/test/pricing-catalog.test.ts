/**
 * 内置价目表与官网抓取（WP42 交付 2）。
 *
 * 抓取全程**回放固定的页面**（`test/fixtures/pricing/`，2026-09-10 从各家官网抓下来的
 * 真页面片段），一个字节都不出网。四条主张：
 *
 * 1. 内置价目表按接口地址认得出是哪一家，按模型名（含老名字、含日期后缀）查得到价；
 * 2. 四个解析器抽出来的数字，和那天官网上写的**一模一样**；
 * 3. 抓不到不抛——`ok: false` + 一句人话，内置价原样留着；
 * 4. 请求里有写明自己是谁的 UA，没有任何凭据。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PageFetch } from '../src/index.js'
import {
  catalogPrice,
  hostOf,
  PRICE_CATALOG,
  PRICING_USER_AGENT,
  parseDeepSeek,
  parseKimi,
  parseOpenAi,
  parseZhipu,
  refreshPriceCatalog,
  vendorForBaseUrl,
} from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pricing')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

/** URL → 哪个 fixture。没配的 URL 一律 503（"这一页抓不到"）。 */
const PAGES: Record<string, string> = {
  'https://api-docs.deepseek.com/quick_start/pricing/': 'deepseek.html',
  'https://developers.openai.com/api/docs/pricing': 'openai.html',
  'https://platform.kimi.com/docs/pricing/chat-k3.md': 'kimi-k3.md',
  'https://platform.kimi.com/docs/pricing/chat-k26.md': 'kimi-k26.md',
  'https://platform.kimi.com/docs/pricing/chat-k27-code.md': 'kimi-k27-code.md',
  'https://docs.bigmodel.cn/cn/guide/start/pricing.md': 'zhipu.md',
}

function replayFetch(): { fetch: PageFetch; calls: { url: string; ua: string | undefined }[] } {
  const calls: { url: string; ua: string | undefined }[] = []
  const fetch: PageFetch = async (url, init) => {
    calls.push({ url, ua: init.headers['user-agent'] })
    const name = PAGES[url]
    if (name === undefined) return { ok: false, status: 503, text: async () => '' }
    return { ok: true, status: 200, text: async () => fixture(name) }
  }
  return { fetch, calls }
}

describe('内置价目表', () => {
  it('每条价都带出处与币种（不带就等于凭空出现的默认值）', () => {
    for (const vendor of PRICE_CATALOG.vendors) {
      expect(vendor.source_url, vendor.id).toMatch(/^https:\/\//)
      expect(vendor.as_of, vendor.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(vendor.currency, vendor.id).toMatch(/^[A-Z]{3}$/)
      for (const m of vendor.models) {
        expect(m.in, `${vendor.id}/${m.model}`).toBeGreaterThanOrEqual(0)
        expect(m.out, `${vendor.id}/${m.model}`).toBeGreaterThan(0)
      }
    }
  })

  it('按接口地址认这是哪一家', () => {
    expect(vendorForBaseUrl('https://api.deepseek.com')?.id).toBe('deepseek')
    expect(vendorForBaseUrl('https://api.moonshot.cn/v1')?.id).toBe('moonshot')
    expect(vendorForBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')?.id).toBe('qwen')
    expect(vendorForBaseUrl('https://open.bigmodel.cn/api/paas/v4')?.id).toBe('zhipu')
    // 本机 Ollama 不是任何一家：没有内置价，也不该硬套一条
    expect(vendorForBaseUrl('http://127.0.0.1:11434/v1')).toBeUndefined()
    expect(hostOf('api.deepseek.com/v1')).toBe('api.deepseek.com')
  })

  it('DeepSeek：官网 2026-09-10 那天的三个数字（标准时段）', () => {
    expect(catalogPrice('https://api.deepseek.com', 'deepseek-flash')).toMatchObject({
      in: 0.3,
      out: 1.2,
      cached: 0.006,
      currency: 'USD',
      as_of: '2026-09-10',
    })
    // 官网明说仍然收的老名字，按 flash 价
    expect(catalogPrice('https://api.deepseek.com', 'deepseek-v4-flash')?.out).toBe(1.2)
  })

  it('带日期后缀的模型名也查得到（gpt-5.4-2026-01-01 → gpt-5.4）', () => {
    expect(catalogPrice('https://api.openai.com/v1', 'gpt-5.4-2026-01-01')?.in).toBe(2.5)
  })

  it('查不到就是查不到，不硬套一条（价宁可没有，不可编）', () => {
    expect(catalogPrice('https://api.deepseek.com', 'deepseek-something-new')).toBeUndefined()
    expect(catalogPrice('http://127.0.0.1:11434/v1', 'llama3.1')).toBeUndefined()
  })

  it('SiliconFlow 是模型市场：内置价本来就没有，说明写在表里', () => {
    const sf = PRICE_CATALOG.vendors.find((v) => v.id === 'siliconflow')
    expect(sf?.models).toEqual([])
    expect(sf?.parser).toBe('none')
    expect(sf?.parser_note ?? '').not.toBe('')
  })
})

describe('解析器（回放 2026-09-10 抓下来的真页面）', () => {
  it('DeepSeek：从带 rowspan 的表里抽标准时段那一行', () => {
    const prices = parseDeepSeek(fixture('deepseek.html'))
    expect(prices).toEqual({
      'deepseek-flash': { in: 0.3, out: 1.2, cached: 0.006 },
      'deepseek-v4-pro': { in: 1.32, out: 3.96, cached: 0.044 },
    })
  })

  it('OpenAI：从 flight 数据里抽（列数不固定，输出价永远是最后一个）', () => {
    const prices = parseOpenAi(fixture('openai.html'))
    expect(prices['gpt-5-mini']).toEqual({ in: 0.25, out: 2, cached: 0.025 })
    // 多一列 Fast mode 的那几行也对得上
    expect(prices['gpt-6-astra']).toEqual({ in: 10, out: 50, cached: 1 })
    expect(prices['gpt-4o-mini']).toEqual({ in: 0.15, out: 0.6, cached: 0.075 })
  })

  it('Kimi：从 .md 里那段 rows={[…]} 抽（缓存命中在输入之前）', () => {
    expect(parseKimi(fixture('kimi-k3.md'))).toEqual({
      'kimi-k3': { in: 20, out: 100, cached: 2 },
    })
    expect(parseKimi(fixture('kimi-k27-code.md'))['kimi-k2.7-code-highspeed']).toEqual({
      in: 13,
      out: 54,
      cached: 2.6,
    })
  })

  it('智谱：markdown 竖线表，按表头认列号', () => {
    const prices = parseZhipu(fixture('zhipu.md'))
    expect(prices['glm-5.3']).toEqual({ in: 8, out: 28, cached: 2 })
    expect(prices['glm-5.3-flash']).toEqual({ in: 0.8, out: 2.8, cached: 0.23 })
    // 「限时免费」那一列（缓存存储）不该被当成价抽进来
    expect(Object.values(prices).every((p) => p.out > 0)).toBe(true)
  })

  it('页面结构变了就抽不出东西，而不是抽出一堆假数字', () => {
    expect(parseDeepSeek('<html><body>我们改版了</body></html>')).toEqual({})
    expect(parseZhipu('# 定价\n\n请见控制台')).toEqual({})
    expect(parseKimi('没有表了')).toEqual({})
  })
})

describe('refreshPriceCatalog（回放，不出网）', () => {
  it('抓得到的四家都对上内置价；抓不了的两家明说为什么', async () => {
    const { fetch, calls } = replayFetch()
    const results = await refreshPriceCatalog({ fetch })
    const byId = Object.fromEntries(results.map((r) => [r.vendor_id, r]))

    expect(byId.deepseek?.ok).toBe(true)
    expect(byId.deepseek?.prices['deepseek-flash']).toEqual({ in: 0.3, out: 1.2, cached: 0.006 })
    expect(byId.openai?.ok).toBe(true)
    expect(byId.moonshot?.ok).toBe(true)
    // Kimi 一个模型一页：三页都抓，凑成一份
    expect(Object.keys(byId.moonshot?.prices ?? {}).sort()).toEqual([
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k3',
    ])
    expect(byId.zhipu?.ok).toBe(true)

    expect(byId.qwen?.ok).toBe(false)
    expect(byId.qwen?.reason ?? '').toContain('阶梯')
    expect(byId.siliconflow?.ok).toBe(false)
    expect(byId.siliconflow?.models).toBe(0)

    // 抓不了的那两家一次请求都不发
    expect(calls.some((c) => c.url.includes('aliyun'))).toBe(false)
    expect(calls.some((c) => c.url.includes('siliconflow'))).toBe(false)
    // 每一次都写明自己是谁
    expect(calls.every((c) => c.ua === PRICING_USER_AGENT)).toBe(true)
  })

  it('对面 500 / 改版：ok=false + 原因，一个异常都不往外抛', async () => {
    const fetch: PageFetch = async () => ({ ok: false, status: 500, text: async () => '' })
    const results = await refreshPriceCatalog({ fetch, only: ['deepseek'] })
    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.reason).toContain('HTTP 500')
  })

  it('对面直接断线也不抛', async () => {
    const fetch: PageFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const results = await refreshPriceCatalog({ fetch, only: ['openai'] })
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.reason).toContain('ECONNREFUSED')
  })
})
