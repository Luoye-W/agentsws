/**
 * 教程上官网（私有 docs/113 §4）：本机帮助库——随包那份、去官网拉、挑哪一份、断网兜底；
 * 以及 `/v1/help/*` 两条路由（真服务进程 + HTTP，官网用替身，不打真网）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HelpIndexItem } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHelpLibrary,
  HELP_SNAPSHOT_FILE,
  type HelpFetch,
  loadBundledHelpFiles,
  localizeHelpLinks,
} from '../src/help-library.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const SITE = 'https://agentsws.com'
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'help-lib-'))
  dirs.push(d)
  return d
}
let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BUNDLED = {
  'conn-email.md':
    '---\ngroup: connect\norder: 120\ndescription: 随包的答案\npositions: [b2b]\nroles: []\n---\n# 连邮箱\n\n随包正文，见[Shopify](help:conn-shopify)。\n',
  'conn-email.en.md': '---\ndescription: bundled answer\n---\n# Connect email\n\nbundled body\n',
  'old-name.md': '---\ngroup: tools\norder: 900\n---\n# 旧名字那篇\n\n旧\n',
  'agentsws-credits.md': '---\ngroup: start\norder: 10\n---\n# 积分\n\n积分正文\n',
}

/** 一个假的官网：目录 + 每篇纯文本；记下每次请求。 */
function fakeSite(pages: { item: Partial<HelpIndexItem> & { slug: string }; text: string }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const files = new Map<string, string>()
  const items = pages.map(({ item, text }) => {
    const lang = item.lang ?? 'zh'
    const kind = item.kind ?? 'guide'
    const base = kind === 'note' ? 'blog' : 'docs'
    const pre = lang === 'en' ? '/en' : ''
    const md = `${SITE}${pre}/${base}/${item.slug}.md`
    files.set(md, text)
    return {
      kind,
      lang,
      title: item.slug,
      description: `官网的 ${item.slug}`,
      url: `${SITE}${pre}/${base}/${item.slug}/`,
      md,
      positions: [],
      roles: [],
      updated: '2026-10-22',
      hash: sha(text),
      ...item,
    }
  })
  let offline = false
  const index = { schema: 1, generated_at: '2026-10-22T00:00:00Z', release: '0.2.1-beta.8', items }
  const fetch: HelpFetch = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    )
    calls.push({ url, headers })
    if (offline) throw new Error('offline')
    if (url === `${SITE}/help/index.json`) {
      if (headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 })
      return new Response(JSON.stringify(index), { headers: { etag: '"v1"' } })
    }
    const text = files.get(url)
    return text === undefined ? new Response('nope', { status: 404 }) : new Response(text)
  }
  return {
    fetch,
    calls,
    files,
    goOffline: () => {
      offline = true
    },
  }
}

describe('随包那份', () => {
  it('安装包里：读工作台产物旁边的 help-snapshot.json；开发时读仓库的 docs/help', () => {
    const dir = tmp()
    writeFileSync(join(dir, HELP_SNAPSHOT_FILE), JSON.stringify({ schema: 1, files: BUNDLED }))
    expect(Object.keys(loadBundledHelpFiles(dir))).toEqual(Object.keys(BUNDLED))
    const dev = loadBundledHelpFiles(tmp())
    expect(dev['conn-shopify.md']).toContain('# 连 Shopify 店铺')
    expect(dev['conn-shopify.en.md']).toBeDefined()
  })

  it('没联网：目录与正文全是随包的；英文用英文那份、归属跟中文走；没写英文的退回中文', async () => {
    const lib = createHelpLibrary({ appVersion: '0.2.1-beta.8', online: false, bundled: BUNDLED })
    const zh = lib.catalog('zh')
    expect(zh.items.map((i) => i.slug)).toEqual(['agentsws-credits', 'conn-email', 'old-name'])
    expect(zh.items[1]).toMatchObject({
      title: '连邮箱',
      description: '随包的答案',
      source: 'bundled',
      positions: ['b2b'],
      url: `${SITE}/docs/conn-email/`,
      needs_newer_app: false,
    })
    const en = await lib.article('conn-email', 'en')
    expect(en).toMatchObject({
      title: 'Connect email',
      description: 'bundled answer',
      positions: ['b2b'],
    })
    expect(en?.markdown).toContain('bundled body')
    expect((await lib.article('agentsws-credits', 'en'))?.markdown).toContain('积分正文')
    expect(await lib.article('nope', 'zh')).toBeUndefined()
    expect(await lib.refresh()).toBe(false)
  })
})

