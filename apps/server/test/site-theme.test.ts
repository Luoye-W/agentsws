/**
 * WP253：建站岗位的主题工坊（服务端那一半）。
 *
 * 假 `shopify` 是**真脚本、真子进程**（`<node> <入口> theme …`，与 WP245 私有安装同一个起法）；
 * 起底包是内存里造的最小假 agentsws-theme（`site-theme-stand-in.ts`），不联网、不碰任何真店。
 *
 * 钉住的事：起底（校验、LICENSE、旧目录挪开不删）/ 拉 / 检查 / 看改文件（出不去、核心文件不许改）/
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
import {
  baseWritable,
  changedFiles,
  createSiteTheme,
  type SiteThemeAssembly,
  THEME_BASE,
  themeBaseUrl,
} from '../src/site-theme.js'
import { fakeThemeBase } from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'
import { type FakeShopifyTheme, writeFakeShopifyTheme } from './fixtures/fake-shopify-theme.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SHOP = '6suegp-md.myshopify.com'
const WS = 'ws_rollout'
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

function make(
  overrides: { fetch?: ReturnType<typeof fakeThemeBase>['fetch'] } = {},
): SiteThemeAssembly {
  const base = fakeThemeBase()
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
    connectedShops: () => machine.shops,
    env: { ...process.env, AGENTSWS_SECRETS_KEY: 'never-leaks', OOMOL_CONNECT_ADMIN_TOKEN: 'x' },
    fetch: overrides.fetch ?? base.fetch,
    base: base.pin,
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
    const r = await t.setStore('https://admin.shopify.com/store/6suegp-md/themes')
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

describe('起底 → 改 → 检查 → 推未发布 → 发布出卡 → 批了才执行', () => {
  it('一整条（假 CLI 是真子进程）', async () => {
    const t = make()
    await t.setStore(SHOP)
    const init = await t.initFromBase({})
    expect(init.files).toBeGreaterThan(5)
    expect(init.base.license).toBe('MIT')
    // LICENSE 原样带上；工作目录与终端沙箱 / 变更审阅同一个地方
    expect(readFileSync(join(themeDir(), 'LICENSE'), 'utf8')).toContain('MIT License')
    expect((await t.files()).files).toEqual(
      expect.arrayContaining(['AGENTS.md', 'LICENSE', 'templates/index.json']),
    )
    expect((await t.readFile('AGENTS.md')).content).toContain('custom-*')

    // 改：只许 custom-* / templates / locales / settings_data
    await t.writeFile('sections/custom-hero.liquid', '<section>Rollout</section>\n')
    await t.writeFile(
      'templates/index.json',
      '{"sections":{"h":{"type":"custom-hero"}},"order":["h"]}\n',
    )
    await expect(t.writeFile('sections/hero.liquid', 'x')).rejects.toThrow(/核心文件/)
    await expect(t.writeFile('assets/app.css', 'x')).rejects.toThrow(/核心文件/)
    await expect(t.writeFile('README.md', 'x')).rejects.toThrow(/只许写主题那几个目录/)

    // 检查：有 error 时退出码非零，但那是结论
    await t.writeFile('sections/custom-bad.liquid', '{% broken %}\n')
    const bad = await t.check()
    expect(bad.errors).toBe(1)
    expect(bad.offenses[0]).toMatchObject({
      path: 'sections/custom-bad.liquid',
      severity: 'error',
      line: 3,
    })
    await t.writeFile('sections/custom-bad.liquid', '<p>ok</p>\n')
    expect((await t.check()).errors).toBe(0)

    // 推未发布：预览链接 + 改了哪些文件；进事项时间线
    const pushed = await t.push({ name: 'Rollout 首页 v1', request: request() })
    expect(pushed.preview_url).toBe(`https://${SHOP}?preview_theme_id=${pushed.theme_id}`)
    expect(pushed.changed_files).toEqual([
      'sections/custom-bad.liquid',
      'sections/custom-hero.liquid',
      'templates/index.json',
    ])
    expect(previews).toEqual([
      { matter: 'mat_1', url: pushed.preview_url, label: 'Rollout 首页 v1' },
    ])
    expect(cli.themes().find((x) => x.id === pushed.theme_id)?.role).toBe('unpublished')
    // 同名再推：更新同一份，不在店里堆一份又一份
    const again = await t.push({ name: 'Rollout 首页 v1' })
    expect(again.theme_id).toBe(pushed.theme_id)
    expect(cli.themes()).toHaveLength(2)
    const pushArgs = cli
      .calls()
      .filter((c) => c.argv[1] === 'push')
      .map((c) => c.argv)
    expect(pushArgs[0]).toContain('--unpublished')
    expect(pushArgs[1]).toEqual(['theme', 'push', '--theme', pushed.theme_id, '--json'])

    // 发布：只出卡，卡上写清「将把主题 X 设为线上主题」与改了哪些文件；一次 publish 都没跑
    const out = await t.proposePublish({ theme_id: pushed.theme_id, request: request() })
    expect(out.status).toBe('staged')
    expect(publishes()).toEqual([])
    const card = staged[0] as StageInput
    expect(card.kind).toBe('publish_theme')
    expect(card.level).toBe('L1')
    expect(card.approval.title).toBe('将把主题「Rollout 首页 v1」设为线上主题')
    expect(card.approval.summary).toContain('从「Horizon」换成「Rollout 首页 v1」')
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
})

describe('起底包与工作目录的边界', () => {
  it('校验不过一个文件都不放；网络断了说人话；目录有东西不覆盖，replace 挪开不删', async () => {
    const t = make({
      fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    })
    await t.setStore(SHOP)
    await expect(t.initFromBase({})).rejects.toThrow(/校验没过/)
    expect((await t.files()).files).toEqual([])
    const offline = make({
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND codeload.github.com')
      },
    })
    await expect(offline.initFromBase({})).rejects.toThrow(/下不来开源主题/)

    const ok = make()
    await ok.initFromBase({})
    await expect(ok.initFromBase({})).rejects.toThrow(/已经有东西/)
    await ok.writeFile('templates/custom-x.json', '{}')
    const again = await ok.initFromBase({ replace: true })
    expect(again.moved_aside).toBe(true)
    expect((await ok.files()).files).not.toContain('templates/custom-x.json')
    // 挪开的那一份还在（不删），而且不在 themes/<ws>/ 下（变更审阅只认那一层的店铺目录）
    const aside = join(dir, 'data', 'theme-work', WS, 'aside')
    expect(
      readFileSync(join(aside, readdirFirst(aside), 'templates', 'custom-x.json'), 'utf8'),
    ).toBe('{}')
  })

  it('GitHub 下不动 / 校验不对：用随包带的那份兜底（校验同一个）；兜底那份也不对就照实报错；下不来时原目录不动', async () => {
    const base = fakeThemeBase()
    const local = join(dir, 'bundled')
    mkdirSync(local)
    const file = join(local, `agentsws-theme-${base.pin.commit}.tgz`)
    const offline = async (): Promise<never> => {
      throw new Error('getaddrinfo ENOTFOUND codeload.github.com')
    }
    const mk = () =>
      createSiteTheme({
        workspace_id: WS,
        clock: { now: () => T0 },
        dataDir: join(dir, 'data'),
        cliSpec: () => spec,
        probe: async () => ({ installed: true, node_ok: true, min_node_major: 20, checked_at: T0 }),
        loggedIn: () => true,
        invocation: () => ({ command: process.execPath, prefix: [cli.entry] }),
        connectedShops: () => [SHOP],
        fetch: offline,
        base: base.pin,
        localBaseDir: local,
        ledger: { stage: async () => ({ ok: false, reason: 'guardrail', message: 'x' }) },
        effectiveConfig: () => ({}) as never,
      })
    // 兜底那份不对：照实说下不来，一个文件都不放
    writeFileSync(file, 'not a tarball')
    await expect(mk().initFromBase({})).rejects.toThrow(/下不来开源主题/)
    // 兜底那份对：用它起底
    writeFileSync(file, base.tgz)
    const t = mk()
    expect((await t.initFromBase({})).files).toBeGreaterThan(5)
    // replace 时下不来 → 原目录一个字节不动
    rmSync(file)
    await t.writeFile('templates/custom-keep.json', '{}')
    await expect(t.initFromBase({ replace: true })).rejects.toThrow(/下不来/)
    expect(readFileSync(join(themeDir(), 'templates', 'custom-keep.json'), 'utf8')).toBe('{}')
  })

  it('钉子只在 theme-base-pin.json 一处：tag / commit / sha256 / MIT', () => {
    expect(THEME_BASE.tag).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(THEME_BASE.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(THEME_BASE.license).toBe('MIT')
    expect(THEME_BASE.version).toBe(THEME_BASE.tag.slice(1))
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

  it('核心文件规矩只对 agentsws-theme 起底的目录生效；changedFiles 认新增 / 改动 / 删除', () => {
    expect(baseWritable('blocks/custom-badges.liquid')).toBe(true)
    expect(baseWritable('blocks/_custom-item.liquid')).toBe(true)
    expect(baseWritable('blocks/badges.liquid')).toBe(false)
    expect(baseWritable('sections/footer-group.json')).toBe(true)
    expect(baseWritable('config/settings_schema.json')).toBe(false)
    expect(changedFiles({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual(['b', 'c'])
    expect(changedFiles({ a: '1', b: '2' }, { a: '1' })).toEqual(['b'])
    expect(themeBaseUrl()).toBe(
      `https://codeload.github.com/Luoye-W/agentsws-theme/tar.gz/${THEME_BASE.commit}`,
    )
    expect(THEME_BASE.sha256).toMatch(/^[0-9a-f]{64}$/)
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
