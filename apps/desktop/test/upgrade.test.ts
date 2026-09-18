/**
 * WP111 托盘这一侧：那张纸条怎么念、还原单怎么下、菜单里那一项什么时候出现。
 */
import { describe, expect, it } from 'vitest'
import { buildTrayMenu, serverStateLabel, type TrayModelInput } from '../src/menu.js'
import { memoryFileStore } from '../src/node-files.js'
import {
  canRestore,
  failureMessage,
  parseFailureNote,
  RESTORE_REQUEST_FILE,
  readFailureNote,
  requestRestore,
  UPGRADE_FAILED_FILE,
  type UpgradeFailureNote,
} from '../src/upgrade.js'
import { fakeClock } from './fakes.js'

const NOTE: UpgradeFailureNote = {
  at: '2026-09-18T10:00:00.000Z',
  release: '0.1.0-beta.2',
  previous_release: '0.1.0-beta.1',
  stage: 'migrate',
  error: 'Error: 迁移炸了\n  at ...',
  backup:
    'C:\\Users\\小雨 的电脑\\AppData\\Roaming\\agentsws\\data\\backups\\x-from-0.1.0-beta.1.zip',
  data_touched: false,
}

describe('parseFailureNote', () => {
  it('认得出一张完整的纸条', () => {
    expect(parseFailureNote(JSON.stringify(NOTE))).toEqual(NOTE)
  })

  it('坏 JSON / 缺字段 / 没有文件 → undefined（读不懂不该让托盘也挂）', () => {
    expect(parseFailureNote(undefined)).toBeUndefined()
    expect(parseFailureNote('{ 这不是 JSON')).toBeUndefined()
    expect(parseFailureNote('null')).toBeUndefined()
    expect(parseFailureNote('{"release":"x"}')).toBeUndefined()
  })

  it('可选字段缺了也认，`data_touched` 缺省当 false', () => {
    const note = parseFailureNote('{"release":"x","error":"boom"}')
    expect(note).toEqual({ at: '', release: 'x', error: 'boom', data_touched: false })
  })

  it('不认识的 `stage` 当没写（纸条是别的版本写的也不该炸）', () => {
    expect(parseFailureNote('{"release":"x","error":"e","stage":"什么"}')?.stage).toBeUndefined()
    expect(parseFailureNote('{"release":"x","error":"e","stage":"backup"}')?.stage).toBe('backup')
  })
})

describe('readFailureNote', () => {
  it('从数据目录里读；Windows 的反斜杠路径也拼得对', () => {
    const winDir = 'C:\\Users\\小雨 的电脑\\AppData\\Roaming\\agentsws\\data'
    const files = memoryFileStore({ [`${winDir}\\${UPGRADE_FAILED_FILE}`]: JSON.stringify(NOTE) })
    expect(readFailureNote(files, winDir)?.release).toBe('0.1.0-beta.2')
  })

  it('posix 路径同理；没有纸条就是 undefined', () => {
    const dir = '/Users/xiaoyu/Library/Application Support/agentsws/data'
    const files = memoryFileStore({ [`${dir}/${UPGRADE_FAILED_FILE}`]: JSON.stringify(NOTE) })
    expect(readFailureNote(files, dir)?.release).toBe('0.1.0-beta.2')
    expect(readFailureNote(memoryFileStore(), dir)).toBeUndefined()
    // 结尾已经有分隔符时不再补一个
    const files2 = memoryFileStore({ [`${dir}/${UPGRADE_FAILED_FILE}`]: JSON.stringify(NOTE) })
    expect(readFailureNote(files2, `${dir}/`)?.release).toBe('0.1.0-beta.2')
  })
})

