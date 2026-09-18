/**
 * WP95（`docs/upstream/sidebar-compare.md` #11）：变更审阅的逐文件 diff。
 *
 * 三组：
 * 1. **真跑一次 git**（临时目录里起一个真仓库，改几个文件）——列表、增删行数、diff 正文；
 * 2. **官方借来的三条约束**：私有 index（仓库的 `.git/index` 一个字节不动）、
 *    环境清洗（本进程的秘密一个都不传给子进程）、行对比超时**降级成粗粒度**而不是卡住；
 * 3. **取不到不是错误**：没有仓库、找不到副本目录，都回一句人话。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StagedChange } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeFiles, storeOfChange } from '../src/change-files.js'

const CHANGE = {
  id: 'chg_1',
  workspace_id: 'ws_1',
  kind: 'publish_theme',
  after: { theme_id: '123', command: 'shopify theme publish --theme 123 --store shop' },
} as unknown as StagedChange

let dataDir: string
let root: string

/** 在临时目录里起一个真 git 仓（用户名邮箱走命令行，不碰这台机器的 gitconfig）。 */
function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
    stdio: 'ignore',
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentsws-change-files-'))
  root = join(dataDir, 'themes', 'ws_1', 'shop')
  mkdirSync(root, { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'x@example.com'])
  git(['config', 'user.name', 'x'])
  writeFileSync(join(root, 'sections'), '', 'utf8')
  rmSync(join(root, 'sections'))
  mkdirSync(join(root, 'sections'))
  writeFileSync(join(root, 'sections', 'header.liquid'), '<h1>旧标题</h1>\n', 'utf8')
  writeFileSync(join(root, 'README.md'), '主题副本\n', 'utf8')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('真跑一次 git', () => {
  it('改一个文件 + 加一个没跟踪的新文件，两个都列得出来', async () => {
    writeFileSync(join(root, 'sections', 'header.liquid'), '<h1>新标题</h1>\n', 'utf8')
    writeFileSync(join(root, 'sections', 'hero.liquid'), '<section>hero</section>\n', 'utf8')

    const view = await changeFiles(CHANGE, { dataDir })
    expect(view.available).toBe(true)
    expect(view.store).toBe('shop')
    const paths = view.files.map((f) => f.path).sort()
    expect(paths).toEqual(['sections/header.liquid', 'sections/hero.liquid'])

    const header = view.files.find((f) => f.path === 'sections/header.liquid')
    expect(header?.status).toBe('modified')
    expect(header?.additions).toBe(1)
    expect(header?.deletions).toBe(1)
    expect(header?.diff).toContain('+<h1>新标题</h1>')
    expect(header?.diff).toContain('-<h1>旧标题</h1>')

    // 没跟踪的新文件也算进来了（主题里加一个 section 就是这种）
    const hero = view.files.find((f) => f.path === 'sections/hero.liquid')
    expect(hero?.status).toBe('added')
    expect(hero?.additions).toBe(1)
  })

  it('什么都没改的时候是一张空表，不是一句错误', async () => {
    const view = await changeFiles(CHANGE, { dataDir })
    expect(view.available).toBe(true)
    expect(view.files).toEqual([])
  })

  it('**只读**：跑完之后仓库的 `.git/index` 一个字节没动（私有 index 那条约束）', async () => {
    const indexPath = join(root, '.git', 'index')
    const before = readFileSync(indexPath)
    const mtimeBefore = statSync(indexPath).mtimeMs
    writeFileSync(join(root, 'sections', 'hero.liquid'), '<section>hero</section>\n', 'utf8')

    await changeFiles(CHANGE, { dataDir })

    expect(readFileSync(indexPath).equals(before)).toBe(true)
    expect(statSync(indexPath).mtimeMs).toBe(mtimeBefore)
    // 而且那个新文件仍然是"没跟踪"的（我们没有真的 add 它）
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    expect(status).toContain('?? sections/hero.liquid')
  })
})

