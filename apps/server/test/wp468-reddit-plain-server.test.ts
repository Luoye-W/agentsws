/**
 * WP468（决策 1510）：Reddit 起草不写 Markdown + 出卡前兜一道（新版评论框是富文本，记号会照原样发出去）。
 * 不联网、不起浏览器：起草器是假的，卡落在内存里。
 */
import { describe, expect, it } from 'vitest'
import {
  cleanRedditDraft,
  REDDIT_PLAIN_RULE,
  redditDraftPrompt,
} from '../src/reddit-write/draft.js'
import { createRedditWriteService } from '../src/reddit-write/service.js'

const target = {
  kind: 'reply' as const,
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/s/c1/',
  parent_author: 'alice',
  parent_text: 'Where is the pairing guide?',
  post_title: 'Air3 pairing',
}
const actor = { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'social.reddit' } as never

function make(raw?: string) {
  const created: { summary: string; payload: { body: { text: string; subject?: string } } }[] = []
  const svc = createRedditWriteService({
    workspace_id: 'ws_r' as never,
    clock: { now: () => '2026-10-22T09:00:00.000Z' },
    approvals: {
      create: async (input) => {
        created.push(input as never)
        return { ...(input as object), id: `ap_${created.length}`, state: 'pending' } as never
      },
    },
    emit: () => undefined,
    brand: () => 'IVRA',
    record: () => undefined,
    ...(raw === undefined ? {} : { drafter: () => async () => cleanRedditDraft(raw, target.kind) }),
  })
  return { svc, created }
}

describe('起草提示：不写 Markdown，链接写完整网址，分段用空行', () => {
  it('评论与发新帖都带这一条；不再说「可以用简单的 Markdown」', () => {
    for (const t of [target, { kind: 'submit' as const, subreddit: 'ivraxr' }]) {
      const p = redditDraftPrompt({ target: t, brand: 'IVRA', voice: 'v', facts: [] })
      expect(p).toContain(REDDIT_PLAIN_RULE)
      expect(p).toContain('直接写完整网址')
      expect(p).toContain('分段用空行')
      expect(p).not.toContain('可以用简单的 Markdown')
    }
  })

  it('模型没听：整理草稿那一步就去掉记号（「**Title:**」也认得出标题）', () => {
    expect(
      cleanRedditDraft(
        '**Title:** New firmware is out\n\nSee [the notes](https://example.com/notes) **today**.',
        'submit',
      ),
    ).toEqual({
      title: 'New firmware is out',
      text: 'See the notes (https://example.com/notes) today.',
    })
  })
})

describe('出卡前兜一道：卡上的正文 / 标题是纯文字', () => {
  it('人或 AI 交来的正文带记号 → 卡上转成纯文字', async () => {
    const { svc, created } = make()
    const out = await svc.stage(actor, {
      target,
      text: '# Hi\n\nThe **pairing guide** is [here](https://example.com/pair).',
    })
    expect(out.staged).toBe(true)
    expect(created[0]?.payload.body.text).toBe(
      'Hi\n\nThe pairing guide is here (https://example.com/pair).',
    )
    expect(created[0]?.summary).not.toContain('**')
  })

  it('发新帖的标题也去记号', async () => {
    const { svc, created } = make()
    await svc.stage(actor, {
      target: { kind: 'submit', subreddit: 'ivraxr' },
      title: '**Weekly** Q&A',
      text: 'Ask us __anything__.',
    })
    expect(created[0]?.payload.body).toEqual({ text: 'Ask us anything.', subject: 'Weekly Q&A' })
  })

  it('AI 起草那一路（draft）出来的也是纯文字', async () => {
    const { svc } = make('Hi **alice**, the guide is at [our site](https://example.com/pair).')
    const d = await svc.draft(actor, { target })
    expect(d.text).toBe('Hi alice, the guide is at our site (https://example.com/pair).')
  })
})