describe('failureMessage', () => {
  it('先说数据动没动，再说备份在哪；**错误堆栈不进这句话**', () => {
    const message = failureMessage(NOTE, 'zh-CN')
    expect(message).toContain('一个字节都没动')
    expect(message).toContain('x-from-0.1.0-beta.1.zip')
    expect(message).not.toContain('at ...')
  })

  it('万一真动了，就说实话（别用同一句话糊过去）', () => {
    const message = failureMessage({ ...NOTE, data_touched: true }, 'zh-CN')
    expect(message).toContain('可能只改了一半')
  })

  it('这次没备份也说清楚为什么', () => {
    const { backup: _backup, ...withoutBackup } = NOTE
    expect(failureMessage(withoutBackup, 'zh-CN')).toContain('本来就不动数据')
  })

  it('卡在备份那一步 → 说的是"一条迁移都没跑"，不是"去还原"', () => {
    const message = failureMessage({ ...NOTE, stage: 'backup', backup: undefined }, 'zh-CN')
    expect(message).toContain('一条迁移都没跑')
    expect(failureMessage({ ...NOTE, stage: 'backup', backup: undefined }, 'en-US')).toContain(
      'no migration ran',
    )
  })

  it('英文那份也有', () => {
    expect(failureMessage(NOTE, 'en-US')).toContain('Not one byte')
  })
})

describe('canRestore', () => {
  it('有纸条 + 纸条里有备份路径才点得动', () => {
    expect(canRestore(NOTE)).toBe(true)
    expect(canRestore(undefined)).toBe(false)
    expect(canRestore({ ...NOTE, backup: '' })).toBe(false)
    const { backup: _b, ...none } = NOTE
    expect(canRestore(none)).toBe(false)
  })
})

describe('requestRestore', () => {
  it('写一张单子就完事 —— 真正的导入由服务进程下次启动去做', () => {
    const files = memoryFileStore()
    const dir = '/data'
    const order = requestRestore({
      files,
      dataDir: dir,
      backup: '/data/backups/x-from-0.1.0-beta.1.zip',
      clock: fakeClock(),
    })
    expect(order.by).toBe('tray')
    const raw = files.readText(`${dir}/${RESTORE_REQUEST_FILE}`) as string
    expect(JSON.parse(raw)).toEqual(order)
  })

  it('下单人可以换（将来 CLI 也能下同一张单）', () => {
    const files = memoryFileStore()
    expect(
      requestRestore({ files, dataDir: '/d', backup: '/b.zip', clock: fakeClock(), by: 'cli' }).by,
    ).toBe('cli')
  })
})

const base: TrayModelInput = {
  language: 'zh-CN',
  serverUrl: 'http://127.0.0.1:4317',
  version: '0.1.0-beta.2',
  server: { state: 'failed', restarts: 0, since: '', lastExit: undefined } as never,
  health: undefined,
  paused: false,
  connect: undefined,
  launchAtLogin: false,
}

describe('托盘：升级出事之后', () => {
  it('状态那行先回答"我的数据还在吗"', () => {
    expect(serverStateLabel(base)).toBe('服务反复启动失败')
    expect(serverStateLabel({ ...base, upgradeFailed: true })).toBe('升级没成功，数据没动')
  })

  it('「还原上一份备份」**只在真出事时出现**', () => {
    const ids = (input: TrayModelInput) => buildTrayMenu(input).map((i) => i.id)
    expect(ids(base)).not.toContain('restore-backup')
    expect(ids({ ...base, upgradeFailed: true })).toContain('restore-backup')
  })

  it('没有可还原的包就灰着 —— 用户得看见"有这么个东西，只是这次没得还原"', () => {
    const item = (restorable: boolean) =>
      buildTrayMenu({ ...base, upgradeFailed: true, restorable }).find(
        (i) => i.id === 'restore-backup',
      )
    expect(item(true)?.enabled).toBe(true)
    expect(item(false)?.enabled).toBe(false)
  })

  it('连公司服务器那一档没有这一项：数据不在这台电脑上', () => {
    const remote = { ...base, mode: 'remote' as const, upgradeFailed: true, restorable: true }
    expect(buildTrayMenu(remote).map((i) => i.id)).not.toContain('restore-backup')
    expect(serverStateLabel(remote)).not.toBe('升级没成功，数据没动')
  })
})
