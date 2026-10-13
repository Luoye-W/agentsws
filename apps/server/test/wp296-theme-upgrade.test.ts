/**
 * WP296：起过底的工作目录碰上新版 agentsws-theme（v0.9.2 → v0.10.0，breaking）。
 *
 * 钉住的事：
 * - 旧版工作目录 → 工具回话照实说一句（这份是 vA、新版 vB 要迁移）+ 出**一张**「升级到 vB（会跑迁移）」卡；
 *   **不自动改**：工作目录一个字节不动、新版包一次都没下；
 * - 卡批了才升：旧目录整份留作备份 → 核心文件换新版 → 店铺内容（改过的模板、custom-*、settings_data）带上、
 *   locales 合 → 跑主题自带的迁移脚本（真子进程）→ 起底版本记成新版；
 * - 不升 → 一天内不再出卡；迁移脚本跑不成 → 工作目录不动，事项里照实记一句。
 *
 * 两份起底包都是这里现造的假包（`fakeThemeBase`），迁移脚本是这里现写的几行（不是真主题的拷贝）。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ApprovalItem, platformKitOf, type RunRequest } from '@agentsws/contracts'
import { renderThemeAnswer, upgradeOf } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSiteTheme, type SiteThemeAssembly } from '../src/site-theme.js'
import { FAKE_THEME_FILES, fakeThemeBase } from '../src/site-theme-stand-in.js'
import {
  isThemeUpgradeCard,
  mergeLocale,
  overlayStoreFiles,
  parseMigrateOutput,
  storeOwned,
  versionOlder,
} from '../src/site-theme-upgrade.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'

const SHOP = 'rollout-test.myshopify.com'
const WS = 'ws_rollout'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

/** 旧版（v0.9.2 那样）：公开的 product-title 块。 */
const OLD_FILES: Record<string, string> = {
  ...FAKE_THEME_FILES,
  'AGENTS.md': '# AGENTS.md (0.9.2 fixture)\n',
  'templates/product.json':
    '{"sections":{"main":{"type":"main-product","blocks":{"t":{"type":"product-title"}}}},"order":["main"]}\n',
  'blocks/product-title.liquid': 'old core block\n',
  'locales/en.default.schema.json': '{"sections":{"hero":{"name":"Hero"}},"old_label":"Old"}\n',
}

/** 新版（v0.10.0 那样）：块改私有 `_product-title`，带一个迁移脚本。 */
const MIGRATE = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "import { join, dirname } from 'node:path'",
  "import { fileURLToPath } from 'node:url'",
  "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')",
  'const changed = []',
  "for (const rel of ['templates/product.json', 'templates/index.json']) {",
  "  const text = readFileSync(join(ROOT, rel), 'utf8')",
  '  const out = text.replaceAll(\'"type":"product-title"\', \'"type":"_product-title"\')',
  '  if (out !== text) { writeFileSync(join(ROOT, rel), out); changed.push(rel) }',
  '}',
  "console.log(changed.length ? 'Updated ' + changed.length + ' file(s):\\n' + changed.map((c) => '  - ' + c).join('\\n') : 'Nothing to migrate.')",
  'console.log(\'\\nNeeds a person:\\n  - templates/product.json: main → "x" (map) is not accepted there any more; move or remove it by hand.\')',
  '',
].join('\n')

const NEW_FILES: Record<string, string> = {
  ...FAKE_THEME_FILES,
  'AGENTS.md': '# AGENTS.md (0.10.0 fixture)\n',
  'templates/product.json':
    '{"sections":{"main":{"type":"main-product","blocks":{"t":{"type":"_product-title"}}}},"order":["main"]}\n',
  'templates/product.quick-view.json': '{"sections":{},"order":[]}\n',
  'blocks/_product-title.liquid': 'new private block\n',
  'locales/en.default.schema.json':
    '{"sections":{"hero":{"name":"Image banner"}},"fragments":{"frame":"Section frame"}}\n',
  'scripts/migrate-blocks.mjs': MIGRATE,
}

