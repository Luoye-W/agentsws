import { describe, expect, it } from 'vitest'
import { EXTENSION_SCOPES } from '../src/extension-store.js'
import { platformsAllowed } from '../src/routes/extension-actions.js'

describe('WP329：插件领活按令牌上的 scope 筛平台', () => {
  it('新令牌有 reddit.write', () => {
    expect(EXTENSION_SCOPES).toContain('reddit.write')
  })

  it('只有 ads.act 的老令牌领不到 Reddit 的活；只有 reddit.write 的领不到广告的', () => {
    expect(platformsAllowed({ scopes: ['ads.act'] }, ['google_ads', 'reddit'])).toEqual([
      'google_ads',
    ])
    expect(platformsAllowed({ scopes: ['reddit.write'] }, ['meta_ads', 'reddit'])).toEqual([
      'reddit',
    ])
    expect(platformsAllowed({ scopes: ['kol.read'] }, ['reddit'])).toEqual([])
  })
})
