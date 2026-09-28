/**
 * WP180：完整 profile 里的守门插件（`@agentsws/dsh-adapter/profile-guard`）在**真的 cordis 树**里生效。
 *
 * 官方 `ConfigEditor` / `PluginManager` 要 Loader + `profileContext` 才挂得起来（只在 `dsh --profile` 里），
 * 这里用同名服务的替身（只有要包的那几个方法）挂在真的 `Context` 上，守门插件按 profile 里那一行的方式挂，
 * 再从**另一个插件**的上下文里调——等于官方 `settings` 那样的调用方看到的是包过的方法。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as guard from '../src/profile-guard.js'
import { PROFILE_LOCKED_ROWS, ProfileGuardError } from '../src/profile-guard.js'

const tick = () => new Promise((r) => setTimeout(r, 20))

function fakeEditor() {
  const saved: { id: string; config: Record<string, unknown> }[] = []
  return {
    saved,
    edit: async (
      entry: { id: string },
      change: (c: Record<string, unknown>, i: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      saved.push({ id: entry.id, config: change({}, {}) })
    },
  }
}

function fakeManager() {
  const calls: string[] = []
  return {
    calls,
    listBundles: async () => {
      calls.push('listBundles')
      return []
    },
    installBundle: async () => {
      calls.push('installBundle')
      return {}
    },
    setPluginEnabled: async () => {
      calls.push('setPluginEnabled')
      return {}
    },
  }
}

async function mounted() {
  const root = new Context()
  const editor = fakeEditor()
  const manager = fakeManager()
  root.provide('configEditor', editor as never)
  root.provide('pluginManager', manager as never)
  await root.plugin(guard as never)
  await tick()
  let caller: Context | undefined
  await root.plugin({
    apply: (ctx: Context) => {
      caller = ctx
    },
  } as never)
  return { root, editor, manager, caller: caller as Context }
}

describe('WP180 守门插件：配置写回只许写不在锁定表里的行', () => {
  it('一次保存企图把 C 类上报（会话日志）打开 → 被拒，官方的 edit 没被调', async () => {
    const { editor, caller } = await mounted()
    const edit = (caller.get('configEditor') as ReturnType<typeof fakeEditor>).edit
    await expect(
      edit({ id: 'session-log-deepseek' }, () => ({ enabled: true })),
    ).rejects.toBeInstanceOf(ProfileGuardError)
    for (const id of PROFILE_LOCKED_ROWS) {
      await expect(edit({ id }, () => ({}))).rejects.toMatchObject({
        rejection: { kind: 'config', row_id: id },
      })
    }
    expect(editor.saved).toEqual([])
  })

  it('不在锁定表里的行照官方原样写', async () => {
    const { editor, caller } = await mounted()
    const edit = (caller.get('configEditor') as ReturnType<typeof fakeEditor>).edit
    await edit({ id: 'time-context' }, () => ({ timeZone: 'Asia/Shanghai' }))
    expect(editor.saved).toEqual([{ id: 'time-context', config: { timeZone: 'Asia/Shanghai' } }])
  })

  it('被拒的那一条只带行 id 与字段名，不带值', async () => {
    const seen: guard.ProfileGuardRejection[] = []
    const editor = fakeEditor()
    guard.guardConfigEditor(editor, { locked: ['otel'], onRejected: (r) => seen.push(r) })
    await expect(editor.edit({ id: 'otel' }, () => ({ endpoint: 'https://x' }))).rejects.toThrow()
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'config', row_id: 'otel', fields: ['endpoint'] }),
    ])
    expect(JSON.stringify(seen)).not.toContain('https://x')
  })
})

describe('WP180 守门插件：官方插件管理只读', () => {
  it('写方法一律拒（装插件要到「设置 → 官方插件」出卡），读的方法照常', async () => {
    const { manager, caller } = await mounted()
    const pm = caller.get('pluginManager') as ReturnType<typeof fakeManager>
    await expect(pm.installBundle()).rejects.toMatchObject({
      rejection: { kind: 'plugin', op: 'installBundle' },
    })
    await expect(pm.setPluginEnabled()).rejects.toBeInstanceOf(ProfileGuardError)
    await pm.listBundles()
    expect(manager.calls).toEqual(['listBundles'])
  })

  it('守门插件卸下后原方法放回（不留半个包装）', async () => {
    const editor = fakeEditor()
    const original = editor.edit
    const undo = guard.guardConfigEditor(editor, { locked: [], onRejected: () => undefined })
    expect(editor.edit).not.toBe(original)
    undo()
    expect(editor.edit).toBe(original)
  })
})
