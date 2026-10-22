/**
 * WP432：本地假**新版** Reddit（shreddit 组件的样子；只在 jsdom 里，**不联网、不碰真站**）。
 *
 * 只搭步骤表要的那几块：帖子页（帖子、收起的「Join the conversation」、一条评论 + 它的 Reply、点了冒出来的
 * 富文本框）、发帖页（标题框在组件的 shadow root 里、正文是富文本框）。「人」改字、点发送由测试调
 * {@link FakeShreddit.humanType} / {@link FakeShreddit.humanSend}（插件从来不点发送）。
 * `brokenReply` = 页面改版了、认不出 Reply（看插件是不是停在「等你粘贴」、不乱点）。
 */
import { JSDOM } from 'jsdom'
import {
  type ActionPage,
  domClick,
  domCount,
  domFillAsync,
  domFindPosted,
  domLook,
  domText,
  redditPostIdOf,
  resolveAll,
  resolveOne,
} from '../src/index.js'

export interface FakeShredditState {
  brokenReply: boolean
  /** 按钮行滚到眼前才长出来（真站如此；`false` = 一打开就有）。 */
  lazyRows?: boolean
  sent: { fullname: string; text: string; parent: string }[]
  next: number
}

export const fakeShredditState = (patch: Partial<FakeShredditState> = {}): FakeShredditState => ({
  brokenReply: false,
  sent: [],
  next: 1,
  ...patch,
})

/**
 * 一条评论，照真站 10-22 的样子：正文与按钮行包在 `details` 里（不是直接孩子）；按钮行一开始是个空 div，
 * **滚到眼前才长出来**（{@link FakeShreddit.hydrate}）。
 */
const comment = (id: string, author: string, text: string, parent: string, depth: number): string =>
  `<shreddit-comment thingid="t1_${id}" author="${author}" parentid="${parent}" depth="${depth}" postid="t3_abc" permalink="/r/ivraxr/comments/abc/comment/${id}/">
     <details open><summary></summary><div>
       <div slot="commentMeta">${author}</div>
       <div slot="comment" id="t1_${id}-comment-rtjson-content"><p>${text}</p></div>
       <div slot="actionRow" data-for="t1_${id}"></div>
     </div></details>
   </shreddit-comment>`

/** 按钮行长出来之后的样子（Reply 在 `faceplate-tracker[slot=comment-reply]` 里）。 */
const actionRow = (t1: string, broken: boolean): string =>
  `<shreddit-comment-action-row slot="actionRow" comment-id="${t1}">${
    broken
      ? '<button class="new-reply">Reply</button>'
      : '<faceplate-tracker slot="comment-reply" noun="reply_comment"><button>Reply</button></faceplate-tracker>'
  }<template slot="comment-composer-template"></template></shreddit-comment-action-row>`

/** 一个编辑框（照真站：Lexical 编辑器 + Cancel / Comment；`parent` 给了就是回评论那一种）。 */
const composer = (parent?: string): string =>
  `<shreddit-async-loader slot="comment-composer"><comment-composer-host${
    parent === undefined ? '' : ` parent-id="${parent}" reply-mode`
  }><faceplate-form><shreddit-composer name="content"><div slot="rte" contenteditable="true" role="textbox"></div><button slot="cancel-button" type="reset">Cancel</button><button slot="submit-button" type="submit">Comment</button></shreddit-composer></faceplate-form></comment-composer-host></shreddit-async-loader>`

export class FakeShreddit implements ActionPage {
  doc: Document = new JSDOM('').window.document
  current = 'about:blank'
  readonly visited: string[] = []
  readonly clicks: string[] = []
  readonly fills: string[] = []

  constructor(readonly state: FakeShredditState) {}

