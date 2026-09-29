/** WP184：退出前的确认（移植自官方桌面端 `quit-confirmation.ts`）。 */
import { describe, expect, it } from 'vitest'
import {
  DesktopQuitConfirmation,
  type QuitBoxOptions,
  resolveDesktopQuitPrompt,
} from '../src/quit-confirmation.js'

const messages = {
  title: 'Agents 工坊',
  message: '退出？',
  quitActiveTasks: 'A',
  quitScheduledTasks: 'S',
  quitActiveAndScheduledTasks: 'AS',
  quit: '退出',
  cancel: '取消',
}

describe('退出确认', () => {
  it('查不到当作有任务；两样都有用合并那句；都没有不问', () => {
    expect(resolveDesktopQuitPrompt('unknown')).toBe('quitActiveTasks')
    expect(resolveDesktopQuitPrompt({ activeTasks: true, scheduledTasks: true })).toBe(
      'quitActiveAndScheduledTasks',
    )
    expect(resolveDesktopQuitPrompt({ activeTasks: false, scheduledTasks: true })).toBe(
      'quitScheduledTasks',
    )
    expect(resolveDesktopQuitPrompt({ activeTasks: false, scheduledTasks: false })).toBeUndefined()
  })

  it('没有官方场景在跑：直接退，不开框', async () => {
    const shown: QuitBoxOptions[] = []
    const c = new DesktopQuitConfirmation({
      messages: () => messages,
      inspect: () => undefined,
      show: async (o) => {
        shown.push(o)
        return { response: 0 }
      },
      focus: () => undefined,
    })
    expect(await c.confirm()).toBe(true)
    expect(shown).toEqual([])
  })

  it('查询失败按 unknown 问；点取消不退；重复点退出不叠框', async () => {
    const shown: QuitBoxOptions[] = []
    let focused = 0
    let answer: (r: { response: number }) => void = () => undefined
    const c = new DesktopQuitConfirmation({
      messages: () => messages,
      inspect: () => Promise.reject(new Error('没有查询通道')),
      show: (o) => {
        shown.push(o)
        return new Promise((r) => {
          answer = r
        })
      },
      focus: () => {
        focused += 1
      },
      platform: 'darwin',
    })
    const first = c.confirm()
    const second = c.confirm()
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toHaveLength(1)
    expect(shown[0]?.detail).toBe('A')
    expect(shown[0]?.buttons).toEqual(['退出', '取消'])
    expect(focused).toBe(1)
    answer({ response: 1 })
    expect(await first).toBe(false)
    expect(await second).toBe(false)
  })

  it('dispose 之后一律不退也不开框', async () => {
    const c = new DesktopQuitConfirmation({
      messages: () => messages,
      inspect: () => Promise.resolve('unknown' as const),
      show: async () => ({ response: 0 }),
      focus: () => undefined,
    })
    c.dispose()
    expect(await c.confirm()).toBe(false)
  })
})
