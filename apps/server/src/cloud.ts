/**
 * 云侧那一面在本地的装配（49 M2 / M5，WP59）。
 *
 * 一句话职责：把"云上的余额与价目"取过来给界面看，把"每项能力用谁的"存在本地。
 *
 * 四条纪律：
 *
 * 1. **本地不记账**。余额、用量、价目全是云上那一份的透传，本地一个数字都不自己算——
 *    自己算就是第二本账，两本账必然对不上（49 §1 的同一条理由）。
 * 2. **令牌只在一处出现**：`secret-store` 里的 `cloud.workspace_token`（WP58 存进去的）。
 *    取出来直接进 `Authorization` 头，不落变量、不进事件、不进响应体、不进日志。
 * 3. **没关联账号不是错**。回 `{ linked: false, reason }`，界面据此把按钮变成
 *    "先关联账号"，而不是画一堆 0 或者弹一个红框。
 * 4. **缓存 60 秒**。余额不是实时账，界面每切一次标签页就打一次云是浪费；
 *    充值成功之后用户会自己刷新，60 秒也等得起。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CloudActor, CloudPort } from '@agentsws/api'
import type {
  CapabilitySourceSettings,
  CapabilitySources,
  Clock,
  CloudCreditsView,
  Pricing,
  WalletBalance,
} from '@agentsws/contracts'
import { buildPricing } from '@agentsws/metering'
import { CLOUD_BASE_URL_ENV, CLOUD_TOKEN_SECRET_ID, DEFAULT_CLOUD_BASE_URL } from './models.js'
import type { SecretStore } from './secret-store.js'

/** 余额缓存多久（毫秒）。 */
export const CREDITS_CACHE_MS = 60_000

/** 打云侧最多等多久：卡住不该拖着设置页。 */
export const CLOUD_TIMEOUT_MS = 8_000

export type CloudFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

interface CapabilitySourcesFile {
  version: 1
  capability_sources: CapabilitySources
  updated_at?: string
}

export interface CloudOptions {
  clock: Clock
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** `capability-sources.json` 的目录；不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 测试注入；不给就用全局 `fetch`。 */
  fetch?: CloudFetch
}

export interface CloudAssembly {
  port: CloudPort
  /** 这台机器关联过 agentsws 账号没有（首页与模型卡问它）。 */
  linked(): boolean
}

export function cloudBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[CLOUD_BASE_URL_ENV]?.trim()
  return raw === undefined || raw === '' ? DEFAULT_CLOUD_BASE_URL : raw.replace(/\/+$/, '')
}

/** 本月一号零点（用量那条的起点）。 */
function monthStart(at: string): string {
  return `${at.slice(0, 7)}-01T00:00:00.000Z`
}

const NOT_LINKED =
  '还没关联 agentsws 账号。去"设置 → 账号与积分"里关联一次，就能用积分跑模型、看余额与用量。'

export function createCloud(options: CloudOptions): CloudAssembly {
  const { clock, secrets, env } = options
  const base = cloudBaseUrl(env)
  const stateFile =
    options.dbDir === undefined ? undefined : join(options.dbDir, 'capability-sources.json')

  let state: CapabilitySourcesFile = { version: 1, capability_sources: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as CapabilitySourcesFile
      state = {
        version: 1,
        capability_sources: parsed.capability_sources ?? {},
        ...(parsed.updated_at === undefined ? {} : { updated_at: parsed.updated_at }),
      }
    } catch {
      // 第一次跑，或者文件坏了：从空开始（空 = 全部"用我的"，正是默认值）
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /** 工作区服务令牌（WP58 关联账号时存进去的）。取值即用，不缓存。 */
  const tokenOf = (): string | undefined => {
    if (!secrets.available) return undefined
    try {
      const token = secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
      return token === undefined || token === '' ? undefined : token
    } catch {
      // 换过秘密库密钥：当成"没关联"
      return undefined
    }
  }

  const doFetch: CloudFetch =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<CloudFetch>)

  /** 打一次云侧。令牌在这一行进头，函数返回之后没人再引用它。 */
  const callCloud = async <T>(path: string): Promise<T | undefined> => {
    const token = tokenOf()
    if (token === undefined) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, CLOUD_TIMEOUT_MS)
    try {
      const res = await doFetch(`${base}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      const envelope = (await res.json()) as { data?: T }
      return envelope.data
    } catch {
      // 云连不上不是本地的错：界面上显示"暂时取不到"，不弹红框
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  let cached: { at: number; view: CloudCreditsView } | undefined

  const creditsView = async (): Promise<CloudCreditsView> => {
    const nowMs = Date.parse(clock.now())
    if (cached !== undefined && nowMs - cached.at < CREDITS_CACHE_MS) return cached.view
    if (tokenOf() === undefined) {
      const view: CloudCreditsView = { linked: false, reason: NOT_LINKED }
      cached = { at: nowMs, view }
      return view
    }
    const at = clock.now()
    const [balance, usage] = await Promise.all([
      callCloud<WalletBalance>('/v1/wallet'),
      callCloud<{ total_credits: number }>(
        `/v1/wallet/usage?group=capability&from=${encodeURIComponent(monthStart(at))}`,
      ),
    ])
    const view: CloudCreditsView =
      balance === undefined
        ? {
            linked: true,
            reason: '暂时取不到余额（云上连不通或者令牌被撤了）。稍后再看一眼。',
            fetched_at: at,
          }
        : {
            linked: true,
            balance,
            month_credits: usage?.total_credits ?? 0,
            fetched_at: at,
          }
    cached = { at: nowMs, view }
    return view
  }

  /** 云上的价目表；取不到就回本地内置那一份——价目表不该因为断网就一片空白。 */
  const pricingView = async (): Promise<Pricing> =>
    (await callCloud<Pricing>('/v1/wallet/pricing')) ?? buildPricing()

  const settingsOf = (actor: CloudActor): CapabilitySourceSettings => ({
    workspace_id: actor.workspace_id,
    capability_sources: { ...state.capability_sources },
    ...(state.updated_at === undefined ? {} : { updated_at: state.updated_at }),
  })

  const port: CloudPort = {
    credits: () => creditsView(),
    pricing: () => pricingView(),
    capabilitySources: (actor) => settingsOf(actor),
    setCapabilitySources(actor, input) {
      /*
       * **只存显式改过的那几项**：值是 `mine` 的一律不落盘。
       *
       * 为什么：`mine` 是默认，把默认值也写进文件等于把"今天的默认"腌成"这台机器的
       * 设置"——以后默认值真要改（比如某项能力本地那条没了），这些行会挡着。
       */
      const next: CapabilitySources = {}
      for (const [capability, source] of Object.entries(input.capability_sources)) {
        if (source === 'agentsws') next[capability] = source
      }
      state = { version: 1, capability_sources: next, updated_at: clock.now() }
      flush()
      return settingsOf(actor)
    },
  }

  return { port, linked: () => tokenOf() !== undefined }
}
