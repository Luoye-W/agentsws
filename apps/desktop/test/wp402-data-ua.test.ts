/**
 * WP402（决策 1140 / 1146「不伪装 UA」）：内置浏览器读数据地址原文（竞品独立站公开商品数据）那一次导航，
 * User-Agent 末尾自报 Agent 身份；只加一次；Chromium 原有那几段不去掉。普通网页照旧。
 */
import { describe, expect, it } from 'vitest'
import { AMAZON_AGENT_TOKEN, cleanUserAgent, dataUserAgent } from '../src/search-browser.js'

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('WP402 · 读数据原文时自报身份', () => {
  it('末尾加 Agent/AgentsWorkshop，只加一次，原来那几段都在', () => {
    const ua = dataUserAgent(CHROME)
    expect(ua.endsWith(AMAZON_AGENT_TOKEN)).toBe(true)
    expect(ua.startsWith(CHROME)).toBe(true)
    expect(dataUserAgent(ua)).toBe(ua)
  })
  it('普通网页那一份不变（只洗掉 Electron / 应用名，不冒充别的浏览器）', () => {
    expect(cleanUserAgent(`${CHROME} AgentsWorkshop/1.0 Electron/38.0.0`)).toBe(CHROME)
  })
})