  private render(url: string): string {
    const u = new URL(url)
    const s = this.state
    const shell = (title: string, body: string) =>
      `<!doctype html><html><head><title>${title}</title></head><body><shreddit-app>${body}</shreddit-app></body></html>`
    if (/\/submit\/?$/u.test(u.pathname))
      return shell(
        'Submit to r/ivraxr',
        `<faceplate-textarea-input name="title"></faceplate-textarea-input>
         <shreddit-composer name="body"><div contenteditable="true" role="textbox"></div></shreddit-composer>`,
      )
    const posted = u.pathname.match(/\/comments\/(new\d+)\//u)
    if (posted !== null) {
      const mine = s.sent.find((x) => x.fullname === `t3_${posted[1]}`)
      return shell(
        mine?.text ?? 'post',
        `<shreddit-post id="t3_${posted[1]}" author="ivra_official" permalink="${u.pathname}"><h1 slot="title">${mine?.text ?? ''}</h1></shreddit-post>`,
      )
    }
    const kids = s.sent
      .filter((x) => x.parent === 't1_c1')
      .map((x) => comment(x.fullname.slice(3), 'ivra_official', x.text, 't1_c1', 1))
      .join('')
    const top = s.sent
      .filter((x) => x.parent === 't3_abc')
      .map((x) => comment(x.fullname.slice(3), 'ivra_official', x.text, 't3_abc', 0))
      .join('')
    return shell(
      'Does the Air3 work with glasses? : r/ivraxr',
      `<shreddit-post id="t3_abc" author="carol" permalink="/r/ivraxr/comments/abc/slug/"><h1 slot="title">Does the Air3 work with glasses?</h1></shreddit-post>
       <comment-body-header><shreddit-async-loader><comment-composer-host post-id="t3_abc"><faceplate-textarea-input data-testid="trigger-button" placeholder="Join the conversation"></faceplate-textarea-input></comment-composer-host></shreddit-async-loader></comment-body-header>
       <shreddit-comment-tree>${top}${comment('c1', 'alice', 'Mine fogs up a bit', 't3_abc', 0)}${kids}</shreddit-comment-tree>`,
    )
  }

  private load(url: string): void {
    this.current = url
    this.doc = new JSDOM(this.render(url), { url }).window.document
    // 标题框长在组件的 shadow root 里
    const title = this.doc.querySelector('faceplate-textarea-input[name="title"]')
    title?.attachShadow({ mode: 'open' }).append(this.doc.createElement('textarea'))
    // 「Join the conversation」：组件的 shadow root 里一个 textarea，**聚焦它**才展开顶层评论框（真站就是这样）
    const trigger = this.doc.querySelector(
      'comment-composer-host:not([parent-id]) faceplate-textarea-input[data-testid="trigger-button"]',
    )
    const inner = this.doc.createElement('textarea')
    trigger?.attachShadow({ mode: 'open' }).append(inner)
    inner.addEventListener('focus', () => {
      const host = this.doc.querySelector('comment-composer-host:not([parent-id])')
      if (host !== null && host.querySelector('shreddit-composer') === null)
        host.insertAdjacentHTML(
          'beforeend',
          composer().replace(/^<shreddit-async-loader[^>]*>|<\/shreddit-async-loader>$/gu, ''),
        )
    })
    if (this.state.lazyRows === false) for (const id of ['t1_c1']) this.hydrate(id)
  }

  /** 那条评论滚到眼前了：按钮行长出来（点 Reply 在按钮行里冒出回复框）。 */
  hydrate(t1: string): void {
    const slot = this.doc.querySelector(`div[slot="actionRow"][data-for="${t1}"]`)
    if (slot === null || slot.querySelector('shreddit-comment-action-row') !== null) return
    slot.insertAdjacentHTML('beforeend', actionRow(t1, this.state.brokenReply))
    const row = slot.querySelector('shreddit-comment-action-row')
    row?.querySelector('[slot="comment-reply"] button')?.addEventListener('click', () => {
      if (row.querySelector('shreddit-composer') === null)
        row.insertAdjacentHTML('beforeend', composer(t1))
    })
  }

  /** 正在编辑的那个框（回复框优先）。 */
  private box(): HTMLElement | null {
    return this.doc.querySelector<HTMLElement>('shreddit-composer div[contenteditable="true"]')
  }

  /** 测试里的「人」：在框里把字改成这样（插件填的被人改了，或者认不出框时人自己粘贴的）。 */
  humanType(text: string): void {
    const title = resolveOne(this.doc, 'faceplate-textarea-input[name="title"] >>> textarea') as
      | HTMLTextAreaElement
      | undefined
    if (title !== undefined && title.value === '') title.value = text
    else {
      this.ensureReplyBox()
      const box = this.box()
      if (box !== null) box.textContent = text
    }
  }

  /** 认不出 Reply 时，「人」自己点开那个框。 */
  private ensureReplyBox(): void {
    if (this.box() !== null) return
    this.hydrate('t1_c1')
    this.doc
      .querySelector('shreddit-comment-action-row[comment-id="t1_c1"]')
      ?.insertAdjacentHTML('beforeend', composer('t1_c1'))
  }

  /** 测试里的「人」：点发送。回发没发出去。 */
  humanSend(): boolean {
    const s = this.state
    const id = `new${s.next}`
    const title = resolveOne(this.doc, 'faceplate-textarea-input[name="title"] >>> textarea') as
      | HTMLTextAreaElement
      | undefined
    if (title !== undefined) {
      s.next += 1
      s.sent.push({ fullname: `t3_${id}`, text: title.value, parent: 'r/ivraxr' })
      this.load(new URL(`/r/ivraxr/comments/${id}/title/`, this.current).href)
      return true
    }
    const box = this.box()
    const text = box?.textContent?.trim() ?? ''
    if (box === null || text === '') return false
    const inReply = box.closest('comment-composer-host[parent-id]') !== null
    s.next += 1
    s.sent.push({ fullname: `t1_${id}`, text, parent: inReply ? 't1_c1' : 't3_abc' })
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
  readonly revealed: string[] = []
  /** 停在原页上（不跳转）几次。 */
  stays = 0
  async waitFor(selector: string, _ms?: number, options?: { reveal?: string }): Promise<boolean> {
    if (options?.reveal !== undefined) {
      const el = resolveAll(this.doc, options.reveal)[0]
      const t1 = el?.getAttribute('thingid')
      if (t1 !== null && t1 !== undefined) {
        this.revealed.push(t1)
        this.hydrate(t1)
      }
    }
    return domCount(this.doc, selector) > 0
  }
  async stay(post: string, need?: string): Promise<boolean> {
    if (redditPostIdOf(this.current) !== post) return false
    if (need !== undefined && domCount(this.doc, need) === 0) return false
    this.stays += 1
    return true
  }
  async click(selector: string) {
    this.clicks.push(selector)
    return domClick(this.doc, selector)
  }
  async fill(selector: string, value: string, options?: { highlight?: boolean }) {
    this.fills.push(selector)
    return domFillAsync(this.doc, selector, value, options)
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
  async findPosted(selector: string, body: string, text: string, author?: string) {
    return domFindPosted(this.doc, selector, body, text, author)
  }
}
