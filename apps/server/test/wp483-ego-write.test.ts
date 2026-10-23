/**
 * WP483（决策 1658 / 1660）：「在 ego 里发」那只手本身——脚本拼得出、读得懂 ego 的输出、真连一次的探测、
 * 素材落临时文件、岗位上「发之前让我看一眼」的存取。不起 ego、不联网（子进程是注入的假的）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EGO_WRITE_PLATFORMS,
  type EgoWritePlatform,
  egoPostPlatformOf,
  egoReplyPlatformOf,
  egoWriteNext,
  egoWriteSentence,
} from '@agentsws/contracts'
import type { EgoProcessResult } from '@agentsws/dsh-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EGO_ADMIN_SENTENCE,
  type EgoSpawn,
  parseEgoWriteOutput,
  probeEgoConnection,
  runEgoWrite,
} from '../src/ego-write/runner.js'
import { egoSnippet, egoWriteScript } from '../src/ego-write/script.js'
import { createEgoWriter, materializeMedia } from '../src/ego-write/writer.js'
import { createWriteReviewSettings } from '../src/write-review.js'

const proc = (o: Partial<EgoProcessResult>): EgoProcessResult => ({
  exit_code: 0,
  timed_out: false,
  duration_ms: 1200,
  stdout: '',
  stderr: '',
  ...o,
})

/** ego 的 Node 运行时是 ESM、顶层 await；这里只核「拼出来的是一段能解析的 JS」。 */
const parses = (script: string): void => {
  const AsyncFunction = (async () => undefined).constructor as new (body: string) => unknown
  new AsyncFunction(script)
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('WP483 脚本模板', () => {
  it('每一种平台、写 / 读回 / 发与不发，拼出来都是能解析的脚本；CFG 原样带进去（引号、换行、中文、反引号不坏）', () => {
    const text = `第一段 "quoted" \`tick\` \\ back\n第二段 $` + '{not-a-template}'
    for (const platform of EGO_WRITE_PLATFORMS)
      for (const mode of ['write', 'readback'] as const)
        for (const submit of [true, false]) {
          const s = egoWriteScript({
            platform,
            space: '工坊 · 测试',
            mode,
            url: 'https://example.test/x',
            parent: 't1_abc',
            title: 'A title',
            text,
            files: ['/tmp/a.png'],
            submit,
          })
          parses(s)
          const cfg = JSON.parse(s.slice('const CFG = '.length, s.indexOf(';\n')))
          expect(cfg).toMatchObject({ platform, mode, submit, text })
        }
  })

  it('认「发出去的那一条」用草稿开头那一截（去空白、小写、最多 60 字）', () => {
    expect(egoSnippet('  Hello   World\nAgain ')).toBe('hello world again')
    expect(egoSnippet('x'.repeat(100))).toHaveLength(60)
    // 发新帖按标题认
    const s = egoWriteScript({
      platform: 'reddit-post',
      space: 's',
      mode: 'write',
      title: 'My Title',
      text: 'body',
      submit: true,
    })
    expect(s).toContain('"snippet":"my title"')
  })

  it('点发送只在 `CFG.submit` 为真时：脚本里点发送那一下前面有这道判断；不发就把页面留给人（finish keep p1）', () => {
    const s = egoWriteScript({
      platform: 'facebook-post',
      space: 's',
      mode: 'write',
      text: 'hi',
      submit: false,
    })
    expect(s).toContain('if (!CFG.submit) {')
    expect(s).toContain('await end("filled", { button_found: !!sendKey }, ["p1"])')
    // 点过发送就记 clicked（之后不再退插件）
    expect(s).toContain('clicked = true;')
  })

  it('不绕：验证码 / 风控字样、看得见的验证框 → blocked；只加载在页面里的验证脚本不算（WP467）', () => {
    const s = egoWriteScript({
      platform: 'reddit-comment',
      space: 's',
      mode: 'write',
      text: 'hi',
      submit: true,
    })
    expect(s).toContain('recaptcha\\/api2\\/bframe')
    expect(s).toContain('await end("blocked"')
    expect(s).not.toMatch(/solve|bypass/iu)
  })
})

describe('WP483 读懂 ego 的输出', () => {
  it('@@FINAL 那一行原样回；脚本打印过 send-clicked 就记 clicked', () => {
    const r = parseEgoWriteOutput(
      { platform: 'reddit-reply' },
      proc({
        stdout: [
          '@@SPACE 7',
          '@@STEP {"name":"reply-filled","ok":true}',
          '@@STEP {"name":"send-clicked","ok":true}',
          '@@FINAL {"state":"sent","link":"https://www.reddit.com/r/a/comments/p1/x/c9/","external_id":"t1_c9","readback":"link"}',
        ].join('\n'),
      }),
    )
    expect(r).toMatchObject({ state: 'sent', space_id: 7, external_id: 't1_c9', clicked: true })
    expect(egoWriteNext(r)).toBe('done')
  })

  it('浏览器权限框：ego 自己停下、交给人 → needs_human（带 Space，之后接着做）', () => {
    const r = parseEgoWriteOutput(
      { platform: 'facebook-post' },
      proc({
        stdout:
          '@@SPACE 12\nA browser permission prompt for notifications has appeared.\nThe user now controls this task space. Wait for the user to handle the prompt.\nResume only after the user confirms, using takeOverTaskSpace(spaceId).\n',
      }),
    )
    expect(r).toMatchObject({ state: 'needs_human', space_id: 12 })
    expect(egoWriteNext(r)).toBe('wait_human')
    expect(egoWriteSentence(r)).toContain('阻止')
  })

  it('Windows 管理员身份：unavailable + 人话（正常双击打开工坊）', () => {
    const r = parseEgoWriteOutput(
      { platform: 'x-post' },
      proc({
        exit_code: 1,
        stderr: 'ego lite closed the connection because ego-browser is running as administrator',
      }),
    )
    expect(r).toMatchObject({ state: 'unavailable', why: EGO_ADMIN_SENTENCE })
    expect(egoWriteNext(r)).toBe('plugin')
  })

  it('点过发送、脚本没跑完（超时）→ 停下，不退插件（免得发两遍）', () => {
    const r = parseEgoWriteOutput(
      { platform: 'linkedin-post' },
      proc({
        timed_out: true,
        exit_code: null,
        stdout: '@@STEP {"name":"send-clicked","ok":true}\n',
      }),
    )
    expect(r).toMatchObject({ state: 'failed', clicked: true })
    expect(egoWriteNext(r)).toBe('stop')
    expect(egoWriteSentence(r)).toContain('没换路重发')
  })

  it('没点过发送的失败 → 退插件；被平台拦 → 停下', () => {
    expect(egoWriteNext({ state: 'failed' })).toBe('plugin')
    expect(egoWriteNext({ state: 'needs_login' })).toBe('plugin')
    expect(egoWriteNext({ state: 'unavailable' })).toBe('plugin')
    expect(egoWriteNext({ state: 'blocked' })).toBe('stop')
    expect(egoWriteNext({ state: 'filled' })).toBe('review')
  })

  it('跑一次：只 spawn `ego-browser nodejs`，脚本走标准输入', async () => {
    const calls: { args: readonly string[]; stdin?: string }[] = []
    const spawn: EgoSpawn = async (input) => {
      calls.push(input)
      return proc({ stdout: '@@FINAL {"state":"filled","button_found":true}\n' })
    }
    const r = await runEgoWrite({
      egoPath: '/fake/ego-browser',
      cfg: {
        platform: 'instagram-post',
        space: 's',
        mode: 'write',
        text: 'cap',
        files: ['/a.png'],
        submit: false,
      },
      spawn,
    })
    expect(r.state).toBe('filled')
    expect(calls[0]?.args).toEqual(['nodejs'])
    expect(calls[0]?.stdin).toContain('"platform":"instagram-post"')
  })

  it('ego 用不了（设置不是 ego / 没探到）：不起子进程，直接 unavailable', async () => {
    let spawned = 0
    const w = createEgoWriter({
      egoPath: () => undefined,
      spawn: async () => {
        spawned += 1
        return proc({})
      },
    })
    expect(w.available()).toBe(false)
    expect(
      (await w.run({ platform: 'x-post', mode: 'write', text: 'x', submit: true })).state,
    ).toBe('unavailable')
    expect(spawned).toBe(0)
  })
})

describe('WP483 真连一次（设置页 / 首次设置的「推荐装 ego」用）', () => {
  it('连上了 / 管理员身份 / 没打开', async () => {
    expect(await probeEgoConnection('/e', async () => proc({ stdout: '@@OK 0\n' }))).toEqual({
      connected: true,
    })
    expect(
      await probeEgoConnection('/e', async () =>
        proc({ exit_code: 1, stderr: 'ego-browser is running as administrator' }),
      ),
    ).toMatchObject({ connected: false, admin: true })
    const off = await probeEgoConnection('/e', async () =>
      proc({ exit_code: 1, stderr: 'ECONNREFUSED' }),
    )
    expect(off.connected).toBe(false)
    expect(off.detail).toContain('首次引导')
  })
})

describe('WP483 素材落成临时文件', () => {
  it('blob 与外链都落盘、后缀按类型；跑完删掉', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp483-media-'))
    dirs.push(root)
    const got = await materializeMedia(['blob://k1', 'https://cdn.example.test/v.mp4?x=1'], {
      root,
      readBlob: async (key) =>
        key === 'k1' ? { bytes: new Uint8Array([1, 2, 3]), content_type: 'image/png' } : undefined,
      fetch: (async () =>
        new Response(new Uint8Array([9, 9]), {
          headers: { 'content-type': 'video/mp4' },
        })) as never,
    })
    if ('why' in got) throw new Error(got.why)
    expect(got.files.map((f) => f.slice(-4))).toEqual(['.png', '.mp4'])
    expect([...readFileSync(got.files[0] as string)]).toEqual([1, 2, 3])
    got.cleanup()
    expect(got.files.every((f) => !existsSync(f))).toBe(true)
  })

  it('有一个取不到就整条回原因（宁可退插件也不少挂一张图）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp483-media-'))
    dirs.push(root)
    const got = await materializeMedia(['blob://missing'], {
      root,
      readBlob: async () => undefined,
    })
    expect('why' in got && got.why).toContain('找不到')
  })
})

