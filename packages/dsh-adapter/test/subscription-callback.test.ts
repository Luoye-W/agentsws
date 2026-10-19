/**
 * WP426：ChatGPT 订阅「浏览器登录」回来那一页是工坊自己的（`subscription-callback.ts`）。
 *
 * - 页面：工坊标记 + 中文一句，跟系统深 / 浅色；没有上游那张方块 logo、没有英文「Authentication successful」；
 * - 占端口：浏览器带 code 回来 → 页面 200 + 交出整条地址；同一次只交一次；占不住就回 undefined（让上游自己来）。
 *
 * 端口用随机的，不碰真 1455。
 */
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { renderCallbackPage, startBrandedCallback } from '../src/subscription-callback.js'

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

describe('WP426 订阅登录回来的那一页', () => {
  it('成功页：中文一句 + 工坊标记，跟系统深浅色；不带上游的英文与方块 logo', () => {
    const html = renderCallbackPage({ ok: true })
    expect(html).toContain('登录好了')
    expect(html).toContain('可以关掉这页，回到 Agents 工坊')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('<svg')
    expect(html).not.toMatch(/Authentication successful|Signed in to/)
    expect(html).not.toContain('#F09082')
    expect(html).not.toMatch(/<script/i)
  })

  it('失败页：说没登上，原因转义后再放进去', () => {
    const html = renderCallbackPage({ ok: false, detail: '<b>access_denied</b>' })
    expect(html).toContain('没登上')
    expect(html).toContain('&lt;b&gt;access_denied&lt;/b&gt;')
    expect(html).not.toContain('<b>access_denied</b>')
  })

  it('占住端口：带 code 回来 → 工坊的页面 + 整条地址交出去；第二次不再交', async () => {
    const port = await freePort()
    const cb = await startBrandedCallback({ port, hosts: ['127.0.0.1'] })
    expect(cb).toBeDefined()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c1&state=s1`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('登录好了')
      await expect(cb?.received).resolves.toBe(
        `http://localhost:${port}/auth/callback?code=c1&state=s1`,
      )
      const again = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c2&state=s1`)
      expect(again.status).toBe(409)
      const other = await fetch(`http://127.0.0.1:${port}/elsewhere`)
      expect(other.status).toBe(404)
    } finally {
      cb?.close()
    }
  })

  it('端口被别人占着：回 undefined（上游自己走「贴回来」那条退路）', async () => {
    const port = await freePort()
    const holder = await startBrandedCallback({ port, hosts: ['127.0.0.1'] })
    try {
      expect(await startBrandedCallback({ port, hosts: ['127.0.0.1'] })).toBeUndefined()
    } finally {
      holder?.close()
    }
  })
})
