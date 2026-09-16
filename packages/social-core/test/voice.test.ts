import { describe, expect, it } from 'vitest'
import { checkOutbound, resolveVoice, type VoiceCard, voicePrompt } from '../src/index.js'

const org: VoiceCard = {
  id: 'voice_org',
  scope: 'org',
  guidance: '像同事说话，不用感叹号堆情绪。',
}
const discord: VoiceCard = {
  id: 'voice_discord',
  scope: 'channel',
  channel: 'discord',
  guidance: '群里随意一点，可以用表情，但别刷屏。',
  banned_terms: ['家人们'],
}

describe('56 §3 品牌话术：只取公司层技能，不编（WP72）', () => {
  it('渠道那张优先；**不合并两张**（合并等于我们编了第三份没人写过的话术）', () => {
    const r = resolveVoice([org, discord], 'discord')
    expect(r.card?.id).toBe('voice_discord')
    expect(voicePrompt(r)).toContain('群里随意一点')
    expect(voicePrompt(r)).not.toContain('像同事说话')
  })

  it('没有渠道那张就用公司那张，并说清楚用的是哪一张', () => {
    const r = resolveVoice([org, discord], 'meta')
    expect(r.card?.id).toBe('voice_org')
    expect(r.note).toContain('公司层')
  })

  it('一张都没有就说没有，不给一段我们编的默认语气', () => {
    const r = resolveVoice([], 'meta')
    expect(r.card).toBeUndefined()
    expect(voicePrompt(r)).toContain('还没写过话术卡')
    expect(voicePrompt(r)).not.toContain('【品牌话术｜')
  })

  it('禁用词进指导（人写的那几个，原样）', () => {
    expect(voicePrompt(resolveVoice([discord], 'discord'))).toContain('家人们')
  })

  it('出站承诺扫描用的是全仓那一份（support-core 的门三），不在这里另写一张词表', () => {
    const bad = checkOutbound('放心，我们会给你全额退款的。')
    expect(bad.ok).toBe(false)
    expect(bad.commitment_hits.length).toBeGreaterThan(0)
    expect(bad.rewrite_instruction).toContain('别在群里许诺')
  })

  it('干净的文案放行', () => {
    expect(checkOutbound('这一批的发货时间我去问一下，问到了回你。').ok).toBe(true)
  })

  it('品牌禁用词也拦，而且说清楚是哪个词', () => {
    const r = checkOutbound('家人们冲鸭', { banned_terms: ['家人们'] })
    expect(r.ok).toBe(false)
    expect(r.banned_hits).toEqual(['家人们'])
  })
})
