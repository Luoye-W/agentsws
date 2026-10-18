/**
 * WP419（主会话 Mac 自测：服务端抓 Reddit 全 403，模型绕去 redlib / subredditstats / postpone）：
 * 抓 Reddit 被拒 → 结果直接告诉模型走 read_reddit / 照实说装插件；抓第三方镜像 / 统计站 → 不抓，直接回那一句；别的站原样。
 */
import { describe, expect, it, vi } from 'vitest'
import { redditGuardFetch } from '../src/index.js'

const inner = (status: number) => {
  const fetch = vi.fn(async (req: { url: string }) => ({
    url: req.url,
    statusCode: status,
    body: { kind: 'text', content: 'page' },
    truncated: false,
  }))
  return { provider: { id: 'http', available: () => true, fetch } as never, fetch }
}
const content = (r: unknown) => (r as { body: { content: string } }).body.content

describe('WP419 抓 Reddit 的照实说', () => {
  it('Reddit 403 → 告诉模型用 read_reddit、别找镜像', async () => {
    const { provider } = inner(403)
    const g = redditGuardFetch(provider, true)
    const r = await g.fetch(
      { url: 'https://www.reddit.com/r/ivraxr/' } as never,
      undefined as never,
    )
    expect((r as { statusCode: number }).statusCode).toBe(403)
    expect(content(r)).toContain('Reddit 拦服务器直读（403）')
    expect(content(r)).toContain('read_reddit')
    expect(content(r)).toContain('不要换第三方镜像')
  })
  it('没有 read_reddit 的职责：照实说读不了', async () => {
    const g = redditGuardFetch(inner(403).provider, false)
    const r = await g.fetch({ url: 'https://old.reddit.com/r/x/' } as never, undefined as never)
    expect(content(r)).toContain('读不了 Reddit')
    expect(content(r)).not.toContain('用 read_reddit 工具')
  })
  it('第三方镜像 / 统计站：不抓，直接回那一句', async () => {
    const { provider, fetch } = inner(200)
    const g = redditGuardFetch(provider, true)
    for (const url of [
      'https://subredditstats.com/r/ivraxr',
      'https://redlib.example.org/r/ivraxr',
      'https://postpone.app/tools/subreddit-analysis',
    ]) {
      const r = await g.fetch({ url } as never, undefined as never)
      expect(content(r)).toContain('第三方镜像')
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('Reddit 读成了、别的站：原样', async () => {
    const ok = redditGuardFetch(inner(200).provider, true)
    expect(
      content(await ok.fetch({ url: 'https://www.reddit.com/r/x/' } as never, undefined as never)),
    ).toBe('page')
    const other = redditGuardFetch(inner(404).provider, true)
    expect(
      content(await other.fetch({ url: 'https://example.com/' } as never, undefined as never)),
    ).toBe('page')
  })
})
