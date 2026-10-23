/**
 * 教程上官网（私有 docs/113）：没发版的教程先不换、纯文本版的链接、给软件的目录、llms.txt、工坊笔记。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHelpIndex } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadBlog, parsePost } from '../src/lib/blog.js'
import { newestRelease, type SiteGit } from '../src/lib/git.js'
import { clearHelpCache, helpSlugs, helpSource, loadHelp } from '../src/lib/help.js'
import { buildHelpIndex, llmsTxt, publicMarkdown, sha256Hex } from '../src/lib/machine.js'

const fakeGit = (tag: string | undefined, files: Record<string, string> = {}): SiteGit => ({
  latestRelease: () => tag,
  showAt: (t, path) => (t === tag ? files[path] : undefined),
  lastModified: () => '2026-10-20',
})

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'site-help-'))
  mkdirSync(join(root, 'docs/help'), { recursive: true })
  mkdirSync(join(root, 'apps/site/src/content/blog'), { recursive: true })
  for (const [p, text] of Object.entries(files)) writeFileSync(join(root, p), text)
  return root
}

const article = (meta: string, body: string) => `---\n${meta}\n---\n${body}`

beforeEach(() => clearHelpCache())

describe('requires: next（讲的是还没发版的功能）', () => {
  const now = {
    'docs/help/a.md': article('group: start\norder: 10\ndescription: 新的', '# 新标题\n\n新正文\n'),
    'docs/help/a.en.md': article('description: new', '# New\n\nnew\n'),
    'docs/help/b.md': article(
      'group: tools\norder: 20\nrequires: next\ndescription: 新功能',
      '# B 新\n\n新\n',
    ),
    'docs/help/b.en.md': '# B new\n',
    'docs/help/c.md': article('group: tools\norder: 30\nrequires: next', '# C\n\n全新的一篇\n'),
    'docs/help/c.en.md': '# C\n',
  }

  it('上一个正式版里有：用那时的文字，版本号记成那一版', () => {
    const root = fixture(now)
    const git = fakeGit('v0.2.1-beta.8', {
      'docs/help/b.md': article('group: tools\norder: 20\ndescription: 旧的', '# B 旧\n\n旧\n'),
      'docs/help/b.en.md': '# B old\n',
    })
    const zh = helpSource('b', 'zh', root, git)
    expect(zh?.body).toContain('# B 旧')
    expect(zh?.requires).toBeUndefined()
    expect(helpSource('b', 'en', root, git)?.body).toContain('# B old')
  })

  it('那一版里也写着 next：就是那一版起有的', () => {
    const root = fixture(now)
    const git = fakeGit('v0.2.1-beta.8', { 'docs/help/b.md': now['docs/help/b.md'] })
    expect(helpSource('b', 'zh', root, git)?.requires).toBe('0.2.1-beta.8')
  })

  it('那时还没有这一篇、或者没有 git：先不上；没写 next 的照常上', () => {
    const root = fixture(now)
    expect(helpSlugs(root, fakeGit('v0.2.1-beta.8'))).toEqual(['a'])
    clearHelpCache()
    expect(helpSlugs(root, fakeGit(undefined))).toEqual(['a'])
  })

  it('最新正式版：只认 v主.次.修订，按版本排', () => {
    expect(newestRelease(['v0.2.1-beta.9', 'v0.2.1-beta.10', 'content-beta', 'v0.2.0'])).toBe(
      'v0.2.1-beta.10',
    )
    expect(newestRelease([''])).toBeUndefined()
  })
})

describe('英文那份', () => {
  it('description 用英文自己的，归属跟中文走', () => {
    const root = fixture({
      'docs/help/a.md': article(
        'group: connect\norder: 10\ndescription: 中文答案\npositions: [ads]',
        '# 中\n\n正文\n',
      ),
      'docs/help/a.en.md': article('description: English answer', '# En\n\nbody\n'),
    })
    const git = fakeGit(undefined)
    helpSlugs(root, git)
    const en = loadHelp('a', 'en', root)
    expect(en).toMatchObject({ title: 'En', description: 'English answer', positions: ['ads'] })
    expect(en.group).toBe('connect')
  })
})

describe('纯文本版', () => {
  it('help: 互链换成官网完整网址；工作台里的路径只留文字；图片只留说明；外链不动', () => {
    const md = publicMarkdown(
      '# T\n\n看[连邮箱](help:conn-email)，去[设置](/settings/connections)，![截图](x.png)，[官方](https://example.com)，[没有](help:nope)。',
      'zh',
      ['conn-email'],
    )
    expect(md).toContain('[连邮箱](https://agentsws.com/docs/conn-email/)')
    expect(md).toContain('设置（在工作台里）')
    expect(md).toContain('，截图，')
    expect(md).toContain('[官方](https://example.com)')
    expect(md).toContain('没有。')
    expect(publicMarkdown('[mail](help:conn-email)', 'en', ['conn-email'])).toContain(
      'https://agentsws.com/en/docs/conn-email/',
    )
  })
})

describe('给软件的目录 /help/index.json', () => {
  it('软件那边按契约读得回来，指纹就是纯文本的 sha256', () => {
    const root = fixture({
      'docs/help/a.md': article(
        'group: start\norder: 10\ndescription: 答案\naliases: [old-a]',
        '# A\n\n正文\n',
      ),
      'docs/help/a.en.md': article('description: answer', '# A\n\nbody\n'),
    })
    helpSlugs(root, fakeGit(undefined))
    const zh = loadHelp('a', 'zh', root)
    const markdown = publicMarkdown(zh.body, 'zh', ['a'])
    const index = buildHelpIndex({
      guides: [{ ...zh, markdown }],
      notes: [],
      changelog: [
        { lang: 'zh', markdown: '# log\n', updated: '2026-10-21', description: '每次更新' },
      ],
      release: '0.2.1-beta.8',
      generatedAt: '2026-10-22T00:00:00Z',
    })
    const back = parseHelpIndex(JSON.parse(JSON.stringify(index)))
    expect(back?.items).toHaveLength(2)
    expect(back?.items[0]).toMatchObject({
      kind: 'guide',
      slug: 'a',
      url: 'https://agentsws.com/docs/a/',
      md: 'https://agentsws.com/docs/a.md',
      group: 'start',
      aliases: ['old-a'],
      hash: sha256Hex(markdown),
    })
    expect(back?.items[1]).toMatchObject({
      kind: 'changelog',
      md: 'https://agentsws.com/changelog.md',
    })
    const llms = llmsTxt(index)
    expect(llms).toContain('- [A](https://agentsws.com/docs/a.md): 答案')
    expect(llms).toContain('https://agentsws.com/help/index.json')
  })
})

describe('工坊笔记', () => {
  const post = article(
    'title: 为什么要你点头\ndescription: 因为发出去的事收不回来。\ndate: 2026-10-23\ntags: [审批]',
    '正文第一段。\n',
  )

  it('文件名给日期与网址，头上给标题与摘要', () => {
    const p = parsePost('2026-10-23-why-approve', post, 'zh', [], '2026-10-23')
    expect(p).toMatchObject({
      slug: 'why-approve',
      title: '为什么要你点头',
      description: '因为发出去的事收不回来。',
      date: '2026-10-23',
      tags: ['审批'],
      draft: false,
    })
  })

  it('草稿不上；没有文件夹也不报错', () => {
    const root = fixture({
      'apps/site/src/content/blog/2026-10-23-why-approve.md': post,
      'apps/site/src/content/blog/2026-10-24-draft.md': article(
        'title: 草稿\ndraft: true',
        '写一半\n',
      ),
      'apps/site/src/content/blog/README.md': '# 说明\n',
    })
    expect(loadBlog('zh', [], root, fakeGit(undefined)).map((p) => p.slug)).toEqual(['why-approve'])
    expect(loadBlog('zh', [], join(root, 'nope'), fakeGit(undefined))).toEqual([])
  })
})
