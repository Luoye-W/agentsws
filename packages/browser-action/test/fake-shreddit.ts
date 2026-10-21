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
  domFill,
  domFindPosted,
  domLook,
  domText,
  resolveOne,
} from '../src/index.js'

export interface FakeShredditState {
  brokenReply: boolean
  sent: { fullname: string; text: string; parent: string }[]
  next: number
}

export const fakeShredditState = (patch: Partial<FakeShredditState> = {}): FakeShredditState => ({
  brokenReply: false,
  sent: [],
  next: 1,
  ...patch,
})

const comment = (
  id: string,
  author: string,
  text: string,
  parent: string,
  depth: number,
  broken = false,
): string =>
  `<shreddit-comment thingid="t1_${id}" author="${author}" parentid="${parent}" depth="${depth}" permalink="/r/ivraxr/comments/abc/comment/${id}/">
     <div slot="comment"><p>${text}</p></div>
     <shreddit-comment-action-row slot="actionRow">${
       broken
         ? '<button class="new-reply">Reply</button>'
         : '<button slot="comment-reply">Reply</button>'
}</shreddit-comment-action-row>
   </shreddit-comment>`

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
       <comment-composer-host><faceplate-textarea-input data-testid="trigger-button" placeholder="Join the conversation"></faceplate-textarea-input></comment-composer-host>
       <shreddit-comment-tree>${top}${comment('c1', 'alice', 'Mine fogs up a bit', 't3_abc', 0, s.brokenReply)}${kids}</shreddit-comment-tree>`,
    )
  }

  private load(url: string): void {
    this.current = url
    this.doc = new JSDOM(this.render(url), { url }).window.document
    // 标题框长在组件的 shadow root 里
    const title = this.doc.querySelector('faceplate-textarea-input[name="title"]')
    title?.attachShadow({ mode: 'open' }).append(this.doc.createElement('textarea'))
    // 点 Reply：那条评论里冒出一个富文本框
    this.doc
      .querySelector('shreddit-comment[thingid="t1_c1"] button[slot="comment-reply"]')
      ?.addEventListener('click', () => {
        this.doc
          .querySelector('shreddit-comment[thingid="t1_c1"]')
          ?.insertAdjacentHTML(
            'beforeend',
            '<shreddit-composer><div contenteditable="true" role="textbox"></div><button slot="submit-button">Comment</button></shreddit-composer>',
          )
      })
    // 点「Join the conversation」：展开顶层评论框
    this.doc
      .querySelector('comment-composer-host faceplate-textarea-input')
      ?.addEventListener('click', () => {
        this.doc
          .querySelector('comment-composer-host')
          ?.insertAdjacentHTML(
            'beforeend',
            '<shreddit-composer><div contenteditable="true" role="textbox"></div><button slot="submit-button">Comment</button></shreddit-composer>',
          )
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
    this.doc
      .querySelector('shreddit-comment[thingid="t1_c1"]')
      ?.insertAdjacentHTML(
        'beforeend',
        '<shreddit-composer><div contenteditable="true" role="textbox"></div></shreddit-composer>',
      )
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
    const inReply = box.closest('shreddit-comment') !== null
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
  async waitFor(selector: string): Promise<boolean> {
    return domCount(this.doc, selector) > 0
  }
  async click(selector: string) {
    this.clicks.push(selector)
    return domClick(this.doc, selector)
  }
  async fill(selector: string, value: string, options?: { highlight?: boolean }) {
    this.fills.push(selector)
    return domFill(this.doc, selector, value, options)
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
