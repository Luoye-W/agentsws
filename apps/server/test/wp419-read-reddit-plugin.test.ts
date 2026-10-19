/**
 * WP419（主会话 Mac 自测）：`read_reddit` 前两路（工坊云端、内置浏览器）都不行 → 借用户 Chrome 里的插件现读一次；
 * 插件也不行 → 照实说「读不了 Reddit，装插件」、叮嘱不去第三方镜像 / 统计站凑。插件那一跳是替身，不连 Reddit。
 */
import { DEFAULT_REDDIT_BROWSER_READ_LIMITS, type RunRequest } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createResearchToolExecutor, pluginReadOf } from '../src/research-tools.js'

const run = { id: 'run_1' } as RunRequest
const exec = (pluginRead?: Parameters<typeof createResearchToolExecutor>[0]['pluginRead']) =>
  createResearchToolExecutor({
    route: () => ({ order: ['workshop', 'browser_readonly'], disabled: [] }),
    limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    nowMs: () => Date.parse('2026-10-19T10:00:00.000Z'),
    ...(pluginRead === undefined ? {} : { pluginRead }),
  })

describe('WP419 read_reddit 第三路：插件', () => {
  it('前两路都没配 → 插件读回来，照常交回、来源标插件', async () => {
    const pluginRead = vi.fn(async () => ({
      ok: true as const,
      parts: [
        {
          ok: true,
          items: [
            {
              name: 't3_p1',
              kind: 'post' as const,
              author: 'alice',
              subreddit: 'ivraxr',
              title: 'Battery after 2.1?',
              text: 'drains fast',
              url: 'https://www.reddit.com/r/ivraxr/comments/p1/x/',
              created_utc: 1_760_000_000,
            },
          ],
        },
      ],
    }))
    const res = await exec(pluginRead)({
      name: 'read_reddit',
      input: { query: 'IVRA battery' },
      request: run,
    })
    expect(pluginRead).toHaveBeenCalledWith([
      { key: 'adhoc:search', kind: 'search', query: 'IVRA battery', time: 'month', max_pages: 1 },
    ])
    const data = res.data as {
      rows: number
      items: { title?: string }[]
      source: { route: string }
    }
    expect(data.rows).toBe(1)
    expect(data.items[0]?.title).toBe('Battery after 2.1?')
    expect(data.source.route).toBe('extension')
  })
  it('插件也不行 → 照实说读不了、装插件、不找第三方站', async () => {
    const res = await exec(async () => ({ ok: false, why: '插件还没配对' }))({
      name: 'read_reddit',
      input: { subreddit: 'ivraxr' },
      request: run,
    })
    const missing = (res.data as { missing: string }).missing
    expect(missing).toContain('读不了 Reddit')
    expect(missing).toContain('插件还没配对')
    expect(missing).toContain('不要')
    expect(missing).toContain('Agents 工坊助手')
  })
  it('没接插件那一路也照实说', async () => {
    const res = await exec()({ name: 'read_reddit', input: { subreddit: 'ivraxr' }, request: run })
    expect((res.data as { missing: string }).missing).toContain('没有连着的「Agents 工坊助手」插件')
  })
  it('三种读法换成插件读法', () => {
    expect(
      pluginReadOf({ capability: 'social.reddit.posts', input: { subreddit: 'r/ivraxr' } }),
    ).toMatchObject({ kind: 'sub_new', subreddit: 'ivraxr' })
    expect(
      pluginReadOf({
        capability: 'social.reddit.comments',
        input: { post_url: 'https://www.reddit.com/r/ivraxr/comments/Abc12/x/' },
      }),
    ).toMatchObject({ kind: 'post_comments', post_id: 'abc12' })
    expect(pluginReadOf({ capability: 'social.reddit.search', input: {} })).toBeUndefined()
  })
})