describe('WP483 渠道 → ego 那一种', () => {
  it('发帖 / 回帖：五家内容渠道有；Threads / YouTube 没有（走插件 / 人）', () => {
    const post: (EgoWritePlatform | undefined)[] = [
      'facebook',
      'instagram',
      'x',
      'linkedin',
      'tiktok',
      'threads',
      'youtube',
    ].map(egoPostPlatformOf)
    expect(post).toEqual([
      'facebook-post',
      'instagram-post',
      'x-post',
      'linkedin-post',
      'tiktok-post',
      undefined,
      undefined,
    ])
    expect(egoReplyPlatformOf('x')).toBe('x-reply')
    expect(egoReplyPlatformOf('reddit')).toBeUndefined()
  })
})

describe('WP483（决策 1660）：岗位上的「发之前让我看一眼」', () => {
  it('默认关；开了落盘、重启还在；关了就没了', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp483-review-'))
    dirs.push(dir)
    const a = createWriteReviewSettings({ dir })
    expect(a.get('pos_social').review_before_send).toBe(false)
    a.set('pos_social', true)
    expect(createWriteReviewSettings({ dir }).get('pos_social').review_before_send).toBe(true)
    a.set('pos_social', false)
    expect(createWriteReviewSettings({ dir }).list()).toEqual([])
  })
})
