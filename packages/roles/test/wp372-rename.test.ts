/**
 * WP372（决策 1003，Luoye 10-17）：两条 Reddit 职责只改显示名，id 不动。
 * 社媒 `social.reddit`「自家版运营」→「官方版块」（Official Subreddit）；
 * 公共关系 `pr.reddit`「Reddit 营销」→「外部版块」（Other Subreddits）。提示词「你是谁」与互指同步改。
 */
import { PR_ROLES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { loadBundledRole } from '../src/index.js'

describe('WP372 两条 Reddit 职责改名', () => {
  it('显示名换了、id 没换；中文提示词自称新名字、互指对方的新名字', () => {
    const own = loadBundledRole('social.reddit')
    const ext = loadBundledRole('pr.reddit')
    expect(own.name).toEqual({ zh: '官方版块', en: 'Official Subreddit' })
    expect(ext.name).toEqual({ zh: '外部版块', en: 'Other Subreddits' })
    expect(own.persona?.zh).toContain('你是谁：官方版块')
    expect(own.persona?.zh).toContain('公共关系的外部版块')
    expect(ext.persona?.zh).toContain('你是谁：外部版块')
    expect(ext.persona?.zh).toContain('社媒运营的官方版块')
    for (const text of [own.persona?.zh ?? '', ext.persona?.zh ?? '', ext.description])
      expect(text).not.toMatch(/自家版运营|Reddit 营销/)
  })

  it('英文 persona 跟着新中文重出（哈希对得上才会补进来）', () => {
    expect(loadBundledRole('social.reddit').persona?.en).toContain('Official Subreddit')
    expect(loadBundledRole('pr.reddit').persona?.en).toContain('Other Subreddits')
  })

  it('契约里那张公关职责表同步', () => {
    expect(PR_ROLES.find((r) => r.role_id === 'pr.reddit')).toMatchObject({
      zh: '外部版块',
      en: 'Other Subreddits',
    })
  })
})
