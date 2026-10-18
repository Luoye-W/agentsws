/**
 * WP329：本地假 old.reddit（只在 jsdom 里，**不联网、不碰真站**）。网址用真站的样子写，没有任何请求会发出去。
 *
 * 只搭步骤表要的那几块：帖子页（帖子、顶层评论框、一条评论 + 它的 reply 链接、点了冒出来的回复框）、
 * 发帖页（标题、正文、submit）。「人点发送」由测试调 {@link FakeReddit.humanSend}（插件从来不点它）。
 */
import { JSDOM } from 'jsdom'
import {
  type ActionPage,
  domClick,
  domCount,
  domFill,
  domFindPosted,
  domLook,
  domText,
} from '../src/index.js'

export interface FakeRedditState {
  loggedIn: boolean
  locked: boolean
  /** 点发送时 Reddit 说太快了（不出新评论，页面顶上出一句）。 */
  rateLimited: boolean
  /** 页面上已经有一条和草稿一样的回复（不能把它认成刚发的）。 */
  duplicate?: string
  sent: { fullname: string; text: string; parent: string }[]
  next: number
}

export const fakeRedditState = (patch: Partial<FakeRedditState> = {}): FakeRedditState => ({
  loggedIn: true,
  locked: false,
  rateLimited: false,
  sent: [],
  next: 1,
  ...patch,
})

const page = (title: string, body: string, s: FakeRedditState, notice = ''): string =>
  `<!doctype html><html><head><title>${title}</title></head><body>${notice}${body}${
    s.loggedIn
      ? '<div class="side"><span class="user">u/ivra_official</span></div>'
      : '<div class="side"><form id="login_login-main"><input name="user"><input type="password" name="passwd"></form></div>'
  }</body></html>`

const comment = (id: string, author: string, text: string, permalink: string, child = ''): string =>
  `<div class="thing comment" id="thing_t1_${id}" data-fullname="t1_${id}" data-author="${author}" data-permalink="${permalink}">
    <div class="entry"><p class="tagline">${author}</p><form class="usertext"><div class="usertext-body"><div class="md"><p>${text}</p></div></div></form>
      <ul class="flat-list buttons"><li class="reply-button"><a href="javascript:void(0)">reply</a></li></ul></div>
    <div class="child">${child}</div></div>`

export class FakeReddit implements ActionPage {
  doc: Document = new JSDOM('').window.document
  current = 'about:blank'
  readonly visited: string[] = []
  readonly clicks: string[] = []
  notice = ''

  constructor(readonly state: FakeRedditState) {}

