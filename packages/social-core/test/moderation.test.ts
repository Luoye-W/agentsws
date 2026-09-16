import { describe, expect, it } from 'vitest'
import { type CommunityRule, escalate, moderate } from '../src/index.js'

const rules: CommunityRule[] = [
  {
    id: 'r_links',
    text: '群里不发外部推广链接',
    terms: ['bit.ly/', 't.me/', '点击链接'],
    action: 'delete_post',
    escalate_after: 2,
  },
  {
    id: 'r_abuse',
    text: '不许人身攻击',
    terms: ['傻逼', 'idiot'],
    action: 'mute',
  },
  {
    id: 'r_scam',
    text: '不许发诈骗信息',
    terms: ['免费领 usdt', 'send me crypto'],
    action: 'ban',
  },
]

describe('56 §3 群规匹配与分级（WP72）', () => {
  it('没违反就是没违反（不是"暂时没发现"）', () => {
    const v = moderate({ text: '这个充电器挺好用的', rules })
    expect(v.action).toBe('none')
    expect(v.matched_rules).toEqual([])
    expect(v.needs_approval).toBe(false)
  })

  it('命中一条：说清楚违的是哪一条群规（原文是人写的那句）', () => {
    const v = moderate({ text: '大家点击链接看看 https://bit.ly/x', rules })
    expect(v.action).toBe('delete_post')
    expect(v.matched_rules.map((m) => m.id)).toEqual(['r_links'])
    expect(v.reason).toContain('群里不发外部推广链接')
    expect(v.needs_approval).toBe(false)
  })

  it('同时违好几条：按最重的那一条办', () => {
    const v = moderate({ text: '点击链接，idiot', rules })
    expect(v.matched_rules).toHaveLength(2)
    expect(v.action).toBe('mute')
  })

  it('封禁要人点——把一个人永久赶出去这件事不自动', () => {
    const v = moderate({ text: 'send me crypto and i double it', rules })
    expect(v.action).toBe('ban')
    expect(v.needs_approval).toBe(true)
    expect(v.reason).toContain('要你点头')
  })

  it('累犯才升级：第一次删帖，第三次才禁言', () => {
    const first = moderate({ text: '点击链接', rules, prior_offenses: 0 })
    expect(first.action).toBe('delete_post')
    const third = moderate({ text: '点击链接', rules, prior_offenses: 2 })
    expect(third.action).toBe('mute')
    const many = moderate({ text: '点击链接', rules, prior_offenses: 4 })
    expect(many.action).toBe('ban')
    expect(many.needs_approval).toBe(true)
  })

  it('梯子封顶在 ban：永久封禁只能人手工选，不会"次数够了"自动走到', () => {
    expect(escalate('delete_post', 100, 1)).toBe('ban')
    expect(escalate('warn', 100, 1)).toBe('ban')
    // 不配 escalate_after 就不升级
    expect(escalate('delete_post', 100, undefined)).toBe('delete_post')
  })

  it('大小写不敏感（词表是人写的，别让人去管大小写）', () => {
    expect(moderate({ text: 'IDIOT', rules }).action).toBe('mute')
  })
})
