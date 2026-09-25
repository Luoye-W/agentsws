/**
 * WP136（docs/79）：左下角「场景」那一行。
 *
 * 1. 只有所有者看得到；这台部署切不了场景（托管 / 公司服务器）时整行不出；
 * 2. 点开：Agents 工坊第一个、标「当前」；其他网页场景每一行都写着「由 DeepSeek 官方维护，
 *    Agents 工坊不对它负责」；命令行类场景只列名字；
 * 3. 打开 = 调接口拿网址，交给桌面壳的桥（系统浏览器）；
 * 4. 删除要再输入一遍名字才点得动；新建 = 名字 + 模板；
 * 5. 托盘「管理场景…」带 `?scenes=1` 进来时面板自己展开。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneSwitcher } from '@/components/scene-switcher'
import type { DshSceneRow, DshScenesData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const row = (over: Partial<DshSceneRow> & { name: string }): DshSceneRow => ({
  origin: 'official',
  surface: 'web',
  is_default: false,
  deletable: false,
  launchable: true,
  initialized: true,
  state: 'stopped',
  ...over,
})

const LIST: DshScenesData = {
  available: true,
  dsh_version: '0.1.7-rc.2',
  scenes: [
    row({
      name: 'agentsws',
      origin: 'agentsws',
      surface: 'agentsws',
      is_default: true,
      state: 'running',
    }),
    row({ name: 'web', state: 'running', port: 5000 }),
    row({ name: 'coding', origin: 'custom', template: 'web', deletable: true }),
    row({ name: 'headless', surface: 'cli', launchable: false }),
    row({ name: 'acp', surface: 'cli', launchable: false }),
  ],
  templates: [
    { name: 'web', surface: 'web' },
    { name: 'headless', surface: 'cli' },
  ],
}

const state = {
  owner: true,
  data: LIST as DshScenesData,
  opened: [] as string[],
  created: [] as { name: string; template: string }[],
  deleted: [] as { name: string; confirm: string }[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: state.owner
        ? [{ position_id: 'asg_owner', role_id: 'common.owner', name: '老板' }]
        : [{ position_id: 'asg_x', role_id: 'dtc.support', name: '客服' }],
    }),
    getDshScenes: async () => state.data,
    openDshScene: async (name: string) => {
      state.opened.push(name)
      return {
        scene: row({ name, state: 'running' }),
        url: `http://127.0.0.1:5000/?token=t-${name}`,
      }
    },
    restartDshScene: async (name: string) => ({
      scene: row({ name, state: 'running' }),
      url: `http://127.0.0.1:5001/?token=r-${name}`,
    }),
    stopDshScene: async (name: string) => row({ name }),
    createDshScene: async (input: { name: string; template: string }) => {
      state.created.push(input)
      return row({ name: input.name, origin: 'custom' })
    },
    deleteDshScene: async (name: string, confirm: string) => {
      state.deleted.push({ name, confirm })
      return { deleted: true }
    },
  }
})

const bridge = { openExternal: vi.fn(async () => true) }

beforeEach(() => {
  state.owner = true
  state.data = LIST
  state.opened = []
  state.created = []
  state.deleted = []
  bridge.openExternal.mockClear()
  ;(window as unknown as { agentsws?: unknown }).agentsws = bridge
})
afterEach(() => {
  delete (window as unknown as { agentsws?: unknown }).agentsws
})

describe('左下角「场景」', () => {
  it('所有者：一行一个图标；点开 Agents 工坊第一个、标「当前」，官方的写明官方维护、自建的写明自己建的', async () => {
    renderWithProviders(<SceneSwitcher />)
    const toggle = await screen.findByTestId('scene-toggle')
    expect(toggle?.textContent).toContain('场景')
    // 有一个其他场景在跑：那一行右边挂个数
    expect((await screen.findByTestId('scene-running-count')).textContent).toContain('1')
    await userEvent.click(toggle)
    const rows = screen.getAllByTestId(/^scene-row-/)
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'scene-row-agentsws',
      'scene-row-web',
      'scene-row-coding',
    ])
    expect(rows[0]?.textContent).toContain('Agents 工坊')
    expect(rows[0]?.textContent).toContain('当前')
    expect(rows[0]?.textContent).not.toContain('DeepSeek 官方维护')
    expect(rows[1]?.textContent).toContain('这个场景由 DeepSeek 官方维护，Agents 工坊不对它负责。')
    // 自建场景不说"官方维护"（它是用户自己从模板建的），但同样写明不对它负责
    expect(rows[2]?.textContent).not.toContain('DeepSeek 官方维护')
    expect(rows[2]?.textContent).toContain(
      '这是你自己建的场景（从官方模板起步），Agents 工坊不对它负责。',
    )
    expect(screen.getByTestId('scene-cli')?.textContent).toContain('headless、acp')
    // 官方场景没有删除；自建的有
    expect(screen.queryByTestId('scene-delete-web')).toBeNull()
    expect(screen.getByTestId('scene-delete-coding')).toBeTruthy()
  })

  it('打开：拿到网址交给桌面壳的桥（系统浏览器）', async () => {
    renderWithProviders(<SceneSwitcher />)
    await userEvent.click(await screen.findByTestId('scene-toggle'))
    await userEvent.click(screen.getByTestId('scene-open-coding'))
    await waitFor(() => {
      expect(bridge.openExternal).toHaveBeenCalledWith('http://127.0.0.1:5000/?token=t-coding')
    })
    expect(state.opened).toEqual(['coding'])
    expect((await screen.findByTestId('scene-message')).textContent).toContain('已在浏览器里打开')
  })

  it('删除：名字输对了才点得动，删的时候把确认名一起带过去', async () => {
    renderWithProviders(<SceneSwitcher />)
    await userEvent.click(await screen.findByTestId('scene-toggle'))
    await userEvent.click(screen.getByTestId('scene-delete-coding'))
    const go = screen.getByRole('button', { name: '确认删除' })
    expect((go as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByRole('textbox'), 'codin')
    expect((go as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByRole('textbox'), 'g')
    expect((go as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(go)
    await waitFor(() => {
      expect(state.deleted).toEqual([{ name: 'coding', confirm: 'coding' }])
    })
  })

  it('新建：名字 + 模板', async () => {
    renderWithProviders(<SceneSwitcher />)
    await userEvent.click(await screen.findByTestId('scene-toggle'))
    await userEvent.click(screen.getByTestId('scene-new'))
    await userEvent.type(screen.getByLabelText('名字（小写英文、数字、短横线）'), 'notes')
    await userEvent.click(screen.getByRole('button', { name: '建好' }))
    await waitFor(() => {
      expect(state.created).toEqual([{ name: 'notes', template: 'web' }])
    })
  })

  it('不是所有者 / 这台部署切不了：整行不出', async () => {
    state.owner = false
    const { container, unmount } = renderWithProviders(<SceneSwitcher />)
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector('[data-testid="scene-switcher"]')).toBeNull()
    unmount()

    state.owner = true
    state.data = { available: false, unavailable_reason: '托管档', scenes: [], templates: [] }
    const second = renderWithProviders(<SceneSwitcher />)
    await waitFor(() => {
      expect(second.container.querySelector('[data-testid="scene-switcher"]')).toBeNull()
    })
  })

  it('托盘「管理场景…」带 ?scenes=1 进来：面板自己展开', async () => {
    renderWithProviders(<SceneSwitcher />, '/?scenes=1')
    expect(await screen.findByTestId('scene-panel')).toBeTruthy()
  })
})
