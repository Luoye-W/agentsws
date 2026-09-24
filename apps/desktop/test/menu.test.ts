import { describe, expect, it } from 'vitest'
import type { ConnectRuntimeStatus } from '../src/connect-runtime.js'
import type { HealthSnapshot } from '../src/health.js'
import { strings } from '../src/i18n.js'
import {
  buildTrayMenu,
  canOpenWorkstation,
  connectStateLabel,
  serverStateLabel,
  type TrayModelInput,
  trayTooltip,
} from '../src/menu.js'
import type { SidecarSnapshot, SidecarState } from '../src/sidecar.js'

const server = (state: SidecarState): SidecarSnapshot => ({
  name: 'server',
  state,
  pid: 1,
  attempts: 0,
  startedAt: undefined,
  lastExit: undefined,
  retryInMs: undefined,
})

const healthy: HealthSnapshot = {
  ok: true,
  status: 'ok',
  version: '0.1.0',
  halted: false,
  at: undefined,
  error: undefined,
}

const connect = (state: ConnectRuntimeStatus['state']): ConnectRuntimeStatus => ({
  state,
  baseUrl: 'http://127.0.0.1:3000',
  reasons: [],
  checks: [],
  checkedAt: '2026-09-09T00:00:00.000Z',
})

const input = (patch: Partial<TrayModelInput> = {}): TrayModelInput => ({
  language: 'zh-CN',
  serverUrl: 'http://127.0.0.1:4317',
  version: '0.1.0',
  server: server('running'),
  health: healthy,
  paused: false,
  connect: undefined,
  launchAtLogin: false,
  ...patch,
})

describe('serverStateLabel', () => {
  it('五个状态各有说法', () => {
    const t = strings('zh-CN')
    expect(serverStateLabel(input({ server: server('running') }))).toBe(t.serverRunning)
    expect(serverStateLabel(input({ server: server('starting') }))).toBe(t.serverStarting)
    expect(serverStateLabel(input({ server: server('backoff') }))).toBe(t.serverBackoff)
    expect(serverStateLabel(input({ server: server('failed') }))).toBe(t.serverFailed)
    expect(serverStateLabel(input({ server: server('stopped') }))).toBe(t.serverStopped)
  })

  it('英文档也齐', () => {
    expect(serverStateLabel(input({ language: 'en-US' }))).toBe('Service running')
  })
})

describe('connectStateLabel', () => {
  it('没检查过就不显示这一行', () => {
    expect(connectStateLabel(input())).toBeUndefined()
  })

  it('三种状态各一句（未加固要说明"已拒绝接入"）', () => {
    expect(connectStateLabel(input({ connect: connect('ready') }))).toContain('已加固')
    expect(connectStateLabel(input({ connect: connect('unhardened') }))).toContain('已拒绝接入')
    expect(connectStateLabel(input({ connect: connect('absent') }))).toContain('未检测到')
  })
})

describe('canOpenWorkstation', () => {
  it('服务不健康时不让点，省得开出个白屏', () => {
    expect(canOpenWorkstation(input())).toBe(true)
    expect(canOpenWorkstation(input({ health: undefined }))).toBe(false)
    expect(canOpenWorkstation(input({ health: { ...healthy, ok: false } }))).toBe(false)
  })
})

