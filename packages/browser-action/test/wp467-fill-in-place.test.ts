// @vitest-environment jsdom
/**
 * WP467（Luoye 10-22 Windows 真机）：Reddit「填入」就在原帖页里填——
 *
 * 1. 按帖子 id 认页面（各种网址形态）；
 * 2. 插件挑的标签页已经在这个帖子上就**不跳转、就地填**；回某条评论时那一条不在页面上就在同一页打开它的链接；
 * 3. 写路径里没有 old.reddit（一律 www）；评论按钮行滚到眼前才长出来（先滚再等）；框已经展开着就不再点 Reply；
 * 4. 富文本框（Lexical）按「粘贴」交给编辑器：换行成段、原来的字整段换掉；编辑器不认就照实说，不硬写；
 * 5. 人自己发出去的那一条怎么认：这个帖子里 + 文本相近 + 当前登录的号。
 */
import { describe, expect, it } from 'vitest'
import {
  buildRedditJob,
  checkPlanSteps,
  checkStep,
  detectPageWall,
  domFillAsync,
  domFindPosted,
  draftSimilarity,
  editorParagraphs,
  isNewRedditUrl,
  looksLikeSent,
  REDDIT_WRITE_SELECTORS_NEW,
  type RedditWriteAction,
  type RunHooks,
  redditCommentIdOf,
  redditPostIdOf,
  redditSentSelectors,
  redditWritePlan,
  resolveOne,
  runAction,
  sameRedditPost,
} from '../src/index.js'
import { FakeShreddit, fakeShredditState } from './fake-shreddit.js'

const DRAFT = 'Hi Alice, the Air3 fits over most prescription frames.'
const POST_URL = 'https://www.reddit.com/r/ivraxr/comments/abc/does_the_air3_work/'

const reply = (parent = 't1_c1'): RedditWriteAction => ({
  write: {
    kind: 'reply',
    parent,
    permalink: `/r/ivraxr/comments/abc/comment/${parent.slice(3)}/`,
  },
  text: DRAFT,
})
const comment: RedditWriteAction = {
  write: { kind: 'comment', post: 't3_abc', permalink: '/r/ivraxr/comments/abc/slug/' },
  text: 'Thanks for asking!\n\nIt works with most frames.',
}

function run(page: FakeShreddit, action: RedditWriteAction) {
  const hooks: RunHooks = {
    progress: async () => ({ stop: false }),
    // 填完就停（不等发送：这里只看怎么填）
    stopped: () => page.fills.length > 0,
    confirm: async () => 'yes',
    evidence: async () => {},
    downloaded: async () => {},
    sleep: async () => {},
    gapMs: 0,
    waitTimeoutMs: 0,
    sendPollMs: 1,
    sendTimeoutMs: 3,
  }
  return runAction(
    buildRedditJob({
      id: 'rdw_1',
      workspace_id: 'ws',
      account_id: 'ivra_official',
      action,
      approval_id: 'ap_1',
      created_at: '2026-10-22T00:00:00.000Z',
      author: 'ivra_official',
    }),
    page,
    hooks,
  )
}

