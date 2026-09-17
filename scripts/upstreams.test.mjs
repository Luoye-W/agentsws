/**
 * `upstreams.yml` 与哨兵脚本的用例（WP91）。
 *
 * 全部不出网：解析、形状校验、锁的版本对账、版本号比较、报告渲染都是纯函数。
 * 真正要出网的那两步（npm registry / GitHub API）在 `pnpm upstream:watch --dry-run` 里演练。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { run as runCheck } from './check-upstreams.mjs'
import {
  collectWishlistHits,
  isoWeek,
  parseArgs,
  renderReport,
  selectUpstreams,
} from './upstream-watch.mjs'
import {
  checkPins,
  compareVersions,
  keywordsOf,
  loadUpstreams,
  lockfileVersions,
  parseUpstreamsYaml,
  REPO_ROOT,
  releaseAgeExcludes,
  validateShape,
  versionVerdict,
  wishlistHits,
} from './upstreams-lib.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'upstreams-'))

// ── 仓库里那一份真表 ───────────────────────────────────────────────────────

describe('仓库根的 upstreams.yml', () => {
  const items = loadUpstreams(REPO_ROOT)

  it('形状与锁的版本都对得上（等价于 CI 里的 --check）', () => {
    expect(validateShape(items)).toEqual([])
    expect(checkPins(items, REPO_ROOT)).toEqual([])
    expect(runCheck(['--check'], REPO_ROOT)).toBe(0)
  })

  it('docs/10 §3.1 的五类里，至少 runtime-dep / ported / reference 三类都登记了东西', () => {
    const kinds = new Set(items.map((i) => i.kind))
    expect(kinds.has('runtime-dep')).toBe(true)
    expect(kinds.has('ported')).toBe(true)
    expect(kinds.has('reference')).toBe(true)
  })

  it('派工书点名的上游一个不少', () => {
    const ids = new Set(items.map((i) => i.id))
    for (const id of [
      'dsh',
      'cordis',
      'open-connector',
      'pi-ai',
      'playwright-mcp',
      'mcp-sdk',
      'openclaw-weixin',
      'browser-skill',
      'octop',
      'ego-lite',
      'dsh-im',
      'dsh-experimental',
    ]) {
      expect(ids, `少了 ${id}`).toContain(id)
    }
  })

  it('dsh 锁的就是 dsh-adapter 真装的那一版', () => {
    const dsh = items.find((i) => i.id === 'dsh')
    const pkg = createRequire(import.meta.url)(join(REPO_ROOT, 'packages/dsh-adapter/package.json'))
    expect(dsh.locked_version).toBe(pkg.dependencies['@deepseek-ai/dsh'])
  })

  it('子集解析器与 `yaml` 包解析出来的是同一棵树', async () => {
    // `yaml` 只在 devDependency 那一侧存在，装了才跑这条；它是"子集解析器有没有跑偏"的兜底。
    let parse
    try {
      ;({ parse } = createRequire(join(REPO_ROOT, 'packages/roles/package.json'))('yaml'))
    } catch {
      return
    }
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(join(REPO_ROOT, 'upstreams.yml'), 'utf8')
    expect(parseUpstreamsYaml(text)).toEqual(parse(text).upstreams)
  })
})

// ── 解析器 ─────────────────────────────────────────────────────────────────

describe('YAML 子集解析', () => {
  it('标量 / 流式列表 / 块列表 / 注释 / 布尔', () => {
    const items = parseUpstreamsYaml(
      [
        '# 注释',
        'upstreams:',
        '  - id: a',
        '    kind: runtime-dep',
        '    lockfile_single: false',
        '    watch: [versions, releases]',
        '    wishlist:',
        '      - 第一条',
        "      - '带 # 号的一条'",
        '',
        '  - id: b',
        '    kind: reference   # 行内注释',
        '    watch: []',
      ].join('\n'),
    )
    expect(items).toEqual([
      {
        id: 'a',
        kind: 'runtime-dep',
        lockfile_single: false,
        watch: ['versions', 'releases'],
        wishlist: ['第一条', '带 # 号的一条'],
      },
      { id: 'b', kind: 'reference', watch: [] },
    ])
  })

  it.each([
    ['tab 缩进', 'upstreams:\n\t- id: a'],
    ['缩进不在子集里', 'upstreams:\n   - id: a'],
    ['顶层不是 upstreams', 'other:\n  - id: a'],
    ['字段重复', 'upstreams:\n  - id: a\n    id: b'],
    ['流式列表没闭合', 'upstreams:\n  - watch: [a, b'],
    ['单引号没闭合', "upstreams:\n  - id: 'a"],
    ['块列表没有对应字段', 'upstreams:\n  - id: a\n      - x'],
    ['没有 upstreams:', '# 只有注释\n'],
  ])('看不懂就报错，不硬猜：%s', (_name, text) => {
    expect(() => parseUpstreamsYaml(text)).toThrow()
  })
})

// ── 形状校验 ───────────────────────────────────────────────────────────────

const base = () => ({
  id: 'x',
  kind: 'runtime-dep',
  why: '因为',
  npm: 'pkg',
  locked_version: '1.0.0',
  watch: ['versions'],
})

const shapeOf = (over) => validateShape([{ ...base(), ...over }])

describe('形状校验', () => {
  it('齐全的一条没有问题', () => {
    expect(shapeOf({})).toEqual([])
  })

  it.each([
    ['缺 id', { id: undefined }, '缺 `id`'],
    ['缺 kind', { kind: undefined }, '缺 `kind`'],
    ['缺 why', { why: undefined }, '缺 `why`'],
    ['kind 不在枚举里', { kind: 'runtime' }, '`kind` 只许'],
    ['watch 空', { watch: [] }, '`watch` 不能为空'],
    ['watch 项不认识', { watch: ['version'] }, '不认识的项'],
    ['不认识的字段', { pinned: 'x' }, '不认识的字段 `pinned`'],
    ['id 大写', { id: 'Abc' }, '只许 a-z'],
    ['repo 写法不对', { repo: 'justname' }, 'owner/name'],
    ['三个来源一个都没有', { npm: undefined, repo: undefined, image: undefined }, '至少要有一个'],
    ['versions 却没有 npm', { npm: undefined, repo: 'a/b' }, '就要有 `npm`'],
    ['releases 却没有 repo', { watch: ['versions', 'releases'] }, '就要有 `repo`'],
    ['runtime-dep 没锁版本', { locked_version: undefined }, '要么有 `locked_version`'],
    ['两种锁都写了', { pinned_commit: 'deadbeef' }, '二选一'],
    ['locked_in 却没锁版本', { locked_version: undefined, locked_in: ['a'] }, 'locked_in'],
    ['pin 值不认识', { pin: 'loose' }, '`pin` 只许'],
    ['带 ^ 却没声明例外', { locked_version: '^1.0.0' }, 'allow_caret'],
    ['wishlist 没人盯', { wishlist: ['等一个东西'] }, '没在 `watch` 里盯它'],
    ['盯 wishlist 却是空的', { watch: ['versions', 'wishlist'] }, '`wishlist` 是空的'],
    ['列表字段写成标量', { watch: 'versions' }, '要写成列表'],
    ['标量字段写成列表', { npm: ['a'] }, '要写成标量'],
  ])('%s', (_name, over, needle) => {
    const problems = shapeOf(over)
    expect(problems.join('\n')).toContain(needle)
  })

  it('id 重复要报出来', () => {
    expect(validateShape([base(), base()]).join('\n')).toContain('`id` 重复')
  })

  it('空表也算问题', () => {
    expect(validateShape([])).toEqual(['登记表是空的'])
  })
})

// ── 锁的版本对账 ───────────────────────────────────────────────────────────

function fakeRepo(over = {}) {
  const root = tmp()
  mkdirSync(join(root, 'pkg'), { recursive: true })
  writeFileSync(
    join(root, 'pkg/package.json'),
    JSON.stringify({ dependencies: { pkg: over.declared ?? '1.0.0' } }),
  )
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    ['packages:', ...(over.lock ?? ['  pkg@1.0.0:', '    resolution: {}']), 'snapshots:', ''].join(
      '\n',
    ),
  )
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    ['minimumReleaseAgeExclude:', ...(over.exclude ?? ["  - 'pkg@1.0.0'"]), 'packages:', ''].join(
      '\n',
    ),
  )
  return root
}

const pin = (over, repoOver) =>
  checkPins(
    [
      {
        ...base(),
        locked_in: ['pkg/package.json'],
        release_age_prefix: 'pkg',
        ...over,
      },
    ],
    fakeRepo(repoOver),
  )

describe('锁的版本与仓库对账', () => {
  it('三处一致就没问题', () => {
    expect(pin({})).toEqual([])
  })

  it('package.json 写的版本不一样 → 报出来', () => {
    expect(pin({}, { declared: '1.0.1' }).join('\n')).toContain('声明的是 `1.0.1`')
  })

  it('package.json 用了范围而没声明例外 → 报出来（docs/42 红线 3）', () => {
    expect(pin({}, { declared: '^1.0.0' }).join('\n')).toContain('用了范围')
  })

  it('声明了 allow_caret 的范围放行', () => {
    expect(pin({ pin: 'allow_caret' }, { declared: '^1.0.0' })).toEqual([])
  })

  it('lockfile 里解析出两个版本 → 报出来', () => {
    const problems = pin({}, { lock: ['  pkg@1.0.0:', '  pkg@2.0.0:'] })
    expect(problems.join('\n')).toContain('解析出多个版本')
  })

  it('lockfile 里的版本和登记表不一样 → 报出来', () => {
    expect(pin({}, { lock: ['  pkg@2.0.0:'] }).join('\n')).toContain('登记表写的是 1.0.0')
  })

  it('minimumReleaseAgeExclude 里留着旧版本 → 报出来', () => {
    const problems = pin({}, { exclude: ["  - 'pkg@1.0.0'", "  - 'pkg-extra@0.9.0'"] })
    expect(problems.join('\n')).toContain('不是登记表的 1.0.0')
  })

  it('locked_in / covered_by 指到不存在的路径 → 报出来', () => {
    const problems = pin({ locked_in: ['nope/package.json'], covered_by: ['nope.ts'] })
    expect(problems.join('\n')).toContain('locked_in 指向不存在的文件')
    expect(problems.join('\n')).toContain('covered_by 指向不存在的路径')
  })

  it('package.json 里压根没依赖这个包 → 报出来', () => {
    expect(pin({ npm: 'other' }, {}).join('\n')).toContain('根本没有依赖')
  })
})

describe('lockfile / workspace 的两个小解析', () => {
  it('lockfileVersions 只看 packages: 段，不看 snapshots:', () => {
    const text = [
      'packages:',
      "  '@a/b@1.0.0':",
      "  '@a/b@2.0.0(x@1)':",
      '  c@3.0.0:',
      'snapshots:',
      "  '@a/b@9.9.9':",
      '',
    ].join('\n')
    expect(lockfileVersions(text, '@a/b')).toEqual(['1.0.0', '2.0.0'])
    expect(lockfileVersions(text, 'c')).toEqual(['3.0.0'])
    expect(lockfileVersions(text, 'nope')).toEqual([])
  })

  it('releaseAgeExcludes 拆得开作用域包名里的 @', () => {
    const text = [
      'minimumReleaseAgeExclude:',
      "  - '@a/b@1.2.3'",
      '  - c@4.5.6',
      'other:',
      '',
    ].join('\n')
    expect(releaseAgeExcludes(text)).toEqual([
      { name: '@a/b', version: '1.2.3' },
      { name: 'c', version: '4.5.6' },
    ])
  })
})

// ── 版本号 ─────────────────────────────────────────────────────────────────

describe('版本号比较与结论', () => {
  it('正式版比预发布版大', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.6-alpha.1', '0.1.5-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.5-rc.2', '0.1.5-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('dsh 的真实处境：我们锁在 alpha 上，latest 反而更旧 → ahead，不是 behind', () => {
    const v = versionVerdict('0.1.6-alpha.1', ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1'])
    expect(v.state).toBe('current')
    expect(versionVerdict('0.1.6-alpha.1', ['0.1.5-rc.1']).state).toBe('ahead')
  })

  it('候选只取 dist-tags，不取整张版本表（表里躺着早年的试验号）', () => {
    // @playwright/mcp 的版本表里有 1.52.0-alpha-…，但 dist-tags 指着 0.0.81
    const all = ['1.52.0-alpha-2025-03-13', '0.0.80', '0.0.81']
    expect(versionVerdict('0.0.80', ['0.0.81'], all).highest).toBe('0.0.81')
    expect(versionVerdict('0.0.80', ['0.0.81'], all).state).toBe('behind')
  })

  it('锁的版本不在上游版本表里也看得出来', () => {
    expect(versionVerdict('9.9.9', ['1.0.0'], ['1.0.0']).lockedIsKnown).toBe(false)
    expect(versionVerdict('1.0.0', ['1.0.0'], ['1.0.0']).lockedIsKnown).toBe(true)
  })

  it('一个候选都没有就说不知道，不瞎猜', () => {
    expect(versionVerdict('1.0.0', []).state).toBe('unknown')
  })
})

// ── wishlist ───────────────────────────────────────────────────────────────

describe('wishlist 命中', () => {
  const item = { wishlist: ['amazon_sp_api provider', '能进群 / 能拉同事'] }

  it('英文与中文都能命中', () => {
    expect(wishlistHits(item, 'Added amazon_sp_api provider support')).toEqual([
      'amazon_sp_api provider',
    ])
    expect(wishlistHits(item, '现在能进群了')).toEqual(['能进群 / 能拉同事'])
  })

  it('不相干的文字不命中', () => {
    expect(wishlistHits(item, 'fix a typo in the readme')).toEqual([])
    expect(wishlistHits({}, 'anything')).toEqual([])
  })

  it('停用词不当关键词（否则每条 release notes 都"命中"）', () => {
    expect(keywordsOf('support for the thing')).not.toContain('the')
  })
})

// ── 报告渲染（纯函数）──────────────────────────────────────────────────────

const obs = (over = {}) => ({
  id: 'dsh',
  item: {
    id: 'dsh',
    kind: 'runtime-dep',
    why: '运行时本体',
    npm: '@deepseek-ai/dsh',
    locked_version: '0.1.6-alpha.1',
    watch: ['versions'],
  },
  errors: [],
  hits: [],
  ...over,
})

const opts = {
  scope: 'weekly',
  windowDays: 7,
  now: new Date('2026-09-17T00:00:00Z'),
}

describe('报告', () => {
  it('周报标题带 ISO 周号（同一周去重就靠它）', () => {
    expect(isoWeek(new Date('2026-09-17T00:00:00Z'))).toBe('2026-W38')
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/)
    expect(renderReport([obs()], opts)).toContain('# 上游周报 2026-W38')
  })

  it('每个上游一节，末尾一段"给评估例程的提示"', () => {
    const md = renderReport([obs()], opts)
    expect(md).toContain('## dsh · runtime-dep')
    expect(md).toContain('## 给评估例程的提示')
    expect(md).toContain('没有任何东西被改、被装、被合并')
  })

  it('有新版就写进提示，并点名"先在当前代码树重采基线"（docs/42 ①）', () => {
    const md = renderReport(
      [obs({ npm: { verdict: { state: 'behind', highest: '0.1.7-alpha.1' }, distTags: {} } })],
      opts,
    )
    expect(md).toContain('**上游有更新的版本**')
    expect(md).toContain('先在当前代码树重采基线')
  })

  it('锁的比 latest 新时不喊"落后"，而是提醒"升到 latest 是降级"', () => {
    const md = renderReport(
      [obs({ npm: { verdict: { state: 'ahead', highest: '0.1.5-rc.1' }, distTags: {} } })],
      opts,
    )
    expect(md).toContain('是降级')
    expect(md).not.toContain('**上游有更新的版本**')
  })

  it('查不到就如实写"查不到"，并注明"查不到 ≠ 没变"', () => {
    const md = renderReport([obs({ errors: ['GitHub meta：403'] })], opts)
    expect(md).toContain('查不到的部分')
    expect(md).toContain('查不到 ≠ 没变')
  })

  it('wishlist 命中要带出处链接', () => {
    const md = renderReport(
      [obs({ hits: [{ wish: '出现渠道 seam', where: 'release v2', url: 'https://x/1' }] })],
      opts,
    )
    expect(md).toContain('**wishlist 命中**')
    expect(md).toContain('[release v2](https://x/1)')
  })

  it('镜像写 latest 就每周念一遍"这等于没锁"（docs/42 §4 第 2 条）', () => {
    const it0 = { ...obs().item, image: 'ghcr.io/x/y', image_tag: 'latest' }
    expect(renderReport([{ ...obs(), item: it0 }], opts)).toContain('**这等于没锁**')
    const pinned = { ...it0, image_tag: 'sha-1234' }
    expect(renderReport([{ ...obs(), item: pinned }], opts)).not.toContain('**这等于没锁**')
  })

  it('daily 的标题是每日检查，不是周报', () => {
    expect(renderReport([obs()], { ...opts, scope: 'daily' })).toContain('每日 dsh 检查')
  })
})

describe('命令行与选表', () => {
  it('默认 weekly 全量，--scope daily 只剩 dsh', () => {
    const items = [{ id: 'dsh' }, { id: 'octop' }]
    expect(selectUpstreams(items, parseArgs([])).length).toBe(2)
    expect(selectUpstreams(items, parseArgs(['--scope', 'daily'])).map((i) => i.id)).toEqual([
      'dsh',
    ])
    expect(selectUpstreams(items, parseArgs(['--only', 'octop'])).map((i) => i.id)).toEqual([
      'octop',
    ])
  })

  it.each([['--scope', 'hourly'], ['--window-days', '0'], ['--nope'], ['--out']])(
    '参数不对就报错：%s %s',
    (...argv) => {
      expect(() => parseArgs(argv.filter(Boolean))).toThrow()
    },
  )

  it('collectWishlistHits 只看窗口内的 release', () => {
    const item = { wishlist: ['browser-use 转正'] }
    const o = {
      gh: {
        releases: [
          { tag: 'v1', name: 'browser-use 转正', body: '', fresh: false, url: 'u1' },
          { tag: 'v2', name: 'browser-use 转正了', body: '', fresh: true, url: 'u2' },
        ],
      },
    }
    expect(collectWishlistHits(item, o).map((h) => h.where)).toEqual(['release v2'])
  })
})