describe('buildTrayMenu', () => {
  it('13 §5 要求的五项都在：打开工作台 / 浏览器打开 / 暂停 / 状态 / 退出', () => {
    const items = buildTrayMenu(input())
    const ids = items.map((i) => i.id)
    expect(ids).toContain('open-workstation')
    expect(ids).toContain('open-browser')
    expect(ids).toContain('toggle-pause')
    expect(ids).toContain('status')
    expect(ids).toContain('quit')
    expect(ids).toContain('open-logs')
    expect(ids).toContain('toggle-launch-at-login')
    expect(ids).toContain('restart-server')
  })

  it('服务没起来时两个"打开"都是灰的', () => {
    const items = buildTrayMenu(input({ health: undefined }))
    expect(items.find((i) => i.id === 'open-workstation')?.enabled).toBe(false)
    expect(items.find((i) => i.id === 'open-browser')?.enabled).toBe(false)
  })

  it('暂停是勾选项，勾上时文案变"恢复"', () => {
    const running = buildTrayMenu(input()).find((i) => i.id === 'toggle-pause')
    expect(running).toMatchObject({ type: 'checkbox', checked: false, label: '暂停（急停）' })
    const paused = buildTrayMenu(input({ paused: true })).find((i) => i.id === 'toggle-pause')
    expect(paused).toMatchObject({ checked: true, label: '恢复运行' })
  })

  it('状态行带 URL；暂停时补一句"已暂停"', () => {
    expect(buildTrayMenu(input())[5]?.label).toContain('http://127.0.0.1:4317')
    expect(buildTrayMenu(input({ paused: true }))[5]?.label).toContain('已暂停')
    expect(buildTrayMenu(input({ health: { ...healthy, halted: true } }))[5]?.label).toContain(
      '已暂停',
    )
  })

  it('检测过 connector 才多一行', () => {
    expect(buildTrayMenu(input()).filter((i) => i.id === 'status')).toHaveLength(1)
    expect(
      buildTrayMenu(input({ connect: connect('ready') })).filter((i) => i.id === 'status'),
    ).toHaveLength(2)
  })

  it('开机自启是勾选项', () => {
    const item = buildTrayMenu(input({ launchAtLogin: true })).find(
      (i) => i.id === 'toggle-launch-at-login',
    )
    expect(item).toMatchObject({ type: 'checkbox', checked: true })
  })

  it('状态行不可点', () => {
    for (const item of buildTrayMenu(input({ connect: connect('absent') })))
      if (item.id === 'status') expect(item.enabled).toBe(false)
  })
})

describe('WP31：轮换本机密钥', () => {
  it('菜单里有这一项，且服务健康时才点得动（要调 /v1/secrets/rotate）', () => {
    const up = buildTrayMenu(input()).find((i) => i.id === 'rotate-secrets-key')
    expect(up).toMatchObject({ type: 'normal', enabled: true, label: '轮换本机密钥' })

    const down = buildTrayMenu(input({ health: undefined })).find(
      (i) => i.id === 'rotate-secrets-key',
    )
    expect(down?.enabled).toBe(false)
  })

  it('英文档也有文案', () => {
    const item = buildTrayMenu(input({ language: 'en-US' })).find(
      (i) => i.id === 'rotate-secrets-key',
    )
    expect(item?.label).toBe('Rotate local key')
  })
})

describe('WP82（55 §3 末段）：打开工作用的浏览器', () => {
  it('菜单里有这一项，且服务健康时才点得动（起完要把地址 PUT 进设置）', () => {
    const up = buildTrayMenu(input()).find((i) => i.id === 'open-work-browser')
    expect(up).toMatchObject({ type: 'normal', enabled: true, label: '打开工作用的浏览器' })

    const down = buildTrayMenu(input({ health: undefined })).find(
      (i) => i.id === 'open-work-browser',
    )
    expect(down?.enabled).toBe(false)
  })

  it('英文档也有文案', () => {
    const item = buildTrayMenu(input({ language: 'en-US' })).find(
      (i) => i.id === 'open-work-browser',
    )
    expect(item?.label).toBe('Open the work browser')
  })
})

describe('WP92（55 §10）：检查浏览器扩展', () => {
  it('菜单里有这一项，且服务健康时才点得动（体检是服务端跑的）', () => {
    const up = buildTrayMenu(input()).find((i) => i.id === 'check-browser-extension')
    expect(up).toMatchObject({ type: 'normal', enabled: true, label: '检查浏览器扩展' })

    const down = buildTrayMenu(input({ health: undefined })).find(
      (i) => i.id === 'check-browser-extension',
    )
    expect(down?.enabled).toBe(false)
  })

  it('英文档也有文案', () => {
    const item = buildTrayMenu(input({ language: 'en-US' })).find(
      (i) => i.id === 'check-browser-extension',
    )
    expect(item?.label).toBe('Check the browser extension')
  })
})