describe('WP467 按帖子 id 认页面', () => {
  it('各种网址形态都认得出同一个帖子', () => {
    for (const url of [
      'https://www.reddit.com/r/ivraxr/comments/abc123/some_title/',
      'https://www.reddit.com/r/ivraxr/comments/abc123/some_title',
      'https://www.reddit.com/r/ivraxr/comments/abc123/',
      'https://www.reddit.com/r/ivraxr/comments/abc123',
      'https://www.reddit.com/r/IVRAXR/comments/ABC123/Some_Title/?utm_source=share&context=3',
      'https://www.reddit.com/r/ivraxr/comments/abc123/some_title/#lightbox',
      'https://www.reddit.com/r/ivraxr/comments/abc123/comment/def456/',
      'https://www.reddit.com/r/ivraxr/comments/abc123/some_title/def456/?context=3',
      'https://reddit.com/r/ivraxr/comments/abc123/x/',
      'https://old.reddit.com/r/ivraxr/comments/abc123/x/',
      'https://new.reddit.com/r/ivraxr/comments/abc123/x/',
      'https://sh.reddit.com/r/ivraxr/comments/abc123/x/',
      'https://www.reddit.com/comments/abc123/',
      'https://www.reddit.com/user/someone/comments/abc123/x/',
      'https://redd.it/abc123',
      '/r/ivraxr/comments/abc123/x/',
    ])
      expect(redditPostIdOf(url), url).toBe('abc123')
  })

  it('认不出的不猜：分享短链、版块首页、别的站', () => {
    for (const url of [
      'https://www.reddit.com/r/ivraxr/s/AbCdEf123',
      'https://www.reddit.com/r/ivraxr/',
      'https://www.reddit.com/',
      'https://example.com/r/ivraxr/comments/abc123/x/',
      'https://notreddit.com/r/x/comments/abc123/',
      'javascript:alert(1)',
      'r/ivraxr/comments/abc123/x/',
      '',
    ])
      expect(redditPostIdOf(url), url).toBeUndefined()
  })

  it('评论 id：新版 /comment/<id>/ 与旧版 /<标题段>/<id>/；只有帖子时没有', () => {
    expect(redditCommentIdOf('https://www.reddit.com/r/x/comments/abc123/comment/def456/')).toBe(
      'def456',
    )
    expect(redditCommentIdOf('/r/x/comments/abc123/slug/def456/?context=3')).toBe('def456')
    expect(redditCommentIdOf('https://www.reddit.com/r/x/comments/abc123/slug/')).toBeUndefined()
    expect(sameRedditPost(POST_URL, '/r/ivraxr/comments/abc/comment/c1/')).toBe(true)
    expect(sameRedditPost(POST_URL, 'https://www.reddit.com/r/ivraxr/comments/zzz/')).toBe(false)
  })

  it('只有 www（新版）算「能就地填」的页面；old.reddit 不算', () => {
    expect(isNewRedditUrl(POST_URL)).toBe(true)
    expect(isNewRedditUrl('https://reddit.com/r/x/comments/abc/')).toBe(true)
    expect(isNewRedditUrl('https://old.reddit.com/r/x/comments/abc/')).toBe(false)
  })
})

describe('WP467 写路径里没有 old.reddit；就地填 / 滚到眼前 / 已展开不点 都过白名单', () => {
  it('三种写打开的都是 www；发送按钮不在白名单；要看的那几个都写进了白名单', () => {
    for (const action of [
      reply(),
      comment,
      {
        write: { kind: 'submit' as const, subreddit: 'ivraxr', title: 'Weekly Q&A' },
        text: 'Ask anything.',
      },
    ]) {
      const plan = redditWritePlan(action)
      for (const s of plan.steps) if (s.op === 'goto') expect(s.url).toMatch(/^https:\/\/www\./u)
      expect(checkPlanSteps(plan.steps, plan.allow, plan.kind).ok).toBe(true)
      expect(plan.allow.click.some((c) => /submit-button|Comment|Post\b/u.test(c))).toBe(false)
    }
    const plan = redditWritePlan(reply())
    const goto = plan.steps[0]
    expect(goto).toMatchObject({ post: 'abc' })
    // 步骤表自己加的「要看的」不在白名单里就拦
    expect(
      checkStep({ op: 'wait', selector: 'x', reveal: 'button.send' }, plan.allow, plan.kind).ok,
    ).toBe(false)
    expect(
      checkStep(
        { op: 'click', selector: plan.allow.click[0] ?? '', unless: 'button.send' },
        plan.allow,
        plan.kind,
      ).ok,
    ).toBe(false)
    expect(
      checkStep({ op: 'goto', url: POST_URL, post: 'abc', need: 'body' }, plan.allow, plan.kind).ok,
    ).toBe(false)
  })

  it('认「发出去的那一条」：回评论看那一条的下一层，回帖子看顶层', () => {
    expect(redditSentSelectors({ kind: 'reply', parent: 'c1' }).selector).toContain(
      'shreddit-comment[parentid="t1_c1"]',
    )
    expect(redditSentSelectors({ kind: 'comment' }).selector).toContain('[depth="0"]')
  })
})

