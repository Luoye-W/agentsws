import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  availableConnectionKinds,
  CONNECTION_CATEGORIES,
  CONNECTION_DIRECTORY,
  type ConnectionDirectoryEntry,
  canonicalConnectionKind,
  connectionDirectoryByCategory,
  connectionDirectoryEntry,
  KOL_CHANNELS,
  SOCIAL_CHANNELS,
  MCP_SERVER_NAME_RE,
  validateMcpServer,
} from '../src/index.js'

const ROOT = join(import.meta.dirname, '../../..')

/** 仓库里所有职责模板 yml 的路径（`packages/roles/roles`、`packs/`、`role-packs/`）。 */
function roleYmlFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'dist') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.yml')) out.push(full)
    }
  }
  walk(join(ROOT, 'packages/roles/roles'))
  walk(join(ROOT, 'packs'))
  walk(join(ROOT, 'role-packs'))
  return out
}

/**
 * 从 yml 里抠出 `connectors:` 块里的 `kind:`。
 *
 * 故意**不**引 yaml 解析器：契约包一个依赖都没有（`package.json` 的 `dependencies: {}`），
 * 为一条断言把它破掉不值。这几个 yml 的写法是固定的行内映射，正则足够。
 */
function connectorKindsOf(text: string): string[] {
  const start = text.indexOf('\nconnectors:')
  if (start < 0) return []
  const rest = text.slice(start + 1)
  const end = rest.search(/\n[a-z_]+:/)
  const block = end < 0 ? rest : rest.slice(0, end)
  return [...block.matchAll(/\bkind:\s*([a-z_]+)/g)].map((m) => m[1] as string)
}