describe('去官网拉', () => {
  it('拉目录与正文、对指纹、存本机；不带用户信息；再拉带 If-None-Match 拿 304', async () => {
    const cacheDir = tmp()
    const site = fakeSite([
      {
        item: { slug: 'conn-email', group: 'connect', order: 120 },
        text: '# 连邮箱\n\n官网新写法，见[Shopify](https://agentsws.com/docs/conn-shopify/)。\n',
      },
      { item: { slug: 'brand-new', group: 'tools', order: 5 }, text: '# 全新的一篇\n\n官网才有\n' },
      {
        item: { slug: 'why-approve', kind: 'note', date: '2026-10-23' },
        text: '# 为什么\n\n笔记\n',
      },
    ])
    const lib = createHelpLibrary({
      appVersion: '0.2.1-beta.8',
      cacheDir,
      fetch: site.fetch,
      bundled: BUNDLED,
    })
    expect(await lib.refresh()).toBe(true)
    expect(site.calls[0]?.headers).toEqual({ 'user-agent': 'AgentsWorkshop/0.2.1-beta.8' })
    const zh = lib.catalog('zh')
    expect(zh.release).toBe('0.2.1-beta.8')
    expect(zh.fetched_at).toBeDefined()
    expect(zh.items.map((i) => `${i.kind}:${i.slug}:${i.source}`)).toEqual([
      'guide:agentsws-credits:bundled',
      'guide:conn-email:online',
      'guide:brand-new:online',
      'guide:old-name:bundled',
      'note:why-approve:online',
    ])
    // 指向官网教程的完整网址换回右栏认的 help:
    expect((await lib.article('conn-email', 'zh'))?.markdown).toContain(
      '[Shopify](help:conn-shopify)',
    )
    expect((await lib.article('why-approve', 'zh', 'note'))?.markdown).toContain('笔记')
    expect(readdirSync(join(cacheDir, 'md'))).toHaveLength(3)

    // 再起一个（下次启动）：不联网也读得回上次存的
    const again = createHelpLibrary({
      appVersion: '0.2.1-beta.8',
      cacheDir,
      online: false,
      bundled: {},
    })
    expect((await again.article('brand-new', 'zh'))?.markdown).toContain('官网才有')

    site.calls.length = 0
    expect(await lib.refresh()).toBe(true)
    expect(site.calls).toHaveLength(1)
    expect(site.calls[0]?.headers['if-none-match']).toBe('"v1"')
  })

  it('指纹对不上的不收；目录格式不对整份不认；断网不抛错、继续用随包的', async () => {
    const site = fakeSite([{ item: { slug: 'conn-email' }, text: '# 连邮箱\n\n官网\n' }])
    site.files.set(`${SITE}/docs/conn-email.md`, '# 被人改过\n')
    const lib = createHelpLibrary({
      appVersion: '0.2.1-beta.8',
      fetch: site.fetch,
      bundled: BUNDLED,
    })
    expect(await lib.refresh()).toBe(true)
    // 目录照官网，正文没下回来 → 先用随包的
    expect((await lib.article('conn-email', 'zh'))?.markdown).toContain('随包正文')

    const broken: HelpFetch = async () => new Response(JSON.stringify({ schema: 99, items: [] }))
    const lib2 = createHelpLibrary({ appVersion: '0.2.1-beta.8', fetch: broken, bundled: BUNDLED })
    expect(await lib2.refresh()).toBe(false)
    site.goOffline()
    const lib3 = createHelpLibrary({
      appVersion: '0.2.1-beta.8',
      fetch: site.fetch,
      bundled: BUNDLED,
    })
    expect(await lib3.refresh()).toBe(false)
    expect(lib3.catalog('zh').items).toHaveLength(3)
  })
})