describe('trayTooltip', () => {
  it('版本 + 状态；暂停时补一句', () => {
    expect(trayTooltip(input())).toBe('Agents 工坊 0.1.0 · 服务运行中')
    expect(trayTooltip(input({ paused: true }))).toContain('已暂停')
  })
})

describe('WP36 / 40 §1.3：连公司服务器那一档', () => {
  const remote = (patch: Partial<TrayModelInput> = {}): TrayModelInput =>
    input({
      mode: 'remote',
      company: 'nas.company.lan',
      serverUrl: 'https://nas.company.lan:4317',
      // remote 档这台电脑没有 sidecar，快照永远是 stopped
      server: server('stopped'),
      ...patch,
    })

  it('状态那一行说的是「已连接谁」，不是「服务已停止」', () => {
    expect(serverStateLabel(remote())).toBe('已连接 nas.company.lan')
    expect(serverStateLabel(remote({ language: 'en-US' }))).toBe('Connected to nas.company.lan')
  })

  it('连不上就如实说，不假装', () => {
    const t = strings('zh-CN')
    expect(serverStateLabel(remote({ health: undefined }))).toBe(t.remoteUnreachable)
  })

  it('「重启服务」「轮换本机密钥」「打开工作用的浏览器」都不出现——那几样都不在这台电脑上', () => {
    const ids = buildTrayMenu(remote()).map((i) => i.id)
    expect(ids).not.toContain('restart-server')
    expect(ids).not.toContain('rotate-secrets-key')
    // WP82：服务在公司那台机器上，起在这儿的浏览器它连不到（127.0.0.1 各指各的）
    expect(ids).not.toContain('open-work-browser')
    // WP92：扩展与 bsk 也都在那台电脑上，问不出所以然
    expect(ids).not.toContain('check-browser-extension')
    expect(ids).toContain('open-workstation')
    expect(ids).toContain('toggle-pause')
    expect(ids).toContain('quit')
  })

  it('本机档照旧有那两项', () => {
    const ids = buildTrayMenu(input()).map((i) => i.id)
    expect(ids).toContain('restart-server')
    expect(ids).toContain('rotate-secrets-key')
  })

  it('tooltip 也跟着说「已连接」', () => {
    expect(trayTooltip(remote())).toContain('已连接 nas.company.lan')
  })

  it('公司名还不知道时不留一个孤零零的空格', () => {
    expect(serverStateLabel(remote({ company: '' }))).toBe('已连接')
    expect(serverStateLabel(remote({ company: undefined }))).toBe('已连接')
  })
})

describe('WP148：开源软件许可', () => {
  it('安装包里有许可证说明才出这一项，摆在「导出诊断包」后面、中英文都有', () => {
    const ids = (patch: Partial<TrayModelInput>) => buildTrayMenu(input(patch)).map((i) => i.id)
    expect(ids({})).not.toContain('open-licenses')
    expect(ids({ licenses: false })).not.toContain('open-licenses')
    const on = ids({ licenses: true })
    expect(on.indexOf('open-licenses')).toBe(on.indexOf('export-diagnostics') + 1)
    const label = (language: TrayModelInput['language']) =>
      buildTrayMenu(input({ licenses: true, language })).find((i) => i.id === 'open-licenses')
        ?.label
    expect(label('zh-CN')).toBe('开源软件许可')
    expect(label('en-US')).toBe('Open-source licenses')
  })

  it('连公司服务器那一档也有（许可证说明的是这台电脑上装的这个安装包）', () => {
    expect(buildTrayMenu(input({ licenses: true, mode: 'remote' })).map((i) => i.id)).toContain(
      'open-licenses',
    )
  })
})
