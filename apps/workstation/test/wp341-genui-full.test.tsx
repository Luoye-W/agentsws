/**
 * WP341（决策 847）工作台那一侧：genui 完全融合——按钮 / 表单 / 图片 / 链接都在对话里就地能用，动作交给工坊自己的处理器。
 *
 * - 点按钮 → 对话里出现那句话；交表单 → 一条结构化回话（摘要 + ```dsh-reply）；
 * - 「在对话里选 5 条 prompt 并确认」；日期格是原生日期框；
 * - 口令格：就地画那一样的本机表单，Secret 只打那条接口；交表单时只说「已填好」，值哪儿都没有；
 * - 外部图片先「点开看」（标域名），常见来源直接画；链接悬停显示真实域名、外部浏览器打开；
 * - 事项里的工具按钮走工具执行器：会改外部的只出卡（「出了 1 张卡」），只读的结果就地画；
 * - mermaid 引擎本机打包、用到才加载，不插外部 `<script>`。
 */
import { filterGenuiSpec, splitGenuiReply } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const SLOW = { timeout: 30_000 }
const SECRET = 'wecom_secret_wp341_never_leaves_the_form'

let wecomConnected = false
const saveWecomBot = vi.fn(async (_input: { bot_id: string; secret: string }) => {
  wecomConnected = true
  return {}
})
const runGenuiTool = vi.fn(async (_id: string, input: { tool: string }) =>
  input.tool === 'shop_set_price'
    ? { effect: 'staged' as const, status: 'ok' as const, approval_item_ids: ['ap_1'] }
    : {
        effect: 'read' as const,
        status: 'ok' as const,
        data: { products: [{ id: 'p1', title: '蓝牙耳机', price: 129 }] },
      },
)
const openExternal = vi.fn((_url: string) => undefined)
let imageHosts = {
  hosts: [] as { host: string; added_at: string }[],
  shop_hosts: ['shop.rollout.example'],
}
const addImageHost = vi.fn(async (host: string) => {
  imageHosts = {
    ...imageHosts,
    hosts: [{ host, added_at: '2026-10-15T00:00:00Z' }, ...imageHosts.hosts],
  }
  return imageHosts
})
const removeImageHost = vi.fn(async (host: string) => {
  imageHosts = { ...imageHosts, hosts: imageHosts.hosts.filter((h) => h.host !== host) }
  return imageHosts
})

vi.mock('@/components/connections/bridge', async () => {
  const actual = await vi.importActual<typeof import('@/components/connections/bridge')>(
    '@/components/connections/bridge',
  )
  return { ...actual, openExternal: (url: string) => openExternal(url) }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [{ position_id: 'asg_owner', role_id: 'common.owner', name: '负责人' }],
    }),
    listProviders: async () => ({ providers: [] }),
    listConnections: async () => ({ connections: [] }),
    getImStatus: async () => ({
      wechat: { bound: false, live: false, allowed: true },
      wecom: wecomConnected
        ? { configured: true, connected: true, state: 'connected', bot_id: 'BOT1' }
        : { configured: false, connected: false },
      can_manage: true,
    }),
    saveWecomBot: (input: { bot_id: string; secret: string }) => saveWecomBot(input),
    runGenuiTool: (id: string, input: { tool: string }) => runGenuiTool(id, input),
    getImageHosts: async () => imageHosts,
    addImageHost: (host: string) => addImageHost(host),
    removeImageHost: (host: string) => removeImageHost(host),
  }
})

beforeEach(() => {
  imageHosts = { hosts: [], shop_hosts: ['shop.rollout.example'] }
  addImageHost.mockClear()
  removeImageHost.mockClear()
  wecomConnected = false
  saveWecomBot.mockClear()
  runGenuiTool.mockClear()
  openExternal.mockClear()
})

const { GenuiHostProvider } = await import('@/components/answer/genui/genui-host')
const { SafeMarkdown } = await import('@/components/ui/safe-markdown')

const fenced = (body: unknown, lead = '看下面。'): string =>
  [lead, '', '```dsh-ui', JSON.stringify(body), '```'].join('\n')

function renderReply(text: string, host: Parameters<typeof GenuiHostProvider>[0]['value']) {
  return renderWithProviders(
    <GenuiHostProvider value={host}>
      <SafeMarkdown text={text} variant="chat" />
    </GenuiHostProvider>,
  )
}