describe('版本对不上', () => {
  const pages = [
    {
      item: { slug: 'conn-email', requires: '0.2.1-beta.9' },
      text: '# 连邮箱\n\n新版的说法\n',
    },
    { item: { slug: 'new-feature', requires: '0.2.1-beta.9' }, text: '# 新功能\n\n新\n' },
    { item: { slug: 'renamed', aliases: ['old-name'] }, text: '# 改了名\n\n新名字\n' },
  ]

  it('官网讲的是新版：先给随包那份（和这台对得上）+ newer_online；整篇新功能照列、标「新版」', async () => {
    const site = fakeSite(pages)
    const lib = createHelpLibrary({
      appVersion: '0.2.1-beta.8',
      fetch: site.fetch,
      bundled: BUNDLED,
    })
    await lib.refresh()
    const email = await lib.article('conn-email', 'zh')
    expect(email).toMatchObject({ source: 'bundled', newer_online: true, needs_newer_app: false })
    expect(email?.markdown).toContain('随包正文')
    const fresh = await lib.article('new-feature', 'zh')
    expect(fresh).toMatchObject({ source: 'online', needs_newer_app: true, newer_online: false })
  })

  it('这台够新：用官网的；改过名的旧地址也认，旧那篇不再单列', async () => {
    const site = fakeSite(pages)
    const lib = createHelpLibrary({
      appVersion: '0.2.1-beta.9',
      fetch: site.fetch,
      bundled: BUNDLED,
    })
    await lib.refresh()
    expect((await lib.article('conn-email', 'zh'))?.markdown).toContain('新版的说法')
    expect((await lib.article('old-name', 'zh'))?.slug).toBe('renamed')
    expect(lib.catalog('zh').items.map((i) => i.slug)).not.toContain('old-name')
  })
})

describe('官网网址换回 help:', () => {
  it('中英两种都换；不是教程页的不动', () => {
    expect(
      localizeHelpLinks(
        '[a](https://agentsws.com/en/docs/conn-x/) [b](https://agentsws.com/pricing/)',
      ),
    ).toBe('[a](help:conn-x) [b](https://agentsws.com/pricing/)')
  })
})

describe('/v1/help/*', () => {
  it('目录与正文；不存在的 404；kind 不认的 400；测试里不起定时也不打网', async () => {
    const dbDir = tmp()
    server = await createServer({
      dbDir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
      tokenRefreshIntervalMs: 0,
      help: { bundled: BUNDLED, appVersion: '0.2.1-beta.8' },
    })
    const { url } = await server.listen(0)
    const s = server
    const get = (path: string) =>
      fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${s.bootstrap.internalToken}` } })
    const cat = await get('/v1/help/catalog?lang=en')
    expect(cat.status).toBe(200)
    const view = ((await cat.json()) as { data: { lang: string; items: { slug: string }[] } }).data
    expect(view.lang).toBe('en')
    expect(view.items.map((i) => i.slug)).toContain('conn-email')
    const art = await get('/v1/help/articles/conn-email?lang=zh')
    expect(((await art.json()) as { data: { markdown: string } }).data.markdown).toContain(
      '随包正文',
    )
    expect((await get('/v1/help/articles/nope')).status).toBe(404)
    expect((await get('/v1/help/articles/conn-email?kind=video')).status).toBe(400)
    expect(existsSync(join(dbDir, 'help-cache'))).toBe(false)
  })
})