const OLD = fakeThemeBase(OLD_FILES, { version: '0.9.2', commit: `${'9'.repeat(39)}2` })
const NEW = fakeThemeBase(NEW_FILES, { version: '0.10.0', commit: `${'a'.repeat(39)}0` })

let dir: string
let cards: ApprovalItem[]
let notes: { matter: string; text: string }[]
let now: string

const request = (): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_owner', assignment_id: 'asg_theme', role_id: 'site.shopify-theme' },
    work_item: { id: 'mat_1', conversation_id: 'mat_1', role_id: 'site.shopify-theme' },
  }) as unknown as RunRequest

function make(
  base: ReturnType<typeof fakeThemeBase>,
  extra: { runNode?: Parameters<typeof createSiteTheme>[0]['runNode'] } = {},
): SiteThemeAssembly {
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => now },
    dataDir: join(dir, 'data'),
    settingsFile: join(dir, 'data', 'brand', 'site-theme.json'),
    cliSpec: () => spec,
    probe: async () => ({ installed: true, node_ok: true, min_node_major: 20, checked_at: now }),
    loggedIn: () => true,
    invocation: () => ({ command: 'shopify', prefix: [] }),
    connectedShops: () => [],
    fetch: base.fetch,
    base: base.pin,
    ledger: { stage: async () => ({ ok: false, message: 'no' }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    approvals: () => ({
      create: async (input: never) => {
        const item = {
          ...(input as object),
          id: `apv_${cards.length + 1}`,
          state: 'pending',
        } as unknown as ApprovalItem
        cards.push(item)
        return item as never
      },
    }),
    noteMatter: (matter, text) => notes.push({ matter, text }),
    ...extra,
  })
}

const themeDir = (): string => join(dir, 'data', 'themes', WS, SHOP)
const read = (rel: string): string => readFileSync(join(themeDir(), rel), 'utf8')
const decided = (item: ApprovalItem, state: ApprovalItem['state']): ApprovalItem =>
  ({ ...item, state, workspace_id: WS }) as ApprovalItem