describe('WP341 按钮 / 媒体 / 链接', () => {
  it('点按钮：对话里出现那句话（写好的那句 / 按钮上的字）', async () => {
    const say = vi.fn()
    renderReply(
      fenced({
        items: [
          { type: 'button', label: '改价', action: 'say:先把耳机改价' },
          { type: 'button', label: '上新', action: 'pick' },
        ],
      }),
      { say },
    )
    fireEvent.click(await screen.findByRole('button', { name: /改价/u }, SLOW))
    fireEvent.click(screen.getByRole('button', { name: /上新/u }))
    expect(say.mock.calls.map((c) => c[0])).toEqual(['先把耳机改价', '上新'])
  })

  it('常见来源的图直接画；外部的先「点开看 · 域名」；链接悬停是真实域名、外部浏览器打开', async () => {
    renderReply(
      fenced({
        items: [
          { type: 'image', src: 'https://cdn.shopify.com/s/box.jpg', alt: '主图' },
          { type: 'image', src: 'https://tracker.example/p.gif', alt: '外部图' },
          { type: 'text', content: '详见 [店铺后台](https://admin.evil.example/x)' },
        ],
      }),
      { say: vi.fn() },
    )
    const block = await screen.findByTestId('answer-genui', {}, SLOW)
    await waitFor(() => expect(block.querySelectorAll('img')).toHaveLength(1), SLOW)
    expect(block.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.shopify.com/s/box.jpg',
    )
    const gate = screen.getByTestId('genui-media-gate')
    expect(gate.textContent).toContain('tracker.example')
    fireEvent.click(gate)
    await waitFor(() => expect(block.querySelectorAll('img')).toHaveLength(2))
    const link = within(block).getByText('店铺后台').closest('a') as HTMLAnchorElement
    fireEvent.mouseOver(link)
    expect(link.title).toContain('admin.evil.example')
    fireEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://admin.evil.example/x')
  })
})

describe('WP341 表单', () => {
  it('在对话里选 5 条 prompt、填尺寸和日期、确认 → 一条结构化回话', async () => {
    const say = vi.fn()
    const prompts = ['夏日海边', '城市夜景', '森林晨雾', '雪山日出', '复古咖啡馆', '霓虹街头']
    renderReply(
      fenced({
        items: [
          { type: 'text', content: '挑 5 条用来出图：' },
          ...prompts.map((p) => ({ type: 'checkbox', group: 'prompts', label: p })),
          { type: 'select', id: 'size', label: '尺寸', options: ['1:1', '9:16'] },
          { type: 'input', id: 'when', label: '哪天发', inputType: 'date' },
          { type: 'submit', label: '就这 5 条', groups: ['prompts'] },
        ],
      }),
      { say },
    )
    const block = await screen.findByTestId('answer-genui', {}, SLOW)
    await waitFor(() => expect(block.textContent).toContain('霓虹街头'), SLOW)
    for (const p of prompts.slice(0, 5)) fireEvent.click(within(block).getByLabelText(p))
    fireEvent.change(block.querySelector('select') as HTMLSelectElement, {
      target: { value: '9:16' },
    })
    const date = block.querySelector('input[type="date"]') as HTMLInputElement
    expect(date).not.toBeNull()
    fireEvent.change(date, { target: { value: '2026-10-20' } })
    fireEvent.click(within(block).getByRole('button', { name: /就这 5 条/u }))
    expect(say).toHaveBeenCalledTimes(1)
    const text = String(say.mock.calls[0]?.[0])
    expect(text.startsWith('就这 5 条：')).toBe(true)
    const { reply } = splitGenuiReply(text)
    expect(reply?.answers?.prompts).toEqual(prompts.slice(0, 5))
    expect(reply?.fields).toEqual({ size: '9:16', when: '2026-10-20' })
  })

  it('口令格：就地是本机表单，Secret 只打那条接口；交表单只说「已填好」', async () => {
    const say = vi.fn()
    renderReply(
      fenced({
        items: [
          { type: 'input', id: 'bot', label: '机器人名字' },
          {
            type: 'input',
            id: 'secret',
            label: '企业微信 Secret',
            inputType: 'password',
            service: 'im:wecom',
          },
          { type: 'submit', label: '连上' },
        ],
      }),
      { say },
    )
    const secret = await screen.findByTestId('genui-secret', {}, SLOW)
    expect(secret.dataset.service).toBe('im:wecom')
    const form = await within(secret).findByTestId('wecom-form', {}, SLOW)
    const inputs = form.querySelectorAll('input')
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: 'BOT1' } })
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: SECRET } })
    fireEvent.submit(form)
    await waitFor(() => expect(saveWecomBot).toHaveBeenCalledTimes(1))
    expect(saveWecomBot.mock.calls[0]?.[0]).toEqual({ bot_id: 'BOT1', secret: SECRET })
    // 连上了：口令格那一行变绿（处理器记下「已填好」）
    await waitFor(() => expect(within(secret).queryByTestId('wecom-form')).toBeNull(), SLOW)
    const block = screen.getByTestId('answer-genui')
    const name = within(block).getByLabelText('机器人名字')
    fireEvent.change(name, { target: { value: '小助手' } })
    fireEvent.click(within(block).getByRole('button', { name: /连上/u }))
    expect(say).toHaveBeenCalledTimes(1)
    const text = String(say.mock.calls[0]?.[0])
    expect(text).toContain('企业微信 Secret：已填好')
    expect(JSON.stringify(say.mock.calls)).not.toContain(SECRET)
    expect(splitGenuiReply(text).reply?.secrets).toEqual(['企业微信 Secret'])
  })
})

