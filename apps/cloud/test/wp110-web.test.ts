/**
 * WP110 ② / ⑤：最小网页登录页与扩展过的 health。
 *
 * WP58 的后置清单第 ② 条说"云侧没有网页版登录页"，但漏掉了更要命的一半：
 * magic link 的默认落点 `${baseUrl}/cloud/auth/callback` 是一条**不存在的路由**，
 * 不带 `callback_url` 调一次，信发出去了，点开是 404。这里把两半都钉住。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CALLBACK_PATH, LEGACY_LOGIN_PATH, LOGIN_PATH } from '../src/index.js'
import { type Harness, harness } from './helpers.js'

const tokenFrom = (link: string): string => new URL(link).searchParams.get('token') ?? ''

async function magicLink(h: Harness, email: string, callback?: string): Promise<string> {
  await h.call('/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, ...(callback === undefined ? {} : { callback_url: callback }) },
  })
  return h.lastLink()
}

describe('WP110 magic link 的默认落点', () => {
  it('不给 callback_url 时落在真有的那一页（不再是 404 的 /cloud/auth/callback）', async () => {
    const h = harness()
    try {
      const link = await magicLink(h, 'luoye@example.com')
      expect(new URL(link).pathname).toBe(DEFAULT_CALLBACK_PATH)
      expect(DEFAULT_CALLBACK_PATH).toBe(LOGIN_PATH)
      const page = await h.raw(`${LOGIN_PATH}?token=${tokenFrom(link)}`)
      expect(page.status).toBe(200)
      expect(page.text).toContain('已登录')
    } finally {
      await h.close()
    }
  })

  it('旧落点留着当别名：已经发出去的信照样点得开', async () => {
    const h = harness()
    try {
      const link = await magicLink(h, 'luoye@example.com')
      const page = await h.raw(`${LEGACY_LOGIN_PATH}?token=${tokenFrom(link)}`)
      expect(page.status).toBe(200)
      expect(page.text).toContain('已登录')
    } finally {
      await h.close()
    }
  })
})

describe('WP110 /login 落地页', () => {
  it('验过的链接 → 只说"已登录"与邮箱域名，页面上没有任何凭据', async () => {
    const h = harness()
    try {
      const link = await magicLink(h, 'luoye@example.com')
      const token = tokenFrom(link)
      const page = await h.raw(`${LOGIN_PATH}?token=${token}`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      // 中间层不该把登录结果存下来
      expect(page.headers.get('cache-control')).toBe('no-store')
      expect(page.text).toContain('example.com')
      // 邮箱只到域名；一次性 token 与会话 token 一个都不印
      expect(page.text).not.toContain('luoye@example.com')
      expect(page.text).not.toContain(token)
      expect(page.text).not.toMatch(/cs_[A-Za-z0-9_-]{10,}/)
      expect(page.text).not.toMatch(/cml_[A-Za-z0-9_-]{10,}/)
    } finally {
      await h.close()
    }
  })

  it('一次性：同一条链接点第二下就不认了', async () => {
    const h = harness()
    try {
      const token = tokenFrom(await magicLink(h, 'luoye@example.com'))
      expect((await h.raw(`${LOGIN_PATH}?token=${token}`)).status).toBe(200)
      const again = await h.raw(`${LOGIN_PATH}?token=${token}`)
      expect(again.status).toBe(401)
      expect(again.text).toContain('用不了了')
    } finally {
      await h.close()
    }
  })

  it('过期 / 用过 / 根本不存在合成同一句话（不给探测口）', async () => {
    const h = harness()
    try {
      const never = await h.raw(`${LOGIN_PATH}?token=cml_从来没签发过这一条`)
      const token = tokenFrom(await magicLink(h, 'a@example.com'))
      h.clock.advance(16 * 60 * 1000)
      const expired = await h.raw(`${LOGIN_PATH}?token=${token}`)
      expect(never.status).toBe(401)
      expect(expired.status).toBe(401)
      expect(expired.text).toBe(never.text)
    } finally {
      await h.close()
    }
  })

  it('地址里没有 token → 400 + 一句人话，不是空白页也不是崩溃', async () => {
    const h = harness()
    try {
      const page = await h.raw(LOGIN_PATH)
      expect(page.status).toBe(400)
      expect(page.text).toContain('不完整')
    } finally {
      await h.close()
    }
  })
})

describe('WP110 首页', () => {
  it('一页说明 + 状态；内联六块标记，不引任何外部资源', async () => {
    const h = harness()
    try {
      const page = await h.raw('/')
      expect(page.status).toBe(200)
      expect(page.text).toContain('agentsws 云')
      expect(page.text).toContain('设置 → 账号与积分')
      expect(page.text.match(/<rect /g) ?? []).toHaveLength(6)
      expect(page.text).not.toMatch(/<script/i)
      expect(page.text).not.toMatch(/<link[^>]+href/i)
      expect(page.text).not.toMatch(/<img/i)
    } finally {
      await h.close()
    }
  })

  it('模块清单读的是活的那个对象：挂上之后首页当场就变', async () => {
    const h = harness()
    try {
      // 模块那一格的标签里有路由前缀；正文那句介绍里没有，所以拿前缀当判据
      expect((await h.raw('/')).text).not.toContain('/v1/data/kol')
      h.server.health.modules = { kol_public: true }
      expect((await h.raw('/')).text).toContain('/v1/data/kol')
    } finally {
      await h.close()
    }
  })
})

describe('WP110 /v1/cloud/health', () => {
  it('回版本、模块、上游可达性；一个密钥都不回', async () => {
    const h = harness()
    try {
      h.server.health.modules = { entry: true, standby: false }
      h.server.health.probeUpstream = async () => ({
        reachable: true,
        checked_at: h.clock.now(),
      })
      const res = await h.call('/v1/cloud/health')
      expect(res.status).toBe(200)
      const data = res.body.data as {
        status: string
        version: string
        modules: Record<string, boolean>
        newapi: { reachable: boolean }
      }
      expect(data.status).toBe('ok')
      expect(data.modules).toEqual({ entry: true, standby: false })
      expect(data.newapi.reachable).toBe(true)
      // 上游那一格只有通不通：地址端出去等于告诉扫描的人下一个目标在哪
      expect(JSON.stringify(data)).not.toContain('http')
    } finally {
      await h.close()
    }
  })

  it('探针自己炸了 → unknown，不是 500，也不假装它是通的', async () => {
    const h = harness()
    try {
      h.server.health.probeUpstream = () => {
        throw new Error('boom')
      }
      const res = await h.call('/v1/cloud/health')
      expect(res.status).toBe(200)
      expect((res.body.data as { newapi: { reachable: string } }).newapi.reachable).toBe('unknown')
    } finally {
      await h.close()
    }
  })
})