/** 用旧版起底，并像人那样改几处（模板、custom 文件、设置、locales）。 */
async function startOnOldBase(): Promise<void> {
  const old = make(OLD)
  await old.setStore(SHOP)
  await old.initFromBase({})
  await old.writeFile(
    'templates/product.json',
    '{"sections":{"main":{"type":"main-product","blocks":{"t":{"type":"product-title"},"note":{"type":"custom-note"}}}},"order":["main"]}\n',
  )
  await old.writeFile('blocks/custom-note.liquid', '<p>{{ block.settings.text }}</p>\n')
  await old.writeFile('config/settings_data.json', '{"current":{"colors":"mine"}}\n')
  await old.writeFile(
    'locales/en.default.schema.json',
    '{"sections":{"hero":{"name":"Hero"},"custom-note":{"name":"Note"}},"old_label":"Old"}\n',
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp296-theme-'))
  cards = []
  notes = []
  now = '2026-10-13T09:00:00.000Z'
  NEW.urls.length = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('旧版工作目录：照实说 + 出升级卡，不自动改', () => {
  it('工具回话带一句「这份是 v0.9.2，新版 v0.10.0 要迁移」，只出一张卡，工作目录一个字节不动', async () => {
    await startOnOldBase()
    const before = read('templates/product.json')
    const t = make(NEW)
    const exec = createThemeToolExecutor({ module: async () => t })
    const res = await exec({ name: 'theme_files', input: {}, request: request() })
    expect(res.status).toBe('ok')
    const notice = (res.data as { base_upgrade?: { message: string; from: string; to: string } })
      .base_upgrade
    expect(notice).toMatchObject({ from: '0.9.2', to: '0.10.0' })
    expect(notice?.message).toContain('这份主题是 v0.9.2，新版 v0.10.0 要迁移')
    expect(notice?.message).toContain('升级到 v0.10.0（会跑迁移）')
    // 卡：upstream_upgrade，挂在这件事上，写清从哪版到哪版、哪家店
    expect(cards).toHaveLength(1)
    const card = cards[0] as ApprovalItem
    expect(card.kind).toBe('upstream_upgrade')
    expect(card.title).toBe('升级到 v0.10.0（会跑迁移）')
    expect(card.subject.matter_id).toBe('mat_1')
    expect(card.payload).toMatchObject({
      upstream_id: 'agentsws-theme',
      from: '0.9.2',
      to: '0.10.0',
      classification: 'breaking',
      store: SHOP,
    })
    expect(isThemeUpgradeCard(card)).toBe(true)
    // 再调几次：照样说，但不再出卡；出错的回话把这一句接在后面
    await exec({ name: 'theme_read_file', input: { path: 'AGENTS.md' }, request: request() })
    const bad = await exec({
      name: 'theme_read_file',
      input: { path: 'nope.md' },
      request: request(),
    })
    expect(bad.status).toBe('error')
    expect(bad.reason).toContain('新版 v0.10.0 要迁移')
    expect(cards).toHaveLength(1)
    // 不自动改：新版包一次都没下，文件原样，起底版本还是 0.9.2
    expect(NEW.urls).toEqual([])
    expect(read('templates/product.json')).toBe(before)
    expect(read('AGENTS.md')).toContain('0.9.2')
    expect((await t.readiness()).workspace.base?.version).toBe('0.9.2')
  })

  it('新版起底的、没起过底的：什么都不说', async () => {
    const t = make(NEW)
    await t.setStore(SHOP)
    expect(await t.baseUpgrade(request())).toBeUndefined()
    await t.initFromBase({})
    expect(await t.baseUpgrade(request())).toBeUndefined()
    expect(cards).toEqual([])
  })
})

describe('人点了升级卡才升', () => {
  it('批了：旧目录整份备份 → 核心换新版、店铺内容带上、locales 合 → 跑迁移 → 记成 v0.10.0', async () => {
    await startOnOldBase()
    const t = make(NEW)
    await t.baseUpgrade(request())
    await t.onUpgradeDecided(decided(cards[0] as ApprovalItem, 'approved'))
    // 核心文件：新版
    expect(read('AGENTS.md')).toContain('0.10.0')
    expect(existsSync(join(themeDir(), 'blocks', '_product-title.liquid'))).toBe(true)
    expect(existsSync(join(themeDir(), 'blocks', 'product-title.liquid'))).toBe(false)
    expect(existsSync(join(themeDir(), 'templates', 'product.quick-view.json'))).toBe(true)
    // 店铺内容带上，并被迁移脚本改成新写法
    expect(read('templates/product.json')).toContain('"type":"_product-title"')
    expect(read('templates/product.json')).toContain('"type":"custom-note"')
    expect(read('blocks/custom-note.liquid')).toContain('block.settings.text')
    expect(read('config/settings_data.json')).toContain('mine')
    // locales：新版为底 + custom 的键；新版删掉的键不带回来
    const schema = JSON.parse(read('locales/en.default.schema.json')) as Record<string, unknown>
    expect(schema).toMatchObject({
      sections: { hero: { name: 'Image banner' }, 'custom-note': { name: 'Note' } },
      fragments: { frame: 'Section frame' },
    })
    expect(schema.old_label).toBeUndefined()
    // 备份：旧的一份原样留着
    const backups = readdirSync(join(dir, 'data', 'theme-work', WS, 'backup'))
    expect(backups).toHaveLength(1)
    const backup = join(dir, 'data', 'theme-work', WS, 'backup', backups[0] as string)
    expect(readFileSync(join(backup, 'AGENTS.md'), 'utf8')).toContain('0.9.2')
    expect(readFileSync(join(backup, 'templates', 'product.json'), 'utf8')).toContain(
      '"type":"product-title"',
    )
    // 暂存目录收拾干净
    expect(readdirSync(join(dir, 'data', 'theme-work', WS, 'upgrade'))).toEqual([])
    // 记成新版；事项里一句人话；不再提示
    expect((await t.readiness()).workspace.base?.version).toBe('0.10.0')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.text).toMatch(/主题升到 v0\.10\.0 了：迁移改了 1 个文件，1 处要人手动挪/)
    expect(await t.baseUpgrade(request())).toBeUndefined()
    // 「改了哪些文件」相对新版原样那一份：店铺自己的内容算改动
    const s = JSON.parse(readFileSync(join(dir, 'data', 'brand', 'site-theme.json'), 'utf8'))
    expect(s.stores[SHOP].base.version).toBe('0.10.0')
    expect(s.stores[SHOP].upgrades[0]).toMatchObject({ from: '0.9.2', to: '0.10.0', migrated: 1 })
    expect(s.stores[SHOP].upgrade_offer).toBeUndefined()
  })

  it('不升：一天内不再出卡（照样说一句）；过一天再问', async () => {
    await startOnOldBase()
    const t = make(NEW)
    await t.baseUpgrade(request())
    await t.onUpgradeDecided(decided(cards[0] as ApprovalItem, 'rejected'))
    const again = await t.baseUpgrade(request())
    expect(again).toMatchObject({ declined: true })
    expect(again?.message).toContain('先不升')
    expect(cards).toHaveLength(1)
    expect(read('AGENTS.md')).toContain('0.9.2')
    now = '2026-10-14T09:30:00.000Z'
    await t.baseUpgrade(request())
    expect(cards).toHaveLength(2)
  })

  it('迁移脚本跑不成：工作目录一个字节不动、没有备份、事项里照实说', async () => {
    await startOnOldBase()
    const before = read('templates/product.json')
    const t = make(NEW, {
      runNode: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    })
    await t.baseUpgrade(request())
    await t.onUpgradeDecided(decided(cards[0] as ApprovalItem, 'approved'))
    expect(read('templates/product.json')).toBe(before)
    expect(read('AGENTS.md')).toContain('0.9.2')
    expect(existsSync(join(dir, 'data', 'theme-work', WS, 'backup'))).toBe(false)
    expect(notes[0]?.text).toMatch(/主题没升成：迁移脚本没跑成（退出码 1）.*还是 v0\.9\.2/)
    expect((await t.readiness()).workspace.base?.version).toBe('0.9.2')
  })

  it('卡上的版本与现在钉的不一样：不升，照实说', async () => {
    await startOnOldBase()
    const t = make(NEW)
    await t.baseUpgrade(request())
    const card = cards[0] as ApprovalItem
    await t.onUpgradeDecided({
      ...decided(card, 'approved'),
      payload: { ...(card.payload as object), to: '0.11.0' },
    } as ApprovalItem)
    expect(notes[0]?.text).toContain('卡上是 v0.11.0，现在钉的是 v0.10.0')
    expect(read('AGENTS.md')).toContain('0.9.2')
  })
})

describe('stub 剧本也照实说', () => {
  it('工具回话里的 base_upgrade → 回话第一句：是旧版、出了升级卡、这次先用旧版做', async () => {
    await startOnOldBase()
    const t = make(NEW)
    const exec = createThemeToolExecutor({ module: async () => t })
    const res = await exec({ name: 'theme_files', input: {}, request: request() })
    const up = upgradeOf(res.data)
    expect(up).toMatchObject({ from: '0.9.2', to: '0.10.0' })
    const text = renderThemeAnswer({ ...(up === undefined ? {} : { upgrade: up }), failed: {} })
    expect(text.split('\n')[0]).toBe(
      '这份主题是 v0.9.2，新版 v0.10.0 要迁移。出了一张卡「升级到 v0.10.0（会跑迁移）」，你点了我才升（升之前自动备份）。这次先用 v0.9.2 做。',
    )
    expect(renderThemeAnswer({ failed: {} })).toBe('这次没动主题。')
  })
})

describe('纯计算', () => {
  it('versionOlder 按三段数字比（0.9.2 < 0.10.0）', () => {
    expect(versionOlder('0.9.2', '0.10.0')).toBe(true)
    expect(versionOlder('0.10.0', '0.10.0')).toBe(false)
    expect(versionOlder('0.10.1', '0.10.0')).toBe(false)
    expect(versionOlder('0.0.0-fixture', '0.0.0-fixture')).toBe(false)
  })

  it('storeOwned 与 baseWritable 同一张表（locales 另算）', () => {
    expect(storeOwned('templates/index.json')).toBe(true)
    expect(storeOwned('sections/header-group.json')).toBe(true)
    expect(storeOwned('config/settings_data.json')).toBe(true)
    expect(storeOwned('blocks/custom-x.liquid')).toBe(true)
    expect(storeOwned('blocks/_custom-x.liquid')).toBe(true)
    expect(storeOwned('blocks/heading.liquid')).toBe(false)
    expect(storeOwned('locales/en.default.json')).toBe(false)
    expect(storeOwned('config/settings_schema.json')).toBe(false)
  })

  it('mergeLocale：店面文案保留改过的句子；编辑器标签只带 custom 的键', () => {
    const up = '{"cart":{"title":"Cart"},"new":{"k":"N"}}'
    const mine = '{"cart":{"title":"Your bag"},"gone":"x","custom_note":{"t":"Hi"}}'
    expect(JSON.parse(mergeLocale('locales/en.default.json', up, mine) ?? '')).toEqual({
      cart: { title: 'Your bag' },
      new: { k: 'N' },
      custom_note: { t: 'Hi' },
    })
    expect(JSON.parse(mergeLocale('locales/en.default.schema.json', up, mine) ?? '')).toEqual({
      cart: { title: 'Cart' },
      new: { k: 'N' },
      custom_note: { t: 'Hi' },
    })
    expect(mergeLocale('locales/x.json', up, 'not json')).toBeUndefined()
  })

  it('overlayStoreFiles：没改过的用新版、改过的带上、人删掉的照旧删', () => {
    const h = (b: Buffer): string => b.toString('utf8')
    const oldFs: Record<string, string> = {
      'templates/index.json': 'same',
      'templates/page.json': 'edited',
      'blocks/custom-a.liquid': 'a',
      'blocks/heading.liquid': 'old core',
    }
    const newFs: Record<string, string> = {
      'templates/index.json': 'new index',
      'templates/page.json': 'new page',
      'templates/gone.json': 'upstream',
      'blocks/heading.liquid': 'new core',
    }
    const plan = overlayStoreFiles({
      oldFiles: Object.keys(oldFs),
      newHas: (rel) => rel in newFs,
      readOld: (rel) => Buffer.from(oldFs[rel] ?? ''),
      readNew: (rel) => Buffer.from(newFs[rel] ?? ''),
      write: (rel, b) => {
        newFs[rel] = String(b)
      },
      remove: (rel) => {
        delete newFs[rel]
      },
      hash: h,
      baseline: {
        'templates/index.json': 'same',
        'templates/page.json': 'orig',
        'templates/gone.json': 'x',
        'blocks/heading.liquid': 'old core',
      },
    })
    expect(plan).toEqual({
      kept: ['blocks/custom-a.liquid', 'templates/page.json'],
      merged: [],
      removed: ['templates/gone.json'],
      manual: [],
    })
    expect(newFs).toEqual({
      'templates/index.json': 'new index',
      'templates/page.json': 'edited',
      'blocks/heading.liquid': 'new core',
      'blocks/custom-a.liquid': 'a',
    })
  })

  it('parseMigrateOutput：改了哪些、哪几处要人', () => {
    const out = [
      'Updated 2 file(s):',
      '  - templates/index.json (3 changes)',
      '  - sections/footer-group.json (1 change)',
      '',
      'Needs a person:',
      '  - templates/page.json: main → "m" (map) is not accepted there any more; move or remove it by hand.',
    ].join('\n')
    expect(parseMigrateOutput(out)).toEqual({
      updated: ['templates/index.json (3 changes)', 'sections/footer-group.json (1 change)'],
      manual: [
        'templates/page.json: main → "m" (map) is not accepted there any more; move or remove it by hand.',
      ],
    })
    expect(parseMigrateOutput('Nothing to migrate.')).toEqual({ updated: [], manual: [] })
  })
})
