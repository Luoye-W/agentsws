/**
 * `upstreams.yml` 与哨兵脚本的用例（WP91）。
 *
 * 全部不出网：解析、形状校验、锁的版本对账、版本号比较、报告渲染都是纯函数。
 * 真正要出网的那两步（npm registry / GitHub API）在 `pnpm upstream:watch --dry-run` 里演练。
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { run as runCheck } from './check-upstreams.mjs'
import {
  collectWishlistHits,
  isoWeek,
  parseArgs,
  parseImage,
  renderReport,
  selectUpstreams,
} from './upstream-watch.mjs'
import {
  binReleaseVerdict,
  checkBinLock,
  checkImagePins,
  checkNpmLock,
  checkPinFile,
  checkPins,
  checkRuntimeLock,
  compareVersions,
  findImageRefs,
  imageVerdict,
  keywordsOf,
  lineCandidates,
  loadUpstreams,
  lockfileVersions,
  parseUpstreamsYaml,
  REPO_ROOT,
  releaseAgeExcludes,
  stableImageTags,
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
      // WP144：电脑操控的两个官方包与驱动
      'dsh-computer-use',
      'dsh-experimental-computer-use-cua-driver-mcp',
      'cua-driver',
      // WP146（Luoye 09-24：引用的开源项目都要进每周评估）
      'tremor-raw',
      'shadcn-ui',
      'simple-icons',
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

  // WP171：Luoye 自己的私有仓库（BtoBAgents）只登记来源与提交，不 watch 公网
  it('私有来源：watch 空、不写 repo / npm / image、钉提交，就没问题', () => {
    const priv = {
      id: 'private-one',
      kind: 'ported',
      why: '私有仓库搬过来的业务代码',
      private_source: '本机 ~/Documents/x',
      pinned_commit: 'abc1234',
      watch: [],
    }
    expect(validateShape([priv])).toEqual([])
    expect(validateShape([{ ...priv, watch: ['readme'] }]).join('\n')).toContain(
      '`watch` 要写成 []',
    )
    expect(validateShape([{ ...priv, repo: 'a/b' }]).join('\n')).toContain(
      '不写 npm / repo / image',
    )
    expect(validateShape([{ ...priv, pinned_commit: undefined }]).join('\n')).toContain(
      'pinned_commit',
    )
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

// ── 镜像钉版本（WP146）─────────────────────────────────────────────────────

const IMG = 'ghcr.io/o/connector'
const DIG = `sha256:${'a'.repeat(64)}`
const imgItem = (over = {}) => ({
  id: 'oc',
  kind: 'runtime-dep',
  why: '连接器',
  image: IMG,
  image_tag: 'v1.2.3',
  image_digest: DIG,
  image_in: ['compose.yml'],
  repo: 'o/connector',
  pinned_commit: 'x',
  watch: ['releases'],
  ...over,
})
const imgRepo = (files) => {
  const root = tmp()
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text)
  return root
}

describe('镜像钉版本：check-upstreams 对账 image_in（WP146）', () => {
  const good = `image: ${IMG}:v1.2.3@${DIG}\n`

  it('每一处都逐字等于 tag@digest → 没问题；光秃秃的仓库名不算引用', () => {
    const root = imgRepo({ 'compose.yml': `# 起一个 \`${IMG}\` 容器\n${good}` })
    expect(checkImagePins(imgItem(), root)).toEqual([])
  })

  it.each([
    ['digest 被改', `image: ${IMG}:v1.2.3@sha256:${'b'.repeat(64)}\n`],
    ['退回 latest', `image: ${IMG}:latest\n`],
    ['只写 tag 不写 digest', `image: ${IMG}:v1.2.3\n`],
    ['tag 对不上', `image: ${IMG}:v1.2.4@${DIG}\n`],
  ])('%s → 报出来', (_name, text) => {
    const problems = checkImagePins(imgItem(), imgRepo({ 'compose.yml': text }))
    expect(problems.join('\n')).toContain('登记表锁的是')
  })

  it('文件里压根没引用 / 文件不存在 → 报出来', () => {
    expect(checkImagePins(imgItem(), imgRepo({ 'compose.yml': 'nothing\n' })).join('\n')).toContain(
      '没有引用',
    )
    expect(checkImagePins(imgItem({ image_in: ['nope.yml'] }), tmp()).join('\n')).toContain(
      '不存在的文件',
    )
  })

  it('findImageRefs 认得 tag、digest、两者都有', () => {
    expect(findImageRefs(`${IMG}:v1 ${IMG}@${DIG} ${IMG}:v2@${DIG} ${IMG}.`, IMG)).toEqual([
      `${IMG}:v1`,
      `${IMG}@${DIG}`,
      `${IMG}:v2@${DIG}`,
    ])
  })

  it.each([
    ['runtime-dep 的镜像写 latest', { image_tag: 'latest' }, '不许 `latest`'],
    ['runtime-dep 的镜像没锁 digest', { image_digest: undefined }, '`image_digest`'],
    ['digest 格式不对', { image_digest: 'sha256:xyz' }, '64 位十六进制'],
    ['runtime-dep 的镜像没写 image_in', { image_in: undefined }, '`image_in`'],
  ])('形状：%s', (_name, over, needle) => {
    expect(validateShape([imgItem(over)]).join('\n')).toContain(needle)
  })

  it('仓库里那一份：open-connector 锁的是正式版 tag + digest，不是 latest', () => {
    const oc = loadUpstreams(REPO_ROOT).find((i) => i.id === 'open-connector')
    expect(oc.image_tag).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(oc.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(oc.image_in).toEqual(
      expect.arrayContaining([
        'docker-compose.yml',
        'scripts/dev-real.sh',
        'packages/connect-adapter/test/record-fixtures.test.ts',
      ]),
    )
  })

  it('验收：把真 docker-compose.yml 里的 digest 改坏一位，`--check` 就红', () => {
    // 仓库根整份软链进临时目录，只把 compose 换成改坏的那一份
    const root = tmp()
    for (const e of readdirSync(REPO_ROOT)) {
      if (e === '.git' || e === 'docker-compose.yml') continue
      symlinkSync(join(REPO_ROOT, e), join(root, e))
    }
    const real = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8')
    writeFileSync(join(root, 'docker-compose.yml'), real)
    expect(runCheck(['--check'], root)).toBe(0)
    const broken = real.replace(/(open-connector:[^@\s]+@sha256:)([0-9a-f])/, (_m, head, c) =>
      head.concat(c === '0' ? '1' : '0'),
    )
    expect(broken).not.toBe(real)
    writeFileSync(join(root, 'docker-compose.yml'), broken)
    expect(runCheck(['--check'], root)).toBe(1)
  })
})

describe('镜像与二进制的"落后没有"（纯函数）', () => {
  it('正式版只认 vX.Y.Z，commit 短哈希 / latest / rc 不算', () => {
    expect(stableImageTags(['latest', '6d23b13', 'v1.6.5', 'v1.7.0-rc.1', '1.2.3'])).toEqual([
      'v1.6.5',
      '1.2.3',
    ])
  })

  it('按 semver 取最高（v1.10.0 > v1.9.9），不按字符串', () => {
    const v = imageVerdict({ lockedTag: 'v1.9.9', lockedDigest: DIG, tags: ['v1.9.9', 'v1.10.0'] })
    expect(v).toMatchObject({ state: 'behind', highest: 'v1.10.0', tagMoved: false })
  })

  it('锁的 tag 被上游重打 → tagMoved', () => {
    const v = imageVerdict({
      lockedTag: 'v1.6.5',
      lockedDigest: DIG,
      tags: ['v1.6.5'],
      lockedTagDigest: `sha256:${'c'.repeat(64)}`,
    })
    expect(v).toMatchObject({ state: 'current', tagMoved: true, lockedIsKnown: true })
  })

  it('一个正式版都没有 → unknown，不瞎猜', () => {
    expect(imageVerdict({ lockedTag: 'v1', tags: ['latest'] }).state).toBe('unknown')
  })

  it('二进制：只看带前缀的正式 release（草稿 / 预发布 / 别的前缀都不算）', () => {
    const rel = [
      { tag: 'ext-v0.9.0' },
      { tag: 'cli-v0.4.0', prerelease: true },
      { tag: 'cli-v0.3.1' },
      { tag: 'cli-v0.3.0' },
    ]
    expect(binReleaseVerdict(rel, 'cli-v', '0.3.0')).toEqual({ state: 'behind', highest: '0.3.1' })
    expect(binReleaseVerdict([], 'cli-v', '0.3.0').state).toBe('unknown')
  })

  it('parseImage：ghcr 带主机，Docker Hub 官方镜像补 library/', () => {
    expect(parseImage('ghcr.io/oomol-lab/open-connector')).toEqual({
      registry: 'ghcr.io',
      name: 'oomol-lab/open-connector',
    })
    expect(parseImage('postgres')).toEqual({
      registry: 'registry-1.docker.io',
      name: 'library/postgres',
    })
    // 显式写 docker.io/ 的也要落到 Docker Hub 的 registry API 主机上（new-api 就是这么登记的）
    expect(parseImage('docker.io/calciumion/new-api')).toEqual({
      registry: 'registry-1.docker.io',
      name: 'calciumion/new-api',
    })
  })
})

describe('周报里的镜像一行（WP146）', () => {
  const ocItem = { ...imgItem(), npm: undefined, watch: ['releases'] }
  const ocObs = (image) => ({ id: 'oc', item: ocItem, errors: [], hits: [], image })

  it('锁的就是最新正式版 → 写清 tag 与 digest，"就是最新的"', () => {
    const md = renderReport(
      [ocObs({ tags: 3, verdict: imageVerdict({ lockedTag: 'v1.2.3', tags: ['v1.2.3'] }) })],
      opts,
    )
    expect(md).toContain('锁 `v1.2.3`（`sha256:aaaaaaaa…aaaa`）')
    expect(md).toContain('就是最新的')
  })

  it('有更新的正式版 → 进"有更新版本的"，提示按 docs/42 镜像那一步升', () => {
    const md = renderReport(
      [
        ocObs({
          tags: 3,
          highestDigest: `sha256:${'d'.repeat(64)}`,
          verdict: imageVerdict({ lockedTag: 'v1.2.3', tags: ['v1.2.3', 'v1.3.0'] }),
        }),
      ],
      opts,
    )
    expect(md).toContain('| 有更新版本的 | `oc` |')
    expect(md).toContain('上游最新正式版 `v1.3.0`')
    expect(md).toContain('镜像怎么升')
  })

  it('registry 查不到 → 如实写"查不到"，不省略这一行', () => {
    const md = renderReport(
      [{ ...ocObs({ error: 'tag 表：503' }), errors: ['镜像 registry：503'] }],
      opts,
    )
    expect(md).toContain('上游最新正式版：查不到（tag 表：503）')
    expect(md).toContain('查不到 ≠ 没变')
  })
})

// ── 二进制钉版本：BrowserSkill 的 bsk（WP146 追加）────────────────────────────

const binItem = (over = {}) => ({
  id: 'bsk',
  kind: 'runtime-dep',
  why: '浏览器',
  npm: 'plug',
  repo: 'o/bsk',
  locked_version: '0.3.0',
  bin_version: '0.3.0',
  bin_tag_prefix: 'cli-v',
  bin_lock_file: 'lock.json',
  watch: ['versions', 'releases'],
  ...over,
})
const binLock = (cli, plugin = { name: 'plug', version: '0.3.0' }) =>
  imgRepo({ 'lock.json': JSON.stringify({ cli, plugin }) })

describe('二进制钉版本：check-upstreams 对账 bin_lock_file（WP146）', () => {
  it('cli 与插件两处都对得上 → 没问题', () => {
    expect(checkBinLock(binItem(), binLock({ version: '0.3.0', tag: 'cli-v0.3.0' }))).toEqual([])
  })

  it('lock 文件升了 cli 版本、登记表没跟 → 报出来', () => {
    const p = checkBinLock(binItem(), binLock({ version: '0.3.1', tag: 'cli-v0.3.1' }))
    expect(p.join('\n')).toContain('cli.version 是 `0.3.1`')
  })

  it('只改了 lock 文件里的插件版本（两边没一起升）→ 报出来', () => {
    const p = checkBinLock(
      binItem(),
      binLock({ version: '0.3.0', tag: 'cli-v0.3.0' }, { name: 'plug', version: '0.3.1' }),
    )
    expect(p.join('\n')).toContain('plugin.version 是 `0.3.1`')
  })

  it('tag 与前缀 + 版本对不上 / 文件不存在 → 报出来', () => {
    expect(
      checkBinLock(binItem(), binLock({ version: '0.3.0', tag: 'v0.3.0' })).join('\n'),
    ).toContain('应该是 `cli-v0.3.0`')
    expect(checkBinLock(binItem({ bin_lock_file: 'nope.json' }), tmp()).join('\n')).toContain(
      '不存在的文件',
    )
  })

  it('三项只写了一部分 → 形状报错', () => {
    expect(validateShape([binItem({ bin_lock_file: undefined })]).join('\n')).toContain(
      '要么都写、要么都不写',
    )
  })

  it('仓库里那一份：browser-skill 是 runtime-dep，插件与 bsk 两样都锁、与 browserskill.lock.json 一致', () => {
    const bs = loadUpstreams(REPO_ROOT).find((i) => i.id === 'browser-skill')
    expect(bs.kind).toBe('runtime-dep')
    expect(bs.npm).toBe('@wxg-prc-cpg/browser-skill-dsh-plugin')
    expect(bs.locked_in).toContain('packages/dsh-adapter/package.json')
    expect(bs.bin_lock_file).toBe('browserskill.lock.json')
    expect(checkBinLock(bs, REPO_ROOT)).toEqual([])
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'browserskill.lock.json'), 'utf8'))
    expect(lock.cli.version).toBe(bs.bin_version)
    expect(lock.plugin.version).toBe(bs.locked_version)
  })

  it('周报：bsk 有新的正式 release → 进"有更新版本的"，提示两边一起升', () => {
    const it0 = binItem()
    const md = renderReport(
      [{ id: 'bsk', item: it0, errors: [], hits: [], bin: { state: 'behind', highest: '0.3.1' } }],
      opts,
    )
    expect(md).toContain('| 有更新版本的 | `bsk` |')
    expect(md).toContain('上游最新正式 release `cli-v0.3.1`')
    expect(md).toContain('两边一起改')
  })

  it('周报：releases 查不到 → bsk 那一行写"查不到"', () => {
    const md = renderReport(
      [{ id: 'bsk', item: binItem(), errors: ['x'], hits: [], bin: { error: '403' } }],
      opts,
    )
    expect(md).toContain('上游最新正式 release：查不到（403）')
  })
})

// ── npm 运行时：桌面按需下载的 OpenConnector（WP252 追加）──────────────────────

const npmItem = (over = {}) => ({
  id: 'oc-rt',
  kind: 'runtime-dep',
  why: '本机连接器',
  npm: '@o/rt',
  locked_version: '1.8.0',
  lockfile_single: false,
  npm_lock_file: 'lock.json',
  npm_pin_in: ['pin.ts'],
  watch: ['versions'],
  ...over,
})
const npmLock = (over = {}) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@o/rt': '1.8.0' } },
      'node_modules/@o/rt': {
        version: '1.8.0',
        resolved: 'https://r/rt.tgz',
        integrity: 'sha512-a',
      },
      'node_modules/dep': {
        version: '2.0.0',
        resolved: 'https://r/dep.tgz',
        integrity: 'sha512-b',
      },
      ...over,
    },
  })
const PIN_TS = "export const PIN = { package: '@o/rt', version: '1.8.0' }\n"

describe('npm 运行时钉版本：check-upstreams 对账 npm_lock_file / npm_pin_in（WP252）', () => {
  it('锁文件、代码里的钉版本与登记表三处一致 → 没问题', () => {
    expect(checkNpmLock(npmItem(), imgRepo({ 'lock.json': npmLock(), 'pin.ts': PIN_TS }))).toEqual(
      [],
    )
  })

  it('锁文件重出成了别的版本、登记表没跟 → 报出来', () => {
    const lock = npmLock({
      '': { dependencies: { '@o/rt': '1.9.0' } },
      'node_modules/@o/rt': { version: '1.9.0', resolved: 'x', integrity: 'sha512-a' },
    })
    const p = checkNpmLock(npmItem(), imgRepo({ 'lock.json': lock, 'pin.ts': PIN_TS })).join('\n')
    expect(p).toContain('根依赖 `@o/rt` 是 `1.9.0`')
    expect(p).toContain('解析成 1.9.0')
  })

  it('有包没钉 sha512 → 报出来', () => {
    const lock = npmLock({
      'node_modules/loose': { version: '1.0.0', resolved: 'https://r/l.tgz' },
    })
    expect(
      checkNpmLock(npmItem(), imgRepo({ 'lock.json': lock, 'pin.ts': PIN_TS })).join('\n'),
    ).toContain('没钉 sha512：node_modules/loose')
  })

  it('代码里的钉版本改了、登记表没跟 → 报出来；文件不在也报', () => {
    const p = checkNpmLock(
      npmItem(),
      imgRepo({ 'lock.json': npmLock(), 'pin.ts': PIN_TS.replace('1.8.0', '1.9.0') }),
    )
    expect(p.join('\n')).toContain("没有钉 `'1.8.0'`")
    expect(checkNpmLock(npmItem({ npm_lock_file: 'nope.json' }), tmp()).join('\n')).toContain(
      '不存在的文件：nope.json',
    )
  })

  it('形状：写了 npm_lock_file 却没写 lockfile_single: false / 没有 npm → 报错', () => {
    expect(validateShape([npmItem({ lockfile_single: undefined })]).join('\n')).toContain(
      'lockfile_single: false',
    )
    expect(validateShape([npmItem({ npm: undefined, repo: 'o/rt' })]).join('\n')).toContain(
      '就要有 `npm` 与 `locked_version`',
    )
  })

  it('仓库里那一份：open-connector-runtime 钉的就是 OPEN_CONNECTOR_PIN 与锁文件里那一版', () => {
    const rt = loadUpstreams(REPO_ROOT).find((i) => i.id === 'open-connector-runtime')
    expect(rt.npm).toBe('@oomol-lab/open-connector')
    expect(rt.npm_lock_file).toBe('packages/connect-adapter/src/open-connector-lock.json')
    expect(checkNpmLock(rt, REPO_ROOT)).toEqual([])
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, rt.npm_lock_file), 'utf8'))
    expect(lock.packages['node_modules/@oomol-lab/open-connector'].version).toBe(rt.locked_version)
  })
})

// ── 随包 Node / npm：check-upstreams 对账 node-runtime.lock.json（WP255，决策 145）────────

const SHA = 'a'.repeat(64)
const INTEGRITY = `sha512-${'B'.repeat(86)}==`
const runtimeLock = (over = {}) =>
  JSON.stringify({
    node: {
      version: '22.23.2',
      abi: 127,
      targets: { 'darwin-arm64': { sha256: SHA }, 'win32-x64': { sha256: SHA } },
    },
    npm: {
      version: '10.9.8',
      integrity: INTEGRITY,
      tarball: 'https://registry.npmjs.org/npm/-/npm-10.9.8.tgz',
    },
    ...over,
  })
const nodeItem = (over = {}) => ({
  id: 'node-runtime',
  kind: 'runtime-dep',
  why: '随包 Node',
  repo: 'nodejs/node',
  locked_version: '22.23.2',
  version_line: '22',
  runtime_lock_file: 'lock.json',
  runtime_lock_key: 'node',
  watch: ['releases'],
  ...over,
})
const npmRtItem = (over = {}) => ({
  id: 'npm-runtime',
  kind: 'runtime-dep',
  why: '随包 npm',
  npm: 'npm',
  locked_version: '10.9.8',
  version_line: '10',
  lockfile_single: false,
  runtime_lock_file: 'lock.json',
  runtime_lock_key: 'npm',
  watch: ['versions'],
  ...over,
})

describe('随包 Node / npm：check-upstreams 对账 node-runtime.lock.json（WP255）', () => {
  it('登记表与锁一致 → 没问题（node 每平台 sha256、npm sha512 + registry tgz）', () => {
    const root = imgRepo({ 'lock.json': runtimeLock() })
    expect(checkRuntimeLock(nodeItem(), root)).toEqual([])
    expect(checkRuntimeLock(npmRtItem(), root)).toEqual([])
    expect(validateShape([nodeItem(), npmRtItem()])).toEqual([])
  })

  it('锁里升了 Node、登记表没跟 → 报出来；npm 同理', () => {
    const root = imgRepo({
      'lock.json': runtimeLock({
        node: { version: '22.24.0', abi: 127, targets: { 'darwin-arm64': { sha256: SHA } } },
        npm: {
          version: '10.9.9',
          integrity: INTEGRITY,
          tarball: 'https://registry.npmjs.org/npm/-/npm-10.9.9.tgz',
        },
      }),
    })
    expect(checkRuntimeLock(nodeItem(), root).join('\n')).toContain(
      'node.version 是 `22.24.0`，登记表写的是 `22.23.2`',
    )
    const p = checkRuntimeLock(npmRtItem(), root).join('\n')
    expect(p).toContain('npm.version 是 `10.9.9`，登记表写的是 `10.9.8`')
    expect(p).toContain('npm.tarball 是')
  })

  it('哪个平台没钉 sha256、abi 丢了、npm 的 integrity 不是 sha512 → 逐条报', () => {
    const root = imgRepo({
      'lock.json': runtimeLock({
        node: { version: '22.23.2', targets: { 'linux-x64': { sha256: 'abc' } } },
        npm: { version: '10.9.8', integrity: 'sha1-xyz' },
      }),
    })
    const n = checkRuntimeLock(nodeItem(), root).join('\n')
    expect(n).toContain('node.abi 不是整数')
    expect(n).toContain('node.targets.linux-x64 没钉 sha256')
    expect(checkRuntimeLock(npmRtItem(), root).join('\n')).toContain('不是 registry 那种 sha512')
  })

  it('锁文件不在 / 没有那一段 / 坏 JSON → 报出来', () => {
    expect(checkRuntimeLock(nodeItem({ runtime_lock_file: 'nope.json' }), tmp())).toEqual([
      '[node-runtime] runtime_lock_file 指向不存在的文件：nope.json',
    ])
    const noNpm = imgRepo({ 'lock.json': JSON.stringify({ node: {} }) })
    expect(checkRuntimeLock(npmRtItem(), noNpm).join('\n')).toContain('里没有 `npm` 这一段')
    const bad = imgRepo({ 'lock.json': '{' })
    expect(checkRuntimeLock(nodeItem(), bad).join('\n')).toContain('不是合法的 JSON')
  })

  it('形状：成对字段只写一半、key 写错、版本不在 version_line 上、有 npm 没写 lockfile_single → 报错', () => {
    const p = (o) => validateShape([o]).join('\n')
    expect(p(nodeItem({ runtime_lock_key: undefined }))).toContain('要么都写、要么都不写')
    expect(p(nodeItem({ runtime_lock_key: 'yarn' }))).toContain('只许 node / npm')
    expect(p(nodeItem({ version_line: '24' }))).toContain('不在 `version_line: 24` 这条线上')
    expect(p(nodeItem({ version_line: 'lts' }))).toContain('只写大版本号')
    expect(p(npmRtItem({ lockfile_single: undefined }))).toContain('lockfile_single: false')
  })

  it('周报只拿 version_line 上的正式版比：npm latest 是 11.x 不算落后，10.9.9 出了才算', () => {
    const versions = ['10.9.7', '10.9.8', '11.6.2', '11.7.0-pre.1', '10.10.0-rc.1']
    const line = lineCandidates('10', versions)
    expect(line).toEqual(['10.9.7', '10.9.8'])
    expect(versionVerdict('10.9.8', line, versions).state).toBe('current')
    const newer = [...versions, '10.9.9']
    expect(versionVerdict('10.9.8', lineCandidates('10', newer), newer)).toMatchObject({
      state: 'behind',
      highest: '10.9.9',
    })
  })

  it('仓库里那一份：node-runtime / npm-runtime 与 apps/desktop/node-runtime.lock.json 逐字一致', () => {
    const all = loadUpstreams(REPO_ROOT)
    const node = all.find((i) => i.id === 'node-runtime')
    const npm = all.find((i) => i.id === 'npm-runtime')
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, node.runtime_lock_file), 'utf8'))
    expect(node.locked_version).toBe(lock.node.version)
    expect(npm.locked_version).toBe(lock.npm.version)
    expect(checkRuntimeLock(node, REPO_ROOT)).toEqual([])
    expect(checkRuntimeLock(npm, REPO_ROOT)).toEqual([])
  })
})

// ── 按 tag 钉、运行时下载的上游：agentsws-theme 起底包（WP253）──────────────────

const themeItem = (over = {}) => ({
  id: 'agentsws-theme',
  kind: 'runtime-dep',
  why: '起底主题',
  repo: 'o/theme',
  pinned_tag: 'v0.9.0',
  pinned_commit: 'e'.repeat(40),
  pin_file: 'pin.json',
  watch: ['releases'],
  ...over,
})
const themePin = (over = {}) =>
  JSON.stringify({
    repo: 'o/theme',
    tag: 'v0.9.0',
    commit: 'e'.repeat(40),
    sha256: 'a'.repeat(64),
    ...over,
  })

describe('按 tag 钉的上游：check-upstreams 对账 pin_file（WP253）', () => {
  it('钉子文件与登记表的 repo / tag / commit 一致 → 没问题', () => {
    expect(checkPinFile(themeItem(), imgRepo({ 'pin.json': themePin() }))).toEqual([])
    expect(validateShape([themeItem()])).toEqual([])
  })

  it('只改了钉子文件、没改登记表（或反过来）→ 报出来', () => {
    const p = checkPinFile(
      themeItem(),
      imgRepo({ 'pin.json': themePin({ tag: 'v0.9.1', commit: 'f'.repeat(40) }) }),
    ).join('\n')
    expect(p).toContain('tag 是 `v0.9.1`')
    expect(p).toContain('commit 是')
    expect(
      checkPinFile(themeItem(), imgRepo({ 'pin.json': themePin({ sha256: 'x' }) })).join('\n'),
    ).toContain('sha256')
    expect(checkPinFile(themeItem({ pin_file: 'nope.json' }), tmp()).join('\n')).toContain('不存在')
  })

  it('形状：有 pin_file 就要有 repo 与完整的 pinned_commit', () => {
    expect(validateShape([themeItem({ pinned_commit: 'eed7f57' })]).join('\n')).toContain('40 位')
    expect(validateShape([themeItem({ pinned_commit: undefined })]).join('\n')).toContain(
      'pinned_commit',
    )
  })

  it('仓库里真的那一条：登记表与 theme-base-pin.json 一致', () => {
    const it = loadUpstreams(REPO_ROOT).find((x) => x.id === 'agentsws-theme')
    expect(it?.pin_file).toBe('apps/server/src/theme-base-pin.json')
    expect(checkPinFile(it, REPO_ROOT)).toEqual([])
  })
})