describe('54（将改号 55）§4 第一层：连接目录（WP83）', () => {
  it('kind 全表唯一，别名也不许和别的 kind 撞', () => {
    const kinds = CONNECTION_DIRECTORY.map((e) => e.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    const seen = new Set(kinds)
    for (const entry of CONNECTION_DIRECTORY)
      for (const alias of entry.aliases ?? []) {
        expect(seen.has(alias), `别名 ${alias} 和某个 kind 撞了`).toBe(false)
        seen.add(alias)
      }
  })

  it('每一条都填满了必填格，且枚举都在契约的词表里', () => {
    const auths = ['oauth', 'api_key', 'client_credentials', 'qr', 'password', 'none']
    const modes = ['openconnector_provider', 'mcp_server', 'channel_adapter', 'browser', 'builtin']
    const categories = CONNECTION_CATEGORIES.map((c) => c.id)
    for (const e of CONNECTION_DIRECTORY) {
      expect(e.kind, `${e.kind} 的 kind 不合法`).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(e.name.zh.length).toBeGreaterThan(0)
      expect(e.name.en.length).toBeGreaterThan(0)
      expect(categories).toContain(e.category)
      expect(auths).toContain(e.auth)
      expect(modes).toContain(e.mode)
      expect(['read_external', 'write_external', 'local']).toContain(e.side_effect)
      expect(['available', 'planned']).toContain(e.status)
    }
  })

  it('字段描述里只有"是不是密码"，没有任何值——13 §4.3 的那条线', () => {
    for (const e of CONNECTION_DIRECTORY)
      for (const f of e.fields) {
        expect(Object.keys(f)).not.toContain('value')
        expect(Object.keys(f)).not.toContain('default')
        expect(typeof f.secret).toBe('boolean')
        expect(f.name).toMatch(/^[a-z][a-z0-9_]*$/)
      }
  })

  it('外链要么是 https，要么是站内路由（微信两条指向 /im-channels）', () => {
    for (const e of CONNECTION_DIRECTORY) {
      if (e.docs_url === undefined) continue
      expect(e.docs_url.startsWith('https://') || e.docs_url.startsWith('/')).toBe(true)
    }
    expect(connectionDirectoryEntry('wechat_clawbot')?.docs_url).toBe('/im-channels')
    expect(connectionDirectoryEntry('wecom_bot')?.docs_url).toBe('/im-channels')
    // 两条都还没做：目录上要明着说，不许藏起来
    expect(connectionDirectoryEntry('wechat_clawbot')?.status).toBe('planned')
    expect(connectionDirectoryEntry('wecom_bot')?.mode).toBe('channel_adapter')
  })

  it('覆盖①：仓库里每一条职责模板问的 kind，目录里都查得到', () => {
    const files = roleYmlFiles()
    // 万一以后目录挪了位置，这条断言别默默变成空跑
    expect(files.length).toBeGreaterThan(5)
    const missing = new Set<string>()
    for (const file of files)
      for (const kind of connectorKindsOf(readFileSync(file, 'utf8')))
        if (connectionDirectoryEntry(kind) === undefined) missing.add(kind)
    expect([...missing]).toEqual([])
  })

  it('覆盖②：红人五条渠道的 connector_kind 都在目录里', () => {
    for (const c of KOL_CHANNELS) expect(connectionDirectoryEntry(c.connector_kind)).toBeDefined()
  })

  // WP72（56 §1）：社媒运营那九条。Facebook 群组没有 `connector_kind`——
  // Groups API 已停，它走受控浏览器；目录里给它一张点不动的卡比不给更糟。
  it('覆盖③：九条社媒渠道的 connector_kind 都在目录里（Facebook 群组没有卡）', () => {
    for (const c of SOCIAL_CHANNELS) {
      if (c.connector_kind === undefined) {
        expect(c.id, 'Facebook 群组之外的渠道都该有一张卡').toBe('facebook_group')
        expect(c.mode).toBe('browser')
        continue
      }
      expect(connectionDirectoryEntry(c.connector_kind), c.id).toBeDefined()
    }
    // 56 §1：YouTube 与红人岗位共用同一张卡——目录里只有一条 `youtube_data`
    expect(CONNECTION_DIRECTORY.filter((e) => e.kind === 'youtube_data')).toHaveLength(1)
    // 社媒那几张卡是**发东西**的，不是只读的（与红人那几条分得开）
    for (const kind of ['meta_graph', 'tiktok_content', 'reddit', 'discord_bot', 'telegram_bot'])
      expect(connectionDirectoryEntry(kind)?.side_effect, kind).toBe('write_external')
    // WhatsApp 的三条规矩要写在准备说明里（56 §1 末行），不能等人撞墙
    const wa = connectionDirectoryEntry('whatsapp_business')
    expect(wa?.note?.zh).toContain('模板')
    expect(wa?.note?.zh).toContain('opt-in')
    expect(wa?.note?.zh).toContain('24 小时')
  })

  it('覆盖③：已经有 provider 的那几家都在，且各自指得到连接页的卡', () => {
    const wanted: Record<string, string> = {
      email: 'imap_smtp',
      shopify: 'shopify_admin',
      woocommerce: 'woocommerce',
      ga4: 'ga4',
      search_console: 'gsc',
    }
    for (const [kind, service] of Object.entries(wanted))
      expect(connectionDirectoryEntry(kind)?.service, kind).toBe(service)
    // 亚马逊 SP-API 登记了但还没做；职责模板里的老名字 `amazon` 认得出来
    expect(connectionDirectoryEntry('amazon_sp')?.status).toBe('planned')
    expect(connectionDirectoryEntry('amazon')?.kind).toBe('amazon_sp')
  })

  it('别名归一：gsc 与 search_console、amazon 与 amazon_sp 是同一条', () => {
    expect(canonicalConnectionKind('gsc')).toBe('search_console')
    expect(canonicalConnectionKind('amazon')).toBe('amazon_sp')
    expect(canonicalConnectionKind('shopify_admin')).toBe('shopify')
    // 认不出来的原样回去——**不编一条出来**
    expect(canonicalConnectionKind('xiaohongshu')).toBe('xiaohongshu')
    expect(connectionDirectoryEntry('xiaohongshu')).toBeUndefined()
  })

  it('平台中立的 shop 要按公司档案解析，所以它自己没有卡', () => {
    const shop = connectionDirectoryEntry('shop') as ConnectionDirectoryEntry
    expect(shop.resolved_by_profile).toBe(true)
    expect(shop.service).toBeUndefined()
  })

  it('自定义 MCP 服务器是一个正经条目，字段齐全', () => {
    const mcp = connectionDirectoryEntry('mcp_server') as ConnectionDirectoryEntry
    expect(mcp.mode).toBe('mcp_server')
    expect(mcp.status).toBe('available')
    expect(mcp.fields.map((f) => f.name)).toEqual([
      'name',
      'transport',
      'command',
      'args',
      'url',
      'headers',
    ])
    // 请求头当凭据看
    expect(mcp.fields.find((f) => f.name === 'headers')?.secret).toBe(true)
    expect(mcp.fields.find((f) => f.name === 'transport')?.options).toEqual([
      'stdio',
      'streamable-http',
    ])
  })

  it('按分类分组：顺序照词表、空分类不出现、一条不落', () => {
    const groups = connectionDirectoryByCategory()
    const order = CONNECTION_CATEGORIES.map((c) => c.id).filter((id) =>
      CONNECTION_DIRECTORY.some((e) => e.category === id),
    )
    expect(groups.map((g) => g.category)).toEqual(order)
    expect(groups.reduce((n, g) => n + g.entries.length, 0)).toBe(CONNECTION_DIRECTORY.length)
  })

  it('点得动的那几条 = status available', () => {
    expect(availableConnectionKinds()).toEqual(
      CONNECTION_DIRECTORY.filter((e) => e.status === 'available').map((e) => e.kind),
    )
    expect(availableConnectionKinds()).toContain('email')
    expect(availableConnectionKinds()).not.toContain('amazon_sp')
  })
})

describe('自定义 MCP 服务器的校验（纯函数，不联网）', () => {
  it('名字只收小写字母 / 数字 / 短横线', () => {
    expect(MCP_SERVER_NAME_RE.test('my-tools')).toBe(true)
    expect(MCP_SERVER_NAME_RE.test('-bad')).toBe(false)
    expect(MCP_SERVER_NAME_RE.test('Bad')).toBe(false)
    expect(validateMcpServer({ name: 'Bad', transport: 'stdio', command: 'x' })).toHaveLength(1)
  })

  it('stdio 要命令、不要地址', () => {
    expect(validateMcpServer({ name: 'a', transport: 'stdio', command: 'npx' })).toEqual([])
    expect(validateMcpServer({ name: 'a', transport: 'stdio' })).toContain('stdio 要填「命令」')
    expect(
      validateMcpServer({ name: 'a', transport: 'stdio', command: 'npx', url: 'https://x.dev' }),
    ).toContain('stdio 不要填「地址」')
  })

  it('streamable-http 要 https（本机除外），不要命令', () => {
    expect(
      validateMcpServer({ name: 'a', transport: 'streamable-http', url: 'https://x.dev/mcp' }),
    ).toEqual([])
    expect(
      validateMcpServer({ name: 'a', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }),
    ).toEqual([])
    // 明文 http 发出去等于把 Bearer token 交给同一个网络里的任何人
    expect(
      validateMcpServer({ name: 'a', transport: 'streamable-http', url: 'http://x.dev/mcp' }),
    ).toContain('「地址」必须是 https（本机 127.0.0.1 / localhost 除外）')
    expect(validateMcpServer({ name: 'a', transport: 'streamable-http' })).toContain(
      'streamable-http 要填「地址」',
    )
    expect(
      validateMcpServer({ name: 'a', transport: 'streamable-http', url: '不是 URL' }),
    ).toContain('「地址」不是一个合法的 URL')
  })

  it('请求头的名字要是合法的 HTTP 头名（防止有人把整行 `a: b` 当名字填）', () => {
    expect(
      validateMcpServer({
        name: 'a',
        transport: 'stdio',
        command: 'x',
        headers: { Authorization: 'Bearer t' },
      }),
    ).toEqual([])
    expect(
      validateMcpServer({
        name: 'a',
        transport: 'stdio',
        command: 'x',
        headers: { 'Authorization: Bearer t': 'y' },
      }),
    ).toHaveLength(1)
  })
})