describe('WP341 事项里的工具按钮', () => {
  it('会改外部的只出卡（「出了 1 张卡」）；只读的结果就地画成表', async () => {
    const say = vi.fn()
    const onToolDone = vi.fn()
    renderReply(
      fenced({
        items: [
          {
            type: 'button',
            label: '大号改到 25.9',
            action: 'tool:shop_set_price',
            args: { product_id: 'p1', price: 25.9 },
          },
          { type: 'button', label: '看看商品', action: 'tool:shop_list_products' },
        ],
      }),
      { say, matterId: 'mat_1', runId: 'run_1', onToolDone },
    )
    fireEvent.click(await screen.findByRole('button', { name: /大号改到/u }, SLOW))
    await waitFor(() =>
      expect(screen.getByTestId('genui-tool-result').textContent).toContain('1 张卡'),
    )
    expect(runGenuiTool).toHaveBeenCalledWith('mat_1', {
      tool: 'shop_set_price',
      args: { product_id: 'p1', price: 25.9 },
      label: '大号改到 25.9',
      run_id: 'run_1',
    })
    fireEvent.click(screen.getByRole('button', { name: /看看商品/u }))
    const result = await screen.findByText('蓝牙耳机', {}, SLOW)
    expect(result.closest('table')).not.toBeNull()
    expect(onToolDone).toHaveBeenCalledTimes(2)
    expect(say).not.toHaveBeenCalled()
  })

  it('没有工具执行器的对话（随便聊）：工具按钮把那句话发进对话', async () => {
    const say = vi.fn()
    renderReply(
      fenced({ items: [{ type: 'button', label: '查库存', action: 'tool:shop_list_products' }] }),
      {
        say,
      },
    )
    fireEvent.click(await screen.findByRole('button', { name: /查库存/u }, SLOW))
    expect(say).toHaveBeenCalledWith('查库存')
    expect(runGenuiTool).not.toHaveBeenCalled()
  })
})

describe('WP341 mermaid', () => {
  it('引擎本机打包、用到才加载，登记到插件约定的位置，不插外部 <script>', async () => {
    const before = document.querySelectorAll('script').length
    const { spec } = filterGenuiSpec({ items: [{ type: 'mermaid', code: 'graph TD\nA-->B' }] })
    if (spec === undefined) throw new Error('空')
    renderReply(fenced(spec), {})
    await screen.findByTestId('answer-genui', {}, SLOW)
    const assets = (globalThis as { __GenuiAssets__?: Record<string, unknown> }).__GenuiAssets__
    expect(Object.keys(assets ?? {})).toContain('mermaid')
    expect(document.querySelectorAll('script').length).toBe(before)
  }, 60_000)
})

describe('WP341 追加（849）外部图片白名单', () => {
  it('已连店铺的域名直接显示；别的网站点「以后都直接显示」就记进名单、马上显示', async () => {
    renderReply(
      fenced({
        items: [
          { type: 'image', src: 'https://shop.rollout.example/hero.jpg', alt: '店铺首图' },
          { type: 'image', src: 'https://pics.partner.example/a.jpg', alt: '合作方图' },
        ],
      }),
      { say: vi.fn() },
    )
    const block = await screen.findByTestId('answer-genui', {}, SLOW)
    await waitFor(() => expect(block.querySelectorAll('img')).toHaveLength(1), SLOW)
    expect(block.querySelector('img')?.getAttribute('src')).toBe(
      'https://shop.rollout.example/hero.jpg',
    )
    fireEvent.click(await screen.findByTestId('genui-media-always'))
    await waitFor(() => expect(addImageHost).toHaveBeenCalledWith('pics.partner.example'))
    await waitFor(() => expect(block.querySelectorAll('img')).toHaveLength(2))
  })

  it('设置里：能看（店铺那几个删不掉）、能删、能手动加', async () => {
    imageHosts = {
      hosts: [{ host: 'pics.partner.example', added_at: '2026-10-15T00:00:00Z' }],
      shop_hosts: ['shop.rollout.example'],
    }
    const { ImageHostsSetting } = await import('@/components/settings/image-hosts-setting')
    renderWithProviders(<ImageHostsSetting />)
    const row = await screen.findByTestId('settings-image-hosts')
    expect(row.textContent).toContain('shop.rollout.example')
    expect(
      within(row)
        .getAllByTestId('settings-image-host')
        .map((e) => e.textContent),
    ).toEqual(['pics.partner.example'])
    fireEvent.click(within(row).getByRole('button', { name: /删掉 pics\.partner\.example/u }))
    await waitFor(() => expect(removeImageHost).toHaveBeenCalledWith('pics.partner.example'))
    fireEvent.change(within(row).getByTestId('settings-image-hosts-input'), {
      target: { value: 'img.supplier.example' },
    })
    fireEvent.click(within(row).getByRole('button', { name: '加' }))
    await waitFor(() => expect(addImageHost).toHaveBeenCalledWith('img.supplier.example'))
    await waitFor(() =>
      expect(
        within(row)
          .getAllByTestId('settings-image-host')
          .map((e) => e.textContent),
      ).toEqual(['img.supplier.example']),
    )
  })
})