describe('WP467 就地填（在假新版 Reddit 上）', () => {
  it('已经开着这个帖子：回评论不跳转——先把那条评论滚到眼前、按钮行长出来、点 Reply、填进框', async () => {
    const page = new FakeShreddit(fakeShredditState())
    await page.goto(POST_URL)
    page.visited.length = 0
    await run(page, reply())
    expect(page.visited).toEqual([])
    expect(page.stays).toBe(1)
    expect(page.revealed).toContain('t1_c1')
    expect(page.clicks).toHaveLength(1)
    const box = resolveOne(page.doc, REDDIT_WRITE_SELECTORS_NEW.replyBox('t1_c1')) as HTMLElement
    expect(box.textContent).toBe(DRAFT)
  })

  it('开着的是这个帖子、但要回的那条评论不在这一页：在同一个标签页打开那条评论的链接', async () => {
    const page = new FakeShreddit(fakeShredditState())
    await page.goto(POST_URL)
    page.visited.length = 0
    await run(page, reply('t1_zz9'))
    expect(page.stays).toBe(0)
    expect(page.visited).toEqual(['https://www.reddit.com/r/ivraxr/comments/abc/comment/zz9/'])
  })

  it('开着的是别的帖子：照常打开原帖（www）', async () => {
    const page = new FakeShreddit(fakeShredditState())
    await page.goto('https://www.reddit.com/r/ivraxr/comments/other/x/')
    page.visited.length = 0
    await run(page, comment)
    expect(page.visited).toEqual(['https://www.reddit.com/r/ivraxr/comments/abc/slug/'])
  })

  it('用户已经点开了那条评论的回复框：不再点 Reply（再点会收起来），直接填', async () => {
    const page = new FakeShreddit(fakeShredditState({ lazyRows: false }))
    await page.goto(POST_URL)
    page.humanType('half-typed by the human')
    page.visited.length = 0
    await run(page, reply())
    expect(page.clicks).toEqual([])
    const box = resolveOne(page.doc, REDDIT_WRITE_SELECTORS_NEW.replyBox('t1_c1')) as HTMLElement
    expect(box.textContent).toBe(DRAFT)
  })

  it('回帖子：聚焦「Join the conversation」才展开（真站如此）；回评论的框不会被当成顶层框', async () => {
    const page = new FakeShreddit(fakeShredditState({ lazyRows: false }))
    await page.goto(POST_URL)
    page.humanType('a reply box is open under alice')
    await run(page, comment)
    const top = resolveOne(page.doc, REDDIT_WRITE_SELECTORS_NEW.commentBox) as HTMLElement
    expect(top.textContent).toContain('It works with most frames.')
  })
})

/** jsdom 里搭一个像 Lexical 的编辑器：只认粘贴事件，下一拍把每一行渲染成一段。 */
function lexicalEditor(acceptPaste = true): { doc: Document; el: HTMLElement } {
  const doc = document.implementation.createHTMLDocument('x')
  const win = window as unknown as Record<string, unknown>
  // jsdom 没有 DataTransfer / ClipboardEvent：补一个够用的
  win.DataTransfer ??= class {
    private d = new Map<string, string>()
    setData(t: string, v: string) {
      this.d.set(t, v)
    }
    getData(t: string) {
      return this.d.get(t) ?? ''
    }
  }
  win.ClipboardEvent ??= class extends Event {
    clipboardData: unknown
    constructor(type: string, init: EventInit & { clipboardData?: unknown }) {
      super(type, init)
      this.clipboardData = init.clipboardData
    }
  }
  Object.defineProperty(doc, 'defaultView', { value: window })
  doc.body.innerHTML =
    '<div contenteditable="true" data-lexical-editor="true" role="textbox"><p><span>old words</span></p></div>'
  const el = doc.querySelector('div') as HTMLElement
  el.addEventListener('paste', (e) => {
    if (!acceptPaste) return
    e.preventDefault()
    const text = (
      e as unknown as { clipboardData: { getData(t: string): string } }
    ).clipboardData.getData('text/plain')
    setTimeout(() => {
      el.innerHTML = text
        .split('\n')
        .map((l) => `<p><span>${l}</span></p>`)
        .join('')
    }, 30)
  })
  return { doc, el }
}

describe('WP467 富文本框按「粘贴」交给编辑器', () => {
  it('换行成段、原来的字整段换掉', async () => {
    const { doc, el } = lexicalEditor()
    const out = await domFillAsync(doc, 'div[contenteditable="true"]', 'First line.\n\nSecond one.')
    expect(out).toEqual({ ok: true })
    expect(el.querySelectorAll('p')).toHaveLength(2)
    expect(el.textContent).toBe('First line.Second one.')
  })

  it('编辑器什么都不认：照实说，不往编辑器里硬写字（会和它自己的状态打架）', async () => {
    const { doc, el } = lexicalEditor(false)
    const out = await domFillAsync(doc, 'div[contenteditable="true"]', 'Hello there')
    expect(out.ok).toBe(false)
    expect(el.textContent).toBe('old words')
  })

  it('空行不另起空段', () => {
    expect(editorParagraphs('a\r\n\r\n\nb\n  \nc  ')).toBe('a\nb\nc')
  })
})

