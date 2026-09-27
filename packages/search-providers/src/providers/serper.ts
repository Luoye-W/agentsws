/**
 * WP155：Serper 适配器（只给「自带 key」那一档用，只有 Google 网页结果，没有 AI 概览、
 * 没有任何 AI 平台，docs/81 §1.1）。
 *
 * `POST https://google.serper.dev/search`，头 `X-API-KEY`，体 `{ q, gl, hl, num }`。
 * 它没有正式文档，形状照官网首页的示例（docs/81 §3）。设备参数未核实，不传。
 */
import type { SerpItem } from '@agentsws/contracts'
import { domainOf, SearchDataError } from '../analyze.js'
import {
  arr,
  callProvider,
  obj,
  type ProviderSerp,
  renumber,
  SERP_TIMEOUT_MS,
  type SearchProviderAdapter,
  str,
} from '../provider.js'

export const SERPER_BASE = 'https://google.serper.dev'
const LABEL = 'Serper'

export function parseSerper(body: Record<string, unknown>): ProviderSerp {
  const items: Omit<SerpItem, 'position'>[] = []
  for (const el of arr(body.organic).map(obj)) {
    const url = str(el.link)
    if (url === undefined) continue
    const snippet = str(el.snippet)
    items.push({
      url,
      domain: domainOf(url),
      title: str(el.title) ?? url,
      ...(snippet === undefined ? {} : { snippet }),
      type: 'organic',
    })
  }
  const paa = arr(body.peopleAlsoAsk)
    .map((q) => str(obj(q).question))
    .filter((q): q is string => q !== undefined)
  return { items: renumber(items), ...(paa.length === 0 ? {} : { people_also_ask: paa }) }
}

export const serper: SearchProviderAdapter = {
  id: 'serper',
  engines: ['google'],
  platforms: [],
  async serp(q, key, fetch) {
    if (q.engine !== 'google') throw new SearchDataError('unsupported', `${LABEL}只查得了 Google。`)
    const body = await callProvider(
      fetch,
      `${SERPER_BASE}/search`,
      {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
        body: JSON.stringify({ q: q.query, gl: q.country, hl: q.language, num: 10 }),
      },
      { key, timeoutMs: SERP_TIMEOUT_MS, label: LABEL, errorText: (b) => str(obj(b).message) },
    )
    return parseSerper(obj(body))
  },
  async aiAnswer() {
    throw new SearchDataError('unsupported', `${LABEL}探测不了 AI 平台。`)
  },
  async test(key, fetch) {
    // 它没有不花钱的账户口：测试就是查一次（算你那边 1 次额度）
    await serper.serp(
      { query: 'test', engine: 'google', country: 'us', language: 'en' },
      key,
      fetch,
    )
  },
  costKey: () => 'serper:search',
}
