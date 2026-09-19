/**
 * 静态托管与 SPA fallback（36 §5.1）。
 *
 * 钉住的那一条是**职责 id 带点**：`kol.youtube` / `dtc.store` 这些 id 里有 `.`，
 * 于是 `/positions/<asg>/duties/kol.youtube` 看着像"后缀 `.youtube` 的文件"。
 * 早先的 fallback 按"有没有后缀"判，F5 一下这条地址就是网关的 404 信封——
 * 前端路由没机会接管（点站内链接没事，客户端路由不重新发请求）。
 *
 * 现在按**请求是不是浏览器导航**判（Accept 里有 text/html）：
 * 导航拿 index.html，资源请求该 404 就 404。
 */
import { Hono } from 'hono'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountStatic } from '../src/static.js'

const INDEX = '<!doctype html><title>Agents 工坊</title>'

function app(): Hono {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-static-'))
  writeFileSync(join(dir, 'index.html'), INDEX, 'utf8')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)', 'utf8')
  const h = new Hono()
  // 网关的地盘：这里只放一条，用来证明静态托管不碰它
  h.get('/v1/nope', (c) => c.json({ code: 'not_found' }, 404))
  mountStatic(h, { dir, bootstrap: { demo: true } })
  return h
}

const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

describe('SPA fallback：导航才回 index.html', () => {
  it('带点的职责地址刷新一下也是页面，不是 404 信封', async () => {
    const res = await app().request('/positions/asg_1/duties/kol.youtube', { headers: NAV })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Agents 工坊')
  })

  it('不带点的路径照旧', async () => {
    const res = await app().request('/positions/asg_1', { headers: NAV })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Agents 工坊')
  })

  it('真文件照旧按类型给', async () => {
    const res = await app().request('/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
  })

  it('资源请求拿 404，不被 index.html 冒充', async () => {
    const res = await app().request('/assets/missing.png', { headers: { accept: 'image/png' } })
    expect(res.status).toBe(404)
  })

  it('fetch 要 JSON 的请求也不被冒充', async () => {
    const res = await app().request('/positions/asg_1/duties/kol.youtube', {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(404)
  })

  it('/v1 与 bootstrap 归网关，静态托管不碰', async () => {
    const h = app()
    expect((await h.request('/v1/nope')).status).toBe(404)
    const boot = await h.request('/app/bootstrap.json')
    expect(boot.status).toBe(200)
    expect(await boot.json()).toEqual({ demo: true })
  })

  it('路径穿越拿不到 dir 外面的文件', async () => {
    const res = await app().request('/..%2f..%2fetc%2fpasswd', { headers: NAV })
    // 回 index.html 是对的（导航请求）；要紧的是**没有**把外面的文件读出来
    const text = await res.text()
    expect(text).not.toContain('root:')
    expect(text).toContain('Agents 工坊')
  })
})
