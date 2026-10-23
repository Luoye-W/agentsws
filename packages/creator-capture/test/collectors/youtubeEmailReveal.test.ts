/** 移植自 agentsws-extension `test/contents/youtubeEmailReveal.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * WP490（决策 1710 = C）：过完人机验证后弹出来的那个商务邮箱——窄读法。
 *
 * 正例只有一种：一个自报是商务邮箱的对话框里、恰好一个、不是登录用户自己的邮箱。
 * 反例钉的是「用户自己的邮箱绝不能被当成红人的报上去」那几种样子。
 */
import { describe, expect, it } from 'vitest'

import { readVerifiedBusinessEmail } from '../../src/collectors/youtubeEmailReveal.js'
import { publicContactsOfProfile } from '../../src/wire/publicContacts.js'
import { parseHTML } from '../helpers/dom'

/** 页头里登录用户自己的邮箱（头像按钮的 aria-label + 账号菜单里的那一行）。 */
const MASTHEAD = `
  <ytd-masthead id="masthead">
    <button id="avatar-btn" aria-label="Account menu: me.myself@gmail.example"></button>
  </ytd-masthead>
  <ytd-popup-container>
    <tp-yt-iron-dropdown>
      <ytd-multi-page-menu-renderer>
        <ytd-active-account-header-renderer>
          <span id="account-name">Me</span><span id="email">me.myself@gmail.example</span>
        </ytd-active-account-header-renderer>
        <span>Switch account</span><span>Sign out</span>
      </ytd-multi-page-menu-renderer>
    </tp-yt-iron-dropdown>
  </ytd-popup-container>`

const REVEAL = (email: string) => `
  <tp-yt-paper-dialog>
    <h2>For business inquiries</h2>
    <p>Email address: <a href="mailto:${email}">${email}</a></p>
  </tp-yt-paper-dialog>`

const read = (html: string) => readVerifiedBusinessEmail(parseHTML(`<body>${html}</body>`).document)

describe('readVerifiedBusinessEmail', () => {
  it('弹窗自报是商务邮箱、里面恰好一个：读出来（小写）', () => {
    expect(read(REVEAL('Deals@Creator.Example'))).toBe('deals@creator.example')
    expect(
      read(`<yt-dialog-view-model><div>查看电子邮件地址</div><div>biz@creator.example</div></yt-dialog-view-model>`),
    ).toBe('biz@creator.example')
  })

  it('页头 / 账号菜单里有登录用户自己的邮箱：只报弹窗里红人的那个，自己的绝不报', () => {
    const out = read(MASTHEAD + REVEAL('deals@creator.example'))
    expect(out).toBe('deals@creator.example')
    expect(out).not.toContain('me.myself')
  })

  it('反例：登录用户自己的邮箱出现在一个「像」商务弹窗的对话框里——也不报', () => {
    expect(read(MASTHEAD + REVEAL('me.myself@gmail.example'))).toBe(undefined)
  })

  it('反例：只有页头 / 账号菜单里有邮箱（用户自己的）——什么都不报', () => {
    expect(read(MASTHEAD)).toBe(undefined)
  })

  it('反例：账号菜单 / 账号验证做成了对话框——不报', () => {
    expect(
      read(`<tp-yt-paper-dialog><p>Google Account</p><p>Email address</p><p>me@gmail.example</p><p>Sign out</p></tp-yt-paper-dialog>`),
    ).toBe(undefined)
    expect(
      read(`<tp-yt-paper-dialog><ytd-multi-page-menu-renderer>Email address me@gmail.example</ytd-multi-page-menu-renderer></tp-yt-paper-dialog>`),
    ).toBe(undefined)
    expect(
      read(`<tp-yt-iron-dropdown><tp-yt-paper-dialog>${REVEAL('x@creator.example')}</tp-yt-paper-dialog></tp-yt-iron-dropdown>`),
    ).toBe(undefined)
  })

  it('反例：没自报身份的对话框（分享 / 举报）、藏起来的、「关于」本身、两个邮箱、两个弹窗各一个不同的', () => {
    expect(read(`<tp-yt-paper-dialog><p>Share</p><p>friend@mail.example</p></tp-yt-paper-dialog>`)).toBe(undefined)
    expect(read(REVEAL('deals@creator.example').replace('<tp-yt-paper-dialog>', '<tp-yt-paper-dialog aria-hidden="true">'))).toBe(undefined)
    expect(
      read(`<tp-yt-paper-dialog><ytd-about-channel-renderer>For business inquiries a@creator.example</ytd-about-channel-renderer></tp-yt-paper-dialog>`),
    ).toBe(undefined)
    expect(
      read(`<tp-yt-paper-dialog>For business inquiries a@creator.example or b@creator.example</tp-yt-paper-dialog>`),
    ).toBe(undefined)
    expect(read(REVEAL('a@creator.example') + REVEAL('b@creator.example'))).toBe(undefined)
  })

  it('读到的那个按 YouTube 算商务入口（business），照样过 sanitizePublicContacts', () => {
    const email = read(MASTHEAD + REVEAL('Deals@Creator.Example'))
    expect(publicContactsOfProfile({ platform: 'youtube', businessEmail: email, links: [] })).toEqual([
      { kind: 'business', value: 'deals@creator.example' },
    ])
  })
})