  private render(url: string): string {
    const u = new URL(url)
    const s = this.state
    const sub = u.pathname.match(/^\/r\/([^/]+)\//u)?.[1] ?? 'ivraxr'
    if (/\/submit\/?$/u.test(u.pathname))
      return page(
        `submit to r/${sub}`,
        `<form id="newlink"><div id="title-field"><textarea name="title"></textarea></div>
         <div id="text-field"><textarea name="text"></textarea></div><button name="submit" type="submit">submit</button></form>`,
        s,
        this.notice,
      )
    const posted = u.pathname.match(/^\/r\/[^/]+\/comments\/(new\d+)\//u)
    if (posted !== null) {
      const mine = s.sent.find((x) => x.fullname === `t3_${posted[1]}`)
      return page(
        mine?.text ?? 'post',
        `<div id="siteTable"><div class="thing link" id="thing_t3_${posted[1]}" data-fullname="t3_${posted[1]}" data-permalink="${u.pathname}">
          <div class="entry"><a class="title" href="${u.pathname}">${mine?.text ?? ''}</a></div></div></div>
         <div class="commentarea"></div>`,
        s,
      )
    }
    if (/^\/r\/[^/]+\/comments\/abc\//u.test(u.pathname) || u.pathname === '/comments/abc/') {
      const perm = (id: string) => `/r/${sub}/comments/abc/slug/${id}/`
      const dup =
        s.duplicate === undefined
          ? ''
          : `<div class="sitetable">${comment('old9', 'ivra_official', s.duplicate, perm('old9'))}</div>`
      const replies = s.sent
        .filter((x) => x.parent === 't1_c1')
        .map((x) =>
          comment(x.fullname.slice(3), 'ivra_official', x.text, perm(x.fullname.slice(3))),
        )
        .join('')
      const top = s.sent
        .filter((x) => x.parent === 't3_abc')
        .map((x) =>
          comment(x.fullname.slice(3), 'ivra_official', x.text, perm(x.fullname.slice(3))),
        )
        .join('')
      const box = s.locked
        ? '<p class="locked">locked</p>'
        : '<form class="usertext"><textarea name="text"></textarea><button class="save" type="submit">save</button></form>'
      return page(
        'Does the Air3 work with glasses?',
        `<div id="siteTable"><div class="thing link" id="thing_t3_abc" data-fullname="t3_abc" data-permalink="/r/${sub}/comments/abc/slug/">
           <div class="entry"><a class="title">Does the Air3 work with glasses?</a></div></div></div>
         <div class="commentarea">${box}<div class="sitetable nestedlisting">${top}${comment(
           'c1',
           'alice',
           'Mine fogs up a bit',
           perm('c1'),
           `${dup}${replies === '' ? '' : `<div class="sitetable">${replies}</div>`}`,
         )}</div></div>`,
        s,
        this.notice,
      )
    }
    return page('page not found', '<p>not found</p>', s)
  }

  private load(url: string): void {
    this.current = url
    this.doc = new JSDOM(this.render(url), { url }).window.document
    // 点 reply：在这条评论下面冒出一个回复框（old.reddit 是把顶层那个框克隆一份过来）
    this.doc
      .querySelector('#thing_t1_c1 > .entry .reply-button > a')
      ?.addEventListener('click', () => {
        const child = this.doc.querySelector('#thing_t1_c1 > .child')
        child?.insertAdjacentHTML(
          'afterbegin',
          '<form class="usertext"><textarea name="text"></textarea><button class="save" type="submit">save</button></form>',
        )
      })
  }

  /** 测试里的「人」：在页面上点发送。回发没发出去。 */
  humanSend(): boolean {
    const s = this.state
    const id = `new${s.next}`
    if (s.rateLimited) {
      this.notice = '<div class="error">you are doing that too much. try again in 9 minutes.</div>'
      this.load(this.current)
      return false
    }
    const title = this.doc.querySelector<HTMLTextAreaElement>('#title-field textarea')
    if (title !== null) {
      s.next += 1
      s.sent.push({ fullname: `t3_${id}`, text: title.value, parent: 'r/ivraxr' })
      this.load(new URL(`/r/ivraxr/comments/${id}/title/`, this.current).href)
      return true
    }
    const reply = this.doc.querySelector<HTMLTextAreaElement>(
      '#thing_t1_c1 > .child > form textarea',
    )
    const top = this.doc.querySelector<HTMLTextAreaElement>('.commentarea > form textarea')
    const box = reply ?? top
    if (box === null || box.value === '') return false
    s.next += 1
    s.sent.push({
      fullname: `t1_${id}`,
      text: box.value,
      parent: reply === null ? 't3_abc' : 't1_c1',
    })
    this.load(this.current)
    return true
  }

  async url(): Promise<string> {
    return this.current
  }
  async goto(url: string): Promise<{ finalUrl: string }> {
    this.visited.push(url)
    this.load(url)
    return { finalUrl: this.current }
  }
  async look() {
    return domLook(this.doc, this.current)
  }
  async waitFor(selector: string): Promise<boolean> {
    return domCount(this.doc, selector) > 0
  }
  async click(selector: string) {
    this.clicks.push(selector)
    return domClick(this.doc, selector)
  }
  async fill(selector: string, value: string) {
    return domFill(this.doc, selector, value)
  }
  async setFile() {
    return { ok: false as const, why: 'Reddit 没有上传' }
  }
  async paste() {
    return { ok: false as const, why: 'Reddit 没有粘贴' }
  }
  async text(selector: string) {
    return domText(this.doc, selector)
  }
  async count(selector: string) {
    return domCount(this.doc, selector)
  }
  async capture() {
    return { ok: false as const, why: '不截图' }
  }
  async download() {
    return { ok: false as const, why: '不下载' }
  }
  async findPosted(selector: string, body: string, text: string) {
    return domFindPosted(this.doc, selector, body, text)
  }
}
