/**
 * WP382（决策 1061，Luoye 10-17）：中文界面里指「我的助理 / 替我答同事」的「代理」统一叫「助理」。
 * 网络义的「代理」（fake-IP、检查网络或代理）不改——两边都钉住，免得以后一刀切。
 */
import { describe, expect, it } from 'vitest'
import { translate } from '../src/lib/i18n'

const ASSISTANT_KEYS = [
  'nav.secretary',
  'secretary.title',
  'secretary.intro',
  'secretary.tab.ask',
  'secretary.ask.who',
  'secretary.route.title',
  'secretary.route.submit',
  'secretary.profile.contact.secretary',
  'secretary.meets.alternatives',
  'secretary.meet.submit',
  'people.ask',
  'im.intro',
  'im.intro.hint',
  'im.wechat.line',
  'im.wechat.terms.short',
  'im.wechat.what',
  'im.wechat.terms',
  'im.wecom.what',
]

const NETWORK_PROXY_KEYS = [
  'connections.egress.fake_ip',
  'onboarding.ai.own.err.timeout',
  'platform_cli.error.network',
]

describe('WP382：中文「代理」→「助理」', () => {
  it('助理那一组都叫「助理」，不再出现「代理」', () => {
    for (const key of ASSISTANT_KEYS) {
      const zh = translate('zh', key)
      expect(zh, key).not.toBe(key)
      expect(zh, key).toContain('助理')
      expect(zh, key).not.toContain('代理')
    }
    expect(translate('zh', 'secretary.route.question', { role: '售后' })).toContain('助理不答')
  })

  it('网络义的「代理」原样保留', () => {
    for (const key of NETWORK_PROXY_KEYS) {
      expect(translate('zh', key), key).toContain('代理')
    }
  })
})