describe('官方借来的三条约束', () => {
  it('子进程的环境是清洗过的：本进程的秘密一个都不传，git 的三个开关都关死', async () => {
    vi.stubEnv('AGENTSWS_SECRETS_KEY', '这串东西不该出现在子进程里')
    const seen: NodeJS.ProcessEnv[] = []
    await changeFiles(CHANGE, {
      dataDir,
      runGit: (_args, opts) => {
        seen.push(opts.env)
        return Promise.resolve({ ok: true, stdout: '', timedOut: false })
      },
    })
    expect(seen.length).toBeGreaterThan(0)
    for (const env of seen) {
      expect(env.AGENTSWS_SECRETS_KEY).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBe('0')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
      // 私有 index：指着一个临时文件，不是仓库那一份
      expect(env.GIT_INDEX_FILE).toBeDefined()
      expect(env.GIT_INDEX_FILE).not.toBe(join(root, '.git', 'index'))
    }
  })

  it('单个文件的行对比超时 → 降级成粗粒度（标 coarse），不把整张表卡住', async () => {
    const view = await changeFiles(CHANGE, {
      dataDir,
      runGit: (args) => {
        const joined = args.join(' ')
        if (joined.includes('--numstat'))
          return Promise.resolve({
            ok: true,
            stdout: '900\t880\tassets/theme.css\n1\t1\tsections/header.liquid\n',
            timedOut: false,
          })
        if (joined.includes('--name-status'))
          return Promise.resolve({
            ok: true,
            stdout: 'M\tassets/theme.css\nM\tsections/header.liquid\n',
            timedOut: false,
          })
        if (joined.includes('rev-parse'))
          return Promise.resolve({ ok: true, stdout: 'deadbeef\n', timedOut: false })
        // 那个大文件超时，另一个照常
        if (joined.includes('assets/theme.css'))
          return Promise.resolve({ ok: false, stdout: '', timedOut: true })
        return Promise.resolve({
          ok: true,
          stdout: '@@ -1 +1 @@\n-旧\n+新\n',
          timedOut: false,
        })
      },
    })
    const big = view.files.find((f) => f.path === 'assets/theme.css')
    expect(big?.coarse).toBe(true)
    expect(big?.additions).toBe(900)
    expect(big?.diff).toBe('')
    // 降级的只有那一个；另一个仍然有逐行对比
    const small = view.files.find((f) => f.path === 'sections/header.liquid')
    expect(small?.coarse).toBe(false)
    expect(small?.diff).toContain('+新')
  })

  it('二进制文件只报"改了"，不塞正文进来', async () => {
    const view = await changeFiles(CHANGE, {
      dataDir,
      runGit: (args) => {
        const joined = args.join(' ')
        if (joined.includes('--numstat'))
          return Promise.resolve({ ok: true, stdout: '-\t-\tassets/logo.png\n', timedOut: false })
        if (joined.includes('--name-status'))
          return Promise.resolve({ ok: true, stdout: 'M\tassets/logo.png\n', timedOut: false })
        return Promise.resolve({ ok: true, stdout: '', timedOut: false })
      },
    })
    expect(view.files[0]?.binary).toBe(true)
    expect(view.files[0]?.diff).toBe('')
  })
})

describe('取不到不是错误', () => {
  it('副本目录不是 git 仓：回一句人话，不是 500', async () => {
    rmSync(join(root, '.git'), { recursive: true, force: true })
    const view = await changeFiles(CHANGE, { dataDir })
    expect(view.available).toBe(false)
    expect(view.detail).toContain('git')
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('这台机器上根本没有这家店的副本', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'agentsws-empty-'))
    try {
      const view = await changeFiles({ ...CHANGE, after: {} } as unknown as StagedChange, {
        dataDir: empty,
      })
      expect(view.available).toBe(false)
      expect(view.files).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('这条变更对着哪家店（三级兜底）', () => {
  it('① after.store 说了算', () => {
    expect(
      storeOfChange({ ...CHANGE, after: { store: '甲店' } } as unknown as StagedChange, dataDir),
    ).toBe('甲店')
  })

  it('② 没写就从命令里认 --store', () => {
    expect(storeOfChange(CHANGE, dataDir)).toBe('shop')
  })

  it('③ 都没有、而这个工作区底下只有一家店：就是它', () => {
    expect(storeOfChange({ ...CHANGE, after: {} } as unknown as StagedChange, dataDir)).toBe('shop')
  })

  it('③ 有好几家店就不猜（猜错了人看的是别家店的 diff）', () => {
    mkdirSync(join(dataDir, 'themes', 'ws_1', 'shop2'), { recursive: true })
    expect(
      storeOfChange({ ...CHANGE, after: {} } as unknown as StagedChange, dataDir),
    ).toBeUndefined()
  })
})
