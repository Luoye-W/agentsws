/**
 * WP283（决策 300 / 301）：
 * - 300：改图认不认遮罩按**型号能力表**判——经 Agents 工坊云（OpenRouter / Seedream）不认、自己的 OpenAI key 认；
 *   生图那一档的 `using.edit_mask` 告诉工作台给不给「圈区域」；不认的型号给了遮罩也不往上游带、回话里照实说。
 * - 301：本机设置里存的 `gpt-image-1.5` 读的时候当 `gpt-image-2`，写的时候也不存它；型号清单里不再出现。
 *
 * 起真服务进程 + 假上游；工具那一半用内存小替身。不联网、不花钱。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelImageView, ModelListing, ModelProviderView } from '@agentsws/api'
import type { ApprovalItem, ImageEditRequest, ImageProvider, RunRequest } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { encodePng, stubImageProvider } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrandAssets } from '../src/brand-assets.js'
import { createDesignStore } from '../src/design.js'
import { createImageService, MASK_IGNORED_ZH } from '../src/image-tools.js'
import { createServer, type Server } from '../src/index.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-09T09:00:00.000Z'

interface Call {
  url: string
  model: string | undefined
  mask: boolean
}

function fakeUpstream(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    let model: string | undefined
    let mask = false
    if (typeof init.body === 'string') {
      try {
        model = (JSON.parse(init.body) as { model?: string }).model
      } catch {
        model = undefined
      }
    } else if (init.body instanceof FormData) {
      model = String(init.body.get('model'))
      mask = init.body.get('mask') !== null
    }
    calls.push({ url, model, mask })
    const body = url.includes('/images/')
      ? { data: [{ b64_json: Buffer.from([1, 2]).toString('base64') }] }
      : url.endsWith('/models')
        ? {
            object: 'list',
            data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-image-1.5' }, { id: 'gpt-image-2' }],
          }
        : { choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 1 } }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  return { fetch, calls }
}

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function bootOptions(dir: string, fetch: FetchLike): Parameters<typeof createServer>[0] {
  let t = Date.parse(T0)
  return {
    dbDir: dir,
    clock: { now: () => new Date(t).toISOString() },
    random: () => {
      t += 1
      return 0.5
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      AGENTSWS_WORKSPACE_NAME: '测试品牌',
      [SECRETS_KEY_ENV]: 'd'.repeat(64),
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
    modelFetch: fetch,
    cloudFetch: async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }),
  }
}

async function boot(): Promise<{ server: Server; calls: Call[]; dir: string; fetch: FetchLike }> {
  const upstream = fakeUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp283-mask-'))
  dirs.push(dir)
  const server = await createServer(bootOptions(dir, upstream.fetch))
  servers.push(server)
  return { server, calls: upstream.calls, dir, fetch: upstream.fetch }
}

async function call<T>(server: Server, method: string, path: string, body?: unknown): Promise<T> {
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': server.bootstrap.ownerAssignment.id,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T; message?: string }
  if (res.status >= 400) throw new Error(`${String(res.status)} ${parsed.message ?? ''}`)
  return parsed.data as T
}

const view = (server: Server) => call<ModelImageView>(server, 'GET', '/v1/models/image')

const OPENAI = {
  kind: 'openai_compatible',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  region: 'global',
  api_key: 'sk-wp283-openai',
}
const DEEPSEEK = {
  kind: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  api_key: 'sk-wp283-deepseek',
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
const meta = { workspace_id: 'ws', run_id: 'run_1', purpose: 'run' } as never

describe('WP283 300：改图认不认遮罩按型号能力表判', () => {
  it('自己的 OpenAI key（GPT Image 2.5 直连）认：using.edit_mask = true，遮罩照带', async () => {
    const { server, calls } = await boot()
    await call(server, 'PUT', '/v1/models/providers/openai', OPENAI)
    expect((await view(server)).using).toMatchObject({ source: 'own_openai', edit_mask: true })
    expect(server.models.images.supports_mask).toBe(true)
    await server.models.images.edit?.({
      prompt: 'swap bg',
      images: [{ bytes: png, content_type: 'image/png' }],
      mask: { bytes: png, content_type: 'image/png' },
      meta,
    })
    expect(calls.find((c) => c.url.endsWith('/images/edits'))?.mask).toBe(true)
  })

  it('走 Agents 工坊积分（GPT Image 2.5 经 OpenRouter）不认：edit_mask = false，遮罩不往云上带', async () => {
    const { server, calls } = await boot()
    await call(server, 'PUT', '/v1/models/providers/deepseek', DEEPSEEK)
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_wp283' })
    expect((await view(server)).using).toMatchObject({ source: 'cloud', edit_mask: false })
    expect(server.models.images.supports_mask).toBe(false)
    await server.models.images.edit?.({
      prompt: 'swap bg',
      images: [{ bytes: png, content_type: 'image/png' }],
      mask: { bytes: png, content_type: 'image/png' },
      meta,
    } as ImageEditRequest)
    const hit = calls.find((c) => c.url.endsWith('/v1/ai/images/edits'))
    expect(hit?.model).toBe('gpt-image-2.5-sunburst')
    expect(hit?.mask).toBe(false)
  })

  it('单独指定积分卡 + Seedream / Nano Banana / gpt-image-1 经云：都不认；自定义兼容口的 gpt-image-1：认', async () => {
    const { server } = await boot()
    await call(server, 'PUT', '/v1/models/providers/deepseek', DEEPSEEK)
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_wp283' })
    await call(server, 'PUT', '/v1/models/providers/agentsws', {
      kind: 'agentsws_cloud',
      model: 'deepseek-flash',
    })
    for (const model of [
      'doubao-seedream-5-0-pro-260628',
      'gemini-nano-banana-2.1',
      'gpt-image-1',
    ]) {
      const v = await call<ModelImageView>(server, 'PUT', '/v1/models/image', {
        provider_id: 'agentsws',
        model,
      })
      expect(v.using?.edit_mask, model).toBe(false)
    }
    await call(server, 'PUT', '/v1/models/providers/myimg', {
      kind: 'openai_compatible',
      base_url: 'https://images.example.test/v1',
      model: 'gpt-image-1',
      region: 'global',
      api_key: 'sk-wp283-custom',
      image_only: true,
    })
    const custom = await call<ModelImageView>(server, 'PUT', '/v1/models/image', {
      provider_id: 'myimg',
      model: 'gpt-image-1',
    })
    expect(custom.using).toMatchObject({ source: 'override', edit_mask: true })
  })
})

describe('WP283 301：gpt-image-1.5 读到当 gpt-image-2', () => {
  it('老设置里存着 1.5：读出来是 2、出图打的也是 2；保存 1.5 也存成 2', async () => {
    const { server, calls, dir } = await boot()
    await call(server, 'PUT', '/v1/models/providers/openai', OPENAI)
    await call(server, 'PUT', '/v1/models/image', {
      provider_id: 'openai',
      model: 'gpt-image-1.5',
      edit_model: 'gpt-image-1.5-2025-12-16',
    })
    const v = await view(server)
    expect(v.model).toBe('gpt-image-2')
    expect(v.edit_model).toBeUndefined()
    expect(v.using).toMatchObject({ generate_model: 'gpt-image-2', edit_model: 'gpt-image-2' })
    // 写进文件的就是 2（写的时候也不存退役型号）
    const files = JSON.stringify(readModelsFiles(dir))
    expect(files).not.toContain('gpt-image-1.5')
    await server.models.images.generate({ prompt: 'x', meta })
    expect(calls.find((c) => c.url.endsWith('/images/generations'))?.model).toBe('gpt-image-2')
  })

  it('文件里手写的老值（升级前存下的）：读时映射，不改文件', async () => {
    const { server, dir, fetch } = await boot()
    await call(server, 'PUT', '/v1/models/providers/openai', OPENAI)
    await call(server, 'PUT', '/v1/models/image', { provider_id: 'openai', model: 'gpt-image-2' })
    const file = modelsFile(dir)
    const raw = readFileSync(file, 'utf8').replaceAll('gpt-image-2', 'gpt-image-1.5')
    writeFileSync(file, raw)
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const again = await createServer(bootOptions(dir, fetch))
    servers.push(again)
    const v = await view(again)
    expect(v.model).toBe('gpt-image-2')
    expect(v.using?.generate_model).toBe('gpt-image-2')
    expect(readFileSync(file, 'utf8')).toContain('gpt-image-1.5')
  })

  it('拉回来的型号清单里不出现 1.5（老清单里存着的也不给界面）', async () => {
    const { server } = await boot()
    const listing = await call<ModelListing>(server, 'POST', '/v1/models/providers/x/discover', {
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-wp283-openai',
      region: 'global',
    })
    expect(listing.models).toEqual(['gpt-4o-mini', 'gpt-image-2'])
    await call(server, 'PUT', '/v1/models/providers/openai', OPENAI)
    const list = await call<{ providers: ModelProviderView[] }>(
      server,
      'GET',
      '/v1/models/providers',
    )
    const openai = list.providers.find((p) => p.id === 'openai')
    expect(openai?.models ?? []).not.toContain('gpt-image-1.5')
  })
})

describe('WP283 300：工具那一半——型号不认遮罩就不带，回话里照实说', () => {
  const NOW = '2026-10-09T09:00:00.000Z'
  const tinyPng = (seed: number): Uint8Array =>
    encodePng(2, 2, new Uint8Array([0, seed, 0, 0, seed, 0, 0, 0, 0, seed, 0, 0, 0, 0]), 'rgb')
  const req = {
    id: 'run_1',
    actor: { person_id: 'per_owner', assignment_id: 'asg_1', role_id: 'design.social' },
    work_item: { id: 'mat_1' },
  } as unknown as RunRequest

  const harness = (supports_mask: boolean | undefined) => {
    const assets = createBrandAssets({
      workspace_id: 'ws_1' as never,
      store: createDesignStore({ workspace_id: 'ws_1' as never }),
      clock: { now: () => NOW },
      random: () => 0.5,
    })
    const seen: { mask: boolean }[] = []
    const stub = stubImageProvider({ seed: 3 })
    const provider: ImageProvider = {
      ...stub,
      ...(supports_mask === undefined ? {} : { supports_mask }),
      edit: async (r) => {
        seen.push({ mask: r.mask !== undefined })
        return (stub.edit as NonNullable<ImageProvider['edit']>)(r)
      },
    }
    const cards: ApprovalItem[] = []
    const svc = createImageService({
      workspace_id: 'ws_1' as never,
      clock: { now: () => NOW },
      assets,
      images: () => provider,
      pricing: () => ({ official: true, per_image: 0.5, per_edit: 0.8 }),
      approvals: () =>
        ({
          create: async (input: Record<string, unknown>) => {
            const item = { ...input, id: `apr_${cards.length + 1}` } as unknown as ApprovalItem
            cards.push(item)
            return item
          },
        }) as never,
      work: () => ({ onCard: () => ({}), appendEvent: () => undefined }) as never,
    })
    return { assets, svc, seen }
  }

  it('不认（经云）：不带遮罩，回话开头说「按提示词整张改」', async () => {
    const { assets, svc, seen } = harness(false)
    const ref = await assets.importUpload({ bytes: tinyPng(1), filename: 'box.png' })
    const mask = await assets.importUpload({ bytes: tinyPng(2), filename: 'mask.png' })
    const out = await svc.executeTool({
      name: 'edit_image',
      input: { prompt: 'only the table', asset_ids: [ref.id], mask_asset_id: mask.id, n: 1 },
      request: req,
    })
    expect(out.status).toBe('ok')
    expect(seen).toEqual([{ mask: false }])
    expect((out.data as { message: string }).message.startsWith(MASK_IGNORED_ZH)).toBe(true)
  })

  it('认 / 不知道（老实现）：遮罩照带，回话不多那一句', async () => {
    for (const flag of [true, undefined]) {
      const { assets, svc, seen } = harness(flag)
      const ref = await assets.importUpload({ bytes: tinyPng(1), filename: 'box.png' })
      const mask = await assets.importUpload({ bytes: tinyPng(2), filename: 'mask.png' })
      const out = await svc.executeTool({
        name: 'edit_image',
        input: { prompt: 'only the table', asset_ids: [ref.id], mask_asset_id: mask.id, n: 1 },
        request: req,
      })
      expect(seen).toEqual([{ mask: true }])
      expect((out.data as { message: string }).message).not.toContain(MASK_IGNORED_ZH)
    }
  })
})

/* ── 小工具：找模型设置文件（品牌那一份）──────────────────────────────── */

function findFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...findFiles(p))
    else out.push(p)
  }
  return out
}

function modelsFile(dir: string): string {
  const hit = findFiles(dir).find(
    (f) => /models.*\.json$/.test(f) && readFileSync(f, 'utf8').includes('"image"'),
  )
  if (hit === undefined) throw new Error('models file not found')
  return hit
}

function readModelsFiles(dir: string): unknown[] {
  return findFiles(dir)
    .filter((f) => /models.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(f, 'utf8')) as unknown)
}
