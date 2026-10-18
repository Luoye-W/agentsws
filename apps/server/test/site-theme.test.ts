/**
 * WP253：建站岗位的主题工坊（服务端那一半）。
 *
 * 假 `shopify` 是**真脚本、真子进程**（`<node> <入口> theme …`，与 WP245 私有安装同一个起法）；
 * 店里的线上主题是手写的 Horizon 形状假主题（`FAKE_HORIZON_FILES`，不是 Horizon 的拷贝），不联网、不碰任何真店。
 *
 * 钉住的事：起底（WP301：在店里复制一份 Horizon、拉下来、生成目录；旧目录挪开不删）/ 拉 / 检查 /
 * 看改文件（出不去、只改商店层文件、模板对着目录查）/
 * 推未发布（预览链接、改了哪些文件、同名再推更新同一份）/ 发布只出卡（卡上写清换哪一份、改了哪些文件；
 * 一次 `theme publish` 都没跑）/ 批了才执行 / 没装 / 没登录 / 不知道是哪家店。
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformKitOf, type RunRequest, type StagedChange } from '@agentsws/contracts'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliSessionEnv } from '../src/platform-cli-session.js'
import {
  baseWritable,
  changedFiles,
  createSiteTheme,
  HORIZON_BASE,
  type SiteThemeAssembly,
} from '../src/site-theme.js'
import { FAKE_HORIZON_FILES } from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'
import { type FakeShopifyTheme, writeFakeShopifyTheme } from './fixtures/fake-shopify-theme.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SHOP = '6demox-md.myshopify.com'
const WS = 'ws_rovella'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let cli: FakeShopifyTheme
let staged: StageInput[]
let previews: { matter: string; url: string; label: string }[]
let machine: { installed: boolean; loggedIn: boolean; shops: string[] }

const request = (role_id = 'site.shopify-theme', matter = 'mat_1'): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_owner', assignment_id: 'asg_theme', role_id },
    work_item: { id: matter, conversation_id: matter, role_id },
  }) as unknown as RunRequest

function make(): SiteThemeAssembly {
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => T0 },
    dataDir: join(dir, 'data'),
    settingsFile: join(dir, 'data', 'brand', 'site-theme.json'),
    cliSpec: () => spec,
    probe: async () => ({
      installed: machine.installed,
      node_ok: true,
      min_node_major: 20,
      checked_at: T0,
      ...(machine.installed ? { source: 'app' as const, version: '4.8.5' } : {}),
    }),
    loggedIn: () => machine.loggedIn,
    invocation: () => ({ command: process.execPath, prefix: [cli.entry] }),
    // WP253：一个品牌一份 CLI 会话（配置目录指到品牌那一份）
    sessionEnv: () => cliSessionEnv(join(dir, 'sessions', WS)),
    connectedShops: () => machine.shops,
    env: { ...process.env, AGENTSWS_SECRETS_KEY: 'never-leaks', OOMOL_CONNECT_ADMIN_TOKEN: 'x' },
    ledger: {
      stage: async (input: StageInput): Promise<StageOutcome> => {
        staged.push(input)
        return {
          ok: true,
          change: { id: `chg_${staged.length}` } as never,
          approval: { id: `apv_${staged.length}` } as never,
        }
      },
    },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    notePreview: (matter, input) => previews.push({ matter, url: input.url, label: input.label }),
  })
}

const themeDir = (): string => join(dir, 'data', 'themes', WS, SHOP)
const publishes = (): string[][] =>
  cli
    .calls()
    .filter((c) => c.argv[1] === 'publish')
    .map((c) => c.argv)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp253-theme-'))
  mkdirSync(join(dir, 'bin'))
  cli = writeFakeShopifyTheme(join(dir, 'bin'))
  staged = []
  previews = []
  machine = { installed: true, loggedIn: true, shops: [] }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('还差哪一步（岗位页与工具同一套判断）', () => {
  it('没装 → 一键安装；没登录 → 登录；不知道店 → 填地址；都好了没有 next', async () => {
    const t = make()
    machine.installed = false
    expect((await t.readiness()).next).toBe('install_cli')
    machine.installed = true
    machine.loggedIn = false
    expect((await t.readiness()).next).toBe('login')
    machine.loggedIn = true
    expect((await t.readiness()).next).toBe('store')
    const r = await t.setStore('https://admin.shopify.com/store/6demox-md/themes')
    expect(r).toMatchObject({
      store: SHOP,
      store_source: 'manual',
      cli: 'ready',
      cli_source: 'app',
    })
    expect(r.next).toBeUndefined()
    // 连了店就以连接为准
    machine.shops = ['other.myshopify.com']
    expect((await t.readiness()).store).toBe('other.myshopify.com')
    expect((await t.readiness()).store_source).toBe('connection')
  })

  it('不是 Shopify 的品牌：applicable=false，工具一律说用不了', async () => {
    const t = createSiteTheme({
      workspace_id: WS,
      clock: { now: () => T0 },
      dataDir: join(dir, 'data'),
      cliSpec: () => undefined,
      probe: async () => {
        throw new Error('不该检测')
      },
      loggedIn: () => true,
      invocation: () => ({ command: 'x', prefix: [] }),
      connectedShops: () => [],
      ledger: { stage: async () => ({ ok: false, reason: 'guardrail', message: 'x' }) },
      effectiveConfig: () => ({}) as never,
    })
    expect((await t.readiness()).applicable).toBe(false)
    await expect(t.list()).rejects.toThrow(/不是 Shopify/)
  })
})

describe('起底（店里复制一份 Horizon）→ 改 → 检查 → 推未发布 → 发布出卡 → 批了才执行', () => {
  it('一整条（假 CLI 是真子进程）', async () => {
    const t = make()
    await t.setStore(SHOP)
    const init = await t.initFromBase({})
    // 线上就是 Horizon：复制线上那一份成未发布主题，拉下来
    expect(init.theme).toEqual({ name: 'Horizon', version: '9.9.9-fixture' })
    expect(init.source).toEqual({ theme_id: '100001', name: 'Horizon', live: true })
    expect(init.copy.theme_id).not.toBe('100001')
    expect(init.copy.name).toBe('Horizon 草稿 10-07')
    expect(init.base.repo).toBe('Shopify/horizon')
    expect(init.files).toBeGreaterThan(10)
    expect(init.catalog).toEqual({ sections: 5, blocks: 5 })
    const copy = cli.themes().find((x) => x.id === init.copy.theme_id)
    expect(copy?.role).toBe('unpublished')
    expect(
      cli
        .calls()
        .filter((c) => c.argv[1] === 'duplicate')
        .map((c) => c.argv),
    ).toEqual([
      [
        'theme',
        'duplicate',
        '--theme',
        '100001',
        '--name',
        'Horizon 草稿 10-07',
        '--force',
        '--json',
      ],
    ])
    // 先只拉 settings_schema.json 认一认是不是 Horizon，再整份拉复制出来那一份
    const pulls = cli
      .calls()
      .filter((c) => c.argv[1] === 'pull')
      .map((c) => c.argv.slice(0, 6))
    expect(pulls[0]).toEqual([
      'theme',
      'pull',
      '--theme',
      '100001',
      '--only',
      'config/settings_schema.json',
    ])
    expect(pulls[1]?.slice(0, 4)).toEqual(['theme', 'pull', '--theme', init.copy.theme_id])
    // 目录按这份主题的 schema 现生成，放在工作目录根上
    expect((await t.files()).files).toEqual(
      expect.arrayContaining(['CATALOG.index.json', 'CATALOG.json', 'templates/index.json']),
    )
    const index = JSON.parse((await t.readFile('CATALOG.index.json')).content)
    expect(index.theme).toBe('Horizon 9.9.9-fixture')
    expect(index.sections).toContainEqual({
      id: 'hero',
      name: 'Hero',
      category: 'Banners',
      accepts: '全部公开块、_heading',
      static: ['_heading'],
    })
    expect((await t.readiness()).workspace.base).toMatchObject({
      repo: 'Shopify/horizon',
      theme_name: 'Horizon',
      copy_theme_id: init.copy.theme_id,
    })

    // 改：只许商店层文件（模板 / section 组 / settings_data / locales 店面文案）
    const ok = await t.writeFile(
      'templates/index.json',
      JSON.stringify({
        sections: {
          hero_1: {
            type: 'hero',
            blocks: {
              heading: { type: '_heading', static: true, settings: { text: 'Rovella' } },
              b1: {
                type: 'button',
                settings: { label: 'Shop', link: 'shopify://collections/all' },
              },
            },
            block_order: ['b1'],
            settings: { height: 'small' },
          },
        },
        order: ['hero_1'],
      }),
    )
    expect(ok.problems).toBeUndefined()
    const wrong = await t.writeFile(
      'templates/page.json',
      JSON.stringify({
        sections: {
          s: {
            type: 'product-list',
            blocks: { d: { type: '_divider', settings: { thickness: 2, colour: 'red' } } },
          },
        },
        order: ['s', 'ghost'],
      }),
    )
    expect(wrong.problems).toEqual([
      'templates/page.json：分区 s（product-list） 里的块 d（_divider）放错了地方：product-list 收的是 全部公开块',
      'templates/page.json：分区 s（product-list） › d 的设置 colour 在目录里没有（照 CATALOG.json 那一项的 settings 抄 id）',
      'templates/page.json：页面 的顺序里有 ghost，但没有这个实例',
    ])
    await t.writeFile('templates/page.json', '{"sections":{},"order":[]}')
    await t.writeFile(
      'sections/header-group.json',
      FAKE_HORIZON_FILES['sections/header-group.json'] ?? '',
    )
    await expect(t.writeFile('sections/hero.liquid', 'x')).rejects.toThrow(/核心代码/)
    await expect(t.writeFile('sections/custom-hero.liquid', 'x')).rejects.toThrow(/核心代码/)
    await expect(t.writeFile('assets/base.css', 'x')).rejects.toThrow(/核心代码/)
    await expect(t.writeFile('locales/en.default.schema.json', '{}')).rejects.toThrow(/核心代码/)
    await expect(t.writeFile('README.md', 'x')).rejects.toThrow(/只许写主题那几个目录/)

    // 检查：有 error 时退出码非零，但那是结论
    await t.writeFile('locales/en.default.json', '{\n"general":\n{"cart": "{% broken"}}\n')
    const bad = await t.check()
    expect(bad.errors).toBe(1)
    expect(bad.offenses[0]).toMatchObject({
      path: 'locales/en.default.json',
      severity: 'error',
      line: 3,
    })
    await t.writeFile('locales/en.default.json', '{"general":{"cart":"Bag"}}\n')
    expect((await t.check()).errors).toBe(0)

    // 推未发布：第一次推到起底时复制出来的那一份上、改成人起的名字；预览链接 + 改了哪些文件
    const pushed = await t.push({ name: 'Rovella 首页 v1', request: request() })
    expect(pushed.theme_id).toBe(init.copy.theme_id)
    expect(pushed.theme_name).toBe('Rovella 首页 v1')
    expect(pushed.preview_url).toBe(`https://${SHOP}?preview_theme_id=${pushed.theme_id}`)
    expect(pushed.changed_files).toEqual([
      'locales/en.default.json',
      'templates/index.json',
      'templates/page.json',
    ])
    expect(previews).toEqual([
      { matter: 'mat_1', url: pushed.preview_url, label: 'Rovella 首页 v1' },
    ])
    expect(cli.themes().find((x) => x.id === pushed.theme_id)).toMatchObject({
      role: 'unpublished',
      name: 'Rovella 首页 v1',
    })
    // 同名再推：更新同一份，不在店里堆一份又一份
    const again = await t.push({ name: 'Rovella 首页 v1' })
    expect(again.theme_id).toBe(pushed.theme_id)
    expect(cli.themes()).toHaveLength(2)
    const pushArgs = cli
      .calls()
      .filter((c) => c.argv[1] === 'push')
      .map((c) => c.argv)
    expect(pushArgs).toEqual([
      ['theme', 'push', '--theme', pushed.theme_id, '--json'],
      ['theme', 'push', '--theme', pushed.theme_id, '--json'],
    ])
    // 推的是主题那几个目录：根上的目录文件不会进店里
    const remoteFiles = Object.keys(cli.themes().find((x) => x.id === pushed.theme_id)?.files ?? {})
    expect(remoteFiles).toContain('templates/index.json')
    expect(remoteFiles).not.toContain('CATALOG.json')
    // 换个名字再推：照老规矩另推一份未发布主题
    const v2 = await t.push({ name: 'Rovella 首页 v2' })
    expect(v2.theme_id).not.toBe(pushed.theme_id)
    expect(cli.themes()).toHaveLength(3)

    // 发布：只出卡，卡上写清「将把主题 X 设为线上主题」与改了哪些文件；一次 publish 都没跑
    const out = await t.proposePublish({ theme_id: pushed.theme_id, request: request() })
    expect(out.status).toBe('staged')
    expect(publishes()).toEqual([])
    const card = staged[0] as StageInput
    expect(card.kind).toBe('publish_theme')
    expect(card.level).toBe('L1')
    expect(card.approval.title).toBe('将把主题「Rovella 首页 v1」设为线上主题')
    expect(card.approval.summary).toContain('从「Horizon」换成「Rovella 首页 v1」')
    expect(card.approval.summary).toContain('templates/index.json')
    expect(card.before).toEqual({ theme_id: '100001', theme_name: 'Horizon' })
    expect(card.after).toMatchObject({
      theme_id: pushed.theme_id,
      store: SHOP,
      preview_url: pushed.preview_url,
      files: pushed.changed_files,
    })

    // 批了：执行器调 apply → 真跑 `theme publish --theme <id> --force`
    const change = {
      id: 'chg_1',
      workspace_id: WS,
      kind: 'publish_theme',
      after: card.after,
    } as unknown as StagedChange
    const applied = await t.apply(change)
    expect(applied).toMatchObject({
      status: 'ok',
      outcome_ref: { type: 'theme', id: pushed.theme_id },
    })
    expect(publishes()).toEqual([['theme', 'publish', '--theme', pushed.theme_id, '--force']])
    expect(cli.themes().find((x) => x.id === pushed.theme_id)?.role).toBe('main')
    // 别的品牌 / 别的 kind 不归它
    expect(await t.apply({ ...change, workspace_id: 'ws_other' } as StagedChange)).toBeUndefined()
    expect(await t.apply({ ...change, kind: 'listing_edit' } as StagedChange)).toBeUndefined()
  })

  it('子进程环境走白名单：凭据只在 CLI 自己的会话里，我们的秘密一个都不传', async () => {
    const t = make()
    await t.setStore(SHOP)
    await t.initFromBase({})
    await t.push({ name: 'v1' })
    for (const c of cli.calls()) {
      expect(c.env).not.toContain('AGENTSWS_SECRETS_KEY')
      expect(c.env).not.toContain('OOMOL_CONNECT_ADMIN_TOKEN')
      expect(c.env).not.toContain('SHOPIFY_CLI_THEME_TOKEN')
      expect(c.env).toContain('SHOPIFY_FLAG_STORE')
      // 主题命令跑在本品牌那一份 CLI 会话里（决定 138：不同品牌可以是不同的 Shopify 账号）
      expect(c.home).toBe(join(dir, 'sessions', WS))
      expect(c.appdata).toBe(join(dir, 'sessions', WS, 'AppData', 'Roaming'))
    }
  })

  it('线上已经是这一份 / 没推过的 id：发布卡提不出去', async () => {
    const t = make()
    await t.setStore(SHOP)
    expect((await t.proposePublish({ theme_id: '100001', request: request() })).status).toBe(
      'blocked',
    )
    expect((await t.proposePublish({ theme_id: '999', request: request() })).message).toContain(
      '没有 999',
    )
    expect(staged).toEqual([])
  })

  it('WP418（自查 A5）：店里本来就有、没在工坊里推过预览的主题（如太老的 Classic 2019）不许直接发上线', async () => {
    const t = make()
    await t.setStore(SHOP)
    cli.setThemes([
      { id: '100001', name: 'Horizon', role: 'main', files: { ...FAKE_HORIZON_FILES } },
      { id: '100009', name: 'Classic 2019', role: 'unpublished', files: {} },
    ])
    const out = await t.proposePublish({ theme_id: '100009', request: request() })
    expect(out.status).toBe('blocked')
    expect(out.message).toContain('不是在工坊里推的预览')
    expect(staged).toEqual([])
  })

  it('WP418（自查 A5）：卡出来之后线上主题被人换过 → 不发；发完读回它真成了线上主题才算好', async () => {
    const t = make()
    await t.setStore(SHOP)
    await t.initFromBase({})
    const pushed = await t.push({ name: 'Rovella 首页 v1' })
    const out = await t.proposePublish({ theme_id: pushed.theme_id, request: request() })
    expect(out.status).toBe('staged')
    const card = staged[0] as StageInput
    const change = {
      id: 'chg_1',
      workspace_id: WS,
      kind: 'publish_theme',
      before: { theme_id: '100777', theme_name: '别人换上去的' },
      after: card.after,
    } as unknown as StagedChange
    const stale = await t.apply(change)
    expect(stale).toMatchObject({ status: 'failed' })
    expect(stale?.error?.message).toContain('线上主题被换过')
    expect(cli.calls().filter((c) => c.argv[1] === 'publish')).toEqual([])
    const ok = await t.apply({ ...change, before: card.before } as StagedChange)
    expect(ok).toMatchObject({ status: 'ok' })
    // 读回：发完又列了一次主题
    const lists = cli.calls().filter((c) => c.argv[1] === 'list')
    expect(lists.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Horizon 起底与工作目录的边界（WP301）', () => {
  const other = {
    id: '100001',
    name: 'Dawn',
    role: 'main',
    files: {
      'config/settings_schema.json':
        '[{"name":"theme_info","theme_name":"Dawn","theme_version":"15.0.0"}]',
    },
  }

  it('线上不是 Horizon：找店里已加的 Horizon（后台改了显示名也认得出）；一份都没有就请人从主题商店加，工作目录不动', async () => {
    const t = make()
    await t.setStore(SHOP)
    cli.setThemes([other])
    await expect(t.initFromBase({})).rejects.toThrow(
      /还没有 Shopify 官方的 Horizon.*主题商店免费添加 Horizon/,
    )
    expect((await t.files()).files).toEqual([])
    expect(cli.calls().filter((c) => c.argv[1] === 'duplicate')).toEqual([])
    cli.setThemes([
      other,
      { id: '100002', name: 'Spring sale', role: 'unpublished', files: { ...FAKE_HORIZON_FILES } },
    ])
    const init = await t.initFromBase({})
    expect(init.source).toEqual({ theme_id: '100002', name: 'Spring sale', live: false })
    expect(init.copy.name).toBe('Spring sale 草稿 10-07')
    // 线上那一份一个字节没动
    expect(cli.themes().find((x) => x.id === '100001')).toMatchObject({
      role: 'main',
      name: 'Dawn',
    })
  })

  it('店里主题满了：说人话；目录有东西不覆盖，replace 挪开不删', async () => {
    const t = make()
    await t.setStore(SHOP)
    cli.setThemes(
      [{ id: '100001', name: 'Horizon', role: 'main', files: { ...FAKE_HORIZON_FILES } }],
      1,
    )
    await expect(t.initFromBase({})).rejects.toThrow(/主题满了/)
    cli.setThemes([
      { id: '100001', name: 'Horizon', role: 'main', files: { ...FAKE_HORIZON_FILES } },
    ])
    await t.initFromBase({})
    await expect(t.initFromBase({})).rejects.toThrow(/已经有东西/)
    await t.writeFile('templates/page.keep.json', '{}')
    const again = await t.initFromBase({ replace: true })
    expect(again.moved_aside).toBe(true)
    expect(again.legacy_moved).toBeUndefined()
    expect((await t.files()).files).not.toContain('templates/page.keep.json')
    // 挪开的那一份还在（不删），而且不在 themes/<ws>/ 下（变更审阅只认那一层的店铺目录）
    const aside = join(dir, 'data', 'theme-work', WS, 'aside')
    expect(
      readFileSync(join(aside, readdirFirst(aside), 'templates', 'page.keep.json'), 'utf8'),
    ).toBe('{}')
    // 探测 / 暂存目录用完就删（只删自己建的那几个）
    for (const scratch of ['probe', 'staging'])
      expect(readdirSync(join(dir, 'data', 'theme-work', WS, scratch))).toEqual([])
  })

  it('复制出来了但没拉成：工作目录不动；再起底接着用那一份，不在店里再堆一份', async () => {
    const t = make()
    await t.setStore(SHOP)
    cli.setLoggedOut(false)
    // 复制成功之后 CLI 会话过期（拉不下来）
    const first = t.initFromBase({})
    // 等复制那一步跑完再把会话弄过期：用 calls 轮询
    for (let i = 0; i < 200 && !cli.calls().some((c) => c.argv[1] === 'duplicate'); i++)
      await new Promise((r) => setTimeout(r, 10))
    cli.setLoggedOut(true)
    await expect(first).rejects.toThrow()
    expect((await t.files()).files).toEqual([])
    cli.setLoggedOut(false)
    const init = await t.initFromBase({})
    expect(cli.calls().filter((c) => c.argv[1] === 'duplicate')).toHaveLength(1)
    expect(cli.themes()).toHaveLength(2)
    expect(init.copy.theme_id).toBe(cli.themes()[1]?.id)
  })

  it('越界写 / 读一律拒：..、绝对路径、隐藏目录、链接', async () => {
    const t = make()
    await t.setStore(SHOP)
    await t.initFromBase({})
    for (const bad of [
      '../x.liquid',
      '/etc/passwd',
      'templates/../../x.json',
      '.git/config',
      'C:/x.json',
    ])
      await expect(t.writeFile(bad, 'x')).rejects.toThrow(/不在主题工作目录里|出了主题工作目录/)
    await expect(t.readFile('../../site-theme.json')).rejects.toThrow(/出了主题工作目录/)
    writeFileSync(join(dir, 'outside.json'), '{}')
    symlinkSync(join(dir, 'outside.json'), join(themeDir(), 'templates', 'custom-link.json'))
    await expect(t.writeFile('templates/custom-link.json', 'x')).rejects.toThrow(/外面/)
    // 指向目录里面的链接也不碰（写下去会改到另一个文件）
    symlinkSync(
      join(themeDir(), 'templates', 'index.json'),
      join(themeDir(), 'templates', 'custom-in.json'),
    )
    await expect(t.writeFile('templates/custom-in.json', 'x')).rejects.toThrow(/链接/)
    symlinkSync(dir, join(themeDir(), 'templates', 'escape'))
    await expect(t.writeFile('templates/escape/custom-y.json', 'x')).rejects.toThrow(/外面/)
    expect(readFileSync(join(dir, 'outside.json'), 'utf8')).toBe('{}')
  })

  it('商店层文件规矩（只对 Horizon 起底的目录生效）；changedFiles 认新增 / 改动 / 删除', () => {
    expect(baseWritable('templates/index.json')).toBe(true)
    expect(baseWritable('templates/customers/account.json')).toBe(true)
    expect(baseWritable('templates/gift_card.liquid')).toBe(false)
    expect(baseWritable('sections/footer-group.json')).toBe(true)
    expect(baseWritable('sections/custom-hero.liquid')).toBe(false)
    expect(baseWritable('blocks/text.liquid')).toBe(false)
    expect(baseWritable('config/settings_data.json')).toBe(true)
    expect(baseWritable('config/settings_schema.json')).toBe(false)
    expect(baseWritable('locales/de.json')).toBe(true)
    expect(baseWritable('locales/de.schema.json')).toBe(false)
    expect(baseWritable('assets/base.css')).toBe(false)
    expect(changedFiles({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual(['b', 'c'])
    expect(changedFiles({ a: '1', b: '2' }, { a: '1' })).toEqual(['b'])
    expect(HORIZON_BASE.repo).toBe('Shopify/horizon')
  })
})

describe('没装 / 没登录（工具回人话 + needs，不跑 CLI）', () => {
  it('没装：推、列、检查都不起子进程，回「去岗位页点一键安装」', async () => {
    const exec = createThemeToolExecutor({ module: async () => t })
    const t = make()
    await t.setStore(SHOP)
    machine.installed = false
    for (const name of ['theme_list', 'theme_check', 'theme_push_unpublished']) {
      const res = await exec({ name, input: { name: 'x' }, request: request() })
      expect(res.status).toBe('error')
      expect(res.reason).toContain('一键安装')
      expect(res.data).toEqual({ needs: 'install_cli' })
    }
    expect(cli.calls()).toEqual([])
  })

  it('没登录：要碰店铺的拦下（检查照跑）；CLI 自己说会话过期也翻成「去登录」', async () => {
    const exec = createThemeToolExecutor({ module: async () => t })
    const t = make()
    await t.setStore(SHOP)
    await t.initFromBase({})
    machine.loggedIn = false
    const push = await exec({
      name: 'theme_push_unpublished',
      input: { name: 'v1' },
      request: request(),
    })
    expect(push.data).toEqual({ needs: 'login' })
    expect((await exec({ name: 'theme_check', input: {}, request: request() })).status).toBe('ok')
    machine.loggedIn = true
    cli.setLoggedOut(true)
    const list = await exec({ name: 'theme_list', input: {}, request: request() })
    expect(list).toMatchObject({ status: 'error', data: { needs: 'login' } })
    expect(list.reason).toContain('登录 Shopify')
  })

  it('执行器：只认网页模板；越界写是 blocked；发布回的是卡不是结果', async () => {
    const t = make()
    await t.setStore(SHOP)
    await t.initFromBase({})
    const exec = createThemeToolExecutor({ module: async () => t })
    for (const role of ['site.shopify-build', 'dtc.support', 'common.owner'])
      expect(
        (await exec({ name: 'theme_publish', input: { theme_id: '1' }, request: request(role) }))
          .status,
      ).toBe('blocked')
    const out = await exec({
      name: 'theme_write_file',
      input: { path: '../escape.liquid', content: 'x' },
      request: request(),
    })
    expect(out.status).toBe('blocked')
    const pushed = await exec({
      name: 'theme_push_unpublished',
      input: { name: 'v1' },
      request: request(),
    })
    const id = (pushed.data as { theme_id: string }).theme_id
    const pub = await exec({ name: 'theme_publish', input: { theme_id: id }, request: request() })
    expect(pub.data).toMatchObject({ status: 'staged', kind: 'publish_theme', change_id: 'chg_1' })
    expect(publishes()).toEqual([])
  })
})

function readdirFirst(d: string): string {
  return readdirSync(d)[0] ?? ''
}
