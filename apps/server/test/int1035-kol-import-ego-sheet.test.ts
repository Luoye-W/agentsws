/**
 * int/1035：WP489 的在线表导入接上 WP493 的两口——
 * ① 先问 ego 的表格读取口（`readSheet` = `brand.onlineSheet.read`）：读到就用；ego 里没登录 / 没权限照它的话说；
 *    别的（用不了 / 读不出 / 没跑完 / 读到空表 / 抛错）再走读页那条老路；
 * ② 读页那条路 = WP493 的选路链 `pageRead.readPage`（ego → 插件 → 内置浏览器）。
 * 全用假读取口，不碰真 ego、不碰真网站。
 */
import type { KolActor } from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'
import type { OnlinePageRead } from '@agentsws/kol-core'
import { describe, expect, it } from 'vitest'
import { createPageReadChain } from '../src/ego-read/chain.js'
import type { EgoPageRead } from '../src/ego-read/reader.js'
import type { OnlineSheetRead } from '../src/ego-read/sheet.js'
import { createKolStore } from '../src/kol.js'
import { createKolImport, type KolImportOptions } from '../src/kol-import.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as never
const clock: Clock = { now: () => '2026-10-24T09:00:00.000Z' }
const actor: KolActor = {
  workspace_id: WS,
  assignment_id: 'asg_1',
  role_id: 'role_kol',
  member_id: 'mbr_1',
} as never
const FEISHU = 'https://acme.feishu.cn/base/bascnXYZ?table=tbl1'
const ROWS = [
  ['名称', '链接', '进度'],
  ['Rosa', 'https://www.tiktok.com/@deskrosa', '已发布'],
]

function setup(extra: Partial<KolImportOptions>) {
  let n = 0
  return createKolImport({
    workspace_id: WS,
    store: createKolStore({ workspace_id: WS }),
    secrets: createSecretStore({
      dbPath: ':memory:',
      clock,
      env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
    }),
    clock,
    random: () => (n++ % 97) / 97,
    ...extra,
  })
}

/** 假读页口：记下被叫过几次。 */
function pages(read: (url: string) => OnlinePageRead) {
  const calls: string[] = []
  return {
    calls,
    readers: () => [
      {
        id: 'fake',
        read: async (url: string) => {
          calls.push(url)
          return read(url)
        },
      },
    ],
  }
}

const sheet =
  (r: OnlineSheetRead | undefined | Error) => async (): Promise<OnlineSheetRead | undefined> => {
    if (r instanceof Error) throw r
    return r
  }

describe('int/1035：在线表先问 ego 表格读取口，再走读页选路链', () => {
  it('ok：用 ego 读到的格子（飞书截住复制那种），读页一次都不走', async () => {
    const p = pages((u) => ({ ok: true, final_url: u, text: '' }))
    const imp = setup({
      readSheet: sheet({ ok: true, kind: 'feishu', via: 'copy', rows: ROWS }),
      readers: p.readers,
    })
    const view = await imp.previewImport(actor, { url: FEISHU })
    expect(view.ok).toBe(true)
    expect(view.counts).toMatchObject({ create: 1, collabs: 1 })
    expect(view.statuses?.[0]).toMatchObject({ source: '已发布', stage: 'delivered' })
    expect(p.calls).toHaveLength(0)
  })

  it('login / no_access：照 ego 的话说（是 ego 里没登录 / 没权限），不再拿别的浏览器去试', async () => {
    for (const reason of ['login', 'no_access'] as const) {
      const p = pages((u) => ({
        ok: true,
        final_url: u,
        text: '名称\t链接\nRosa\thttps://x.example\n',
      }))
      const message =
        reason === 'login'
          ? 'ego 里还没登录飞书——在 ego 里登录一下，再贴一次链接。'
          : 'ego 里登录的飞书账号打不开这张表'
      const imp = setup({
        readSheet: sheet({ ok: false, kind: 'feishu', reason, message }),
        readers: p.readers,
      })
      const view = await imp.previewImport(actor, { url: FEISHU })
      expect(view.ok).toBe(false)
      expect(view.message).toBe(message)
      expect(p.calls).toHaveLength(0)
    }
  })

  it('退回老路：ego 用不了 / 读不出 / 没跑完 / 读到空表 / 抛错 → 走读页（读到就用）', async () => {
    const fallbacks: (OnlineSheetRead | undefined | Error)[] = [
      undefined,
      { ok: false, kind: 'feishu', reason: 'off', message: 'ego 这会儿用不了。' },
      { ok: false, kind: 'feishu', reason: 'unreadable', message: '读不出' },
      { ok: false, kind: 'feishu', reason: 'failed', message: '没读完' },
      { ok: true, kind: 'feishu', via: 'page_cells', rows: [['', '']] },
      new Error('ego 崩了'),
    ]
    for (const r of fallbacks) {
      const p = pages((u) => ({
        ok: true,
        final_url: u,
        text: '名称\t链接\t进度\nRosa\thttps://www.tiktok.com/@deskrosa\t已发布\n',
      }))
      const imp = setup({ readSheet: sheet(r), readers: p.readers })
      const view = await imp.previewImport(actor, { url: FEISHU })
      expect(view.ok).toBe(true)
      expect(p.calls.length).toBeGreaterThan(0)
    }
  })

  it('读页那条路就是 WP493 的选路链：ego 读页没成 → 插件 → 内置浏览器', async () => {
    const via: string[] = []
    const egoPage = async (): Promise<EgoPageRead> => {
      via.push('ego')
      return { ok: false, state: 'failed', message: 'ego 这一趟没跑完' }
    }
    const chain = createPageReadChain({
      ego: () => ({
        available: () => true,
        read: async () => ({ ok: false, message: 'x' }),
        page: egoPage,
      }),
      plugin: () => ({
        read: async () => {
          via.push('plugin')
          return { ok: false, message: '插件没开' }
        },
      }),
      builtin: async (u) => {
        via.push('builtin')
        return {
          ok: true,
          final_url: u,
          text: '名称\t链接\t进度\nRosa\thttps://www.tiktok.com/@deskrosa\t已发布\n',
        }
      },
    })
    const imp = setup({
      readSheet: sheet({ ok: false, kind: 'feishu', reason: 'unreadable', message: '读不出' }),
      readers: () => [{ id: 'chain', read: chain.readPage }],
    })
    const view = await imp.previewImport(actor, { url: FEISHU })
    expect(view.ok).toBe(true)
    expect(via.slice(0, 3)).toEqual(['ego', 'plugin', 'builtin'])
  })
})