describe('WP467 人自己发出去的那一条怎么认', () => {
  it('同一个号、改了几个词也认；别的号不认；八竿子打不着的不认', () => {
    const said = 'Hi Alice — the Air3 fits over most prescription glasses frames!'
    expect(
      looksLikeSent({ draft: DRAFT, said, me: 'ivra_official', author: 'ivra_official' }),
    ).toBe(true)
    expect(looksLikeSent({ draft: DRAFT, said, me: 'ivra_official', author: 'u/someone' })).toBe(
      false,
    )
    expect(
      looksLikeSent({
        draft: DRAFT,
        said: 'Totally unrelated words about pricing in Japan.',
        me: 'ivra_official',
        author: 'ivra_official',
      }),
    ).toBe(false)
  })

  it('不知道谁登着：要更像才认（基本没改）；Markdown 渲染掉了也对得上', () => {
    const md = 'See [our FAQ](https://example.com/faq) — **it fits** most frames.'
    expect(looksLikeSent({ draft: md, said: 'See our FAQ — it fits most frames.' })).toBe(true)
    expect(looksLikeSent({ draft: DRAFT, said: 'Hi Alice, it fits some frames maybe.' })).toBe(
      false,
    )
  })

  it('中文按相邻两个字算', () => {
    expect(
      draftSimilarity('这款眼镜可以戴在近视镜外面', '这款眼镜可以戴在近视镜外面哦'),
    ).toBeGreaterThan(0.85)
    expect(draftSimilarity('这款眼镜可以戴在近视镜外面', '价格在日本是多少')).toBeLessThan(0.2)
  })
})

describe('WP467 真站核过的两处坑', () => {
  it('翻译插件插进评论里的译文：读回时去掉，只留原文；认法照样认得出', () => {
    const doc = document.implementation.createHTMLDocument('x')
    doc.body.innerHTML = `<shreddit-comment thingid="t1_n1" author="ivra_official" depth="0" permalink="/r/x/comments/abc/comment/n1/" created="2026-10-22T08:00:00.000+0000">
      <details><div><div slot="comment"><p>${DRAFT} <font class="notranslate immersive-translate-target-wrapper"><font data-immersive-translate-translation-element-mark="1">嗨 Alice，Air3 能戴在大多数近视眼镜外面。</font></font></p></div></div></details>
    </shreddit-comment>`
    const sel = redditSentSelectors({ kind: 'comment' })
    const [hit] = domFindPosted(doc, sel.selector, sel.body, DRAFT, 'ivra_official')
    expect(hit?.text).toBe(DRAFT)
    expect(hit?.created_ms).toBe(Date.parse('2026-10-22T08:00:00.000Z'))
    // 就算没去掉（别的翻译插件）：草稿的词都在里面也认
    expect(
      looksLikeSent({
        draft: DRAFT,
        said: `${DRAFT} 嗨 Alice，Air3 能戴在大多数近视眼镜外面。`,
        me: 'ivra_official',
        author: 'ivra_official',
      }),
    ).toBe(true)
  })

  it('新版 Reddit 一展开评论框就加载的隐形 reCAPTCHA 脚本不算「被拦了」；整页拦截照样停', () => {
    const look = {
      url: POST_URL,
      title: 'r/ivraxr',
      text: 'Join the conversation',
      frameSources: ['https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js'],
      passwordInputs: 0,
    }
    expect(detectPageWall(look, 'Reddit')).toBeUndefined()
    // 广告后台那边原样（脚本出现就停）
    expect(detectPageWall(look)?.kind).toBe('captcha')
    expect(
      detectPageWall({ ...look, frameSources: ['https://challenges.cloudflare.com/x'] }, 'Reddit')
        ?.kind,
    ).toBe('captcha')
    expect(
      detectPageWall({ ...look, text: "You've been blocked by network security." }, 'Reddit')?.kind,
    ).toBe('blocked')
  })

  it('刚打开的页面上第一下 Reply 不理：等一会儿再点一下（只在框还没出来时）', () => {
    const plan = redditWritePlan(reply())
    const clicks = plan.steps.filter((s) => s.op === 'click')
    expect(clicks).toHaveLength(2)
    for (const c of clicks)
      expect(c).toMatchObject({ unless: expect.stringContaining('shreddit-composer') })
    expect(plan.steps.find((s) => s.op === 'wait' && s.optional === true)).toBeDefined()
  })
})
