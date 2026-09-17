/**
 * 在线值守在本地这一面的实现（49 §6 WP60、48 L7、41 §2.4）。
 *
 * 一句话职责：**把本地这一份搬上去，或者搬回来**。值守本身在云上跑
 * （`packages/standby` + `apps/cloud`），这一层只做三件事：
 *
 * 1. 问云上"现在什么状况"（状态、座位单价、到期时间）——**一个数字都不自己算**，
 *    与 WP59 的 `/v1/cloud/*` 逐字同一条纪律：自己算就是第二本账；
 * 2. 走 WP36 的 `export` 打一个包，传上去，开通；
 * 3. 反过来：从云上把包拉回来，落到备份目录，停掉云上那个进程。
 *
 * 两条边界：
 *
 * - **令牌只在一处出现**：秘密库里的 `cloud.workspace_token`（WP58 存进去的那把）。
 *   取出来直接进 `Authorization` 头，不落变量、不进事件、不进响应体、不进日志。
 * - **接回本机不自己 import**。把包落到备份目录，然后告诉用户下一步怎么走
 *   ——`agentsws import` 是对着一个**没在跑**的数据目录做的运维动作（WP36 那条注释
 *   一个字没改）：一个正在跑的服务进程把自己脚下的库换掉，换出来的是一份谁也读不懂的东西。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  StandbyActor,
  StandbyBringHomeView,
  StandbyPort,
  StandbySwitchView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  Clock,
  Iso8601,
  StandbyLocalView,
  StandbyStatus,
  StandbyWorkspace,
  WorkspaceId,
} from '@agentsws/contracts'
import { backupDirOf, exportWorkspace } from './backup.js'
import { cloudBaseUrl } from './cloud.js'
import { CLOUD_TOKEN_SECRET_ID } from './models.js'
import type { SecretStore } from './secret-store.js'

/** 打云侧最多等多久。传一个工作区的包可能要一会儿，所以比 `/v1/cloud/*` 那 8 秒宽得多。 */
export const STANDBY_TIMEOUT_MS = 180_000

/** 状态那一跳快得多：它只是一次读。 */
export const STANDBY_READ_TIMEOUT_MS = 8_000

const NOT_LINKED = '还没关联 agentsws 账号。去"设置 → 账号与积分"里关联一次，再回来开值守。'

const NO_STANDBY_SCOPE =
  '这台机器上的账号令牌还不能开值守。去云上的账号页重新关联一次，把"值守"这一项放开。'

export type StandbyFetch = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: Uint8Array
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface StandbyOptions {
  workspace_id: WorkspaceId
  clock: Clock
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** 本机数据目录；没有就没法导出（内存档），值守也就开不了。 */
  dbDir?: string
  /** 测试注入；不给就用全局 `fetch`。 */
  fetch?: StandbyFetch
  /** 桌面壳现在是不是远程模式（由 `AGENTSWS_SERVER_URL` 那一侧决定；这里只读不写）。 */
  remoteUrl?: () => string | undefined
}

export interface StandbyAssembly {
  port: StandbyPort
  /**
   * WP74：续期日上日历（图层 `standby`）。
   *
   * **只回最近一次真的从云上读到的那一份**，一个字节的网络都不打。日历那一屏
   * 每翻一页都会问一次来源，而值守状态在云上——在那条路上加一次带令牌的 HTTP
   * 请求，等于把一个"看看这周有什么"的动作变成会超时的动作。没读到过就没有，
   * 界面上那一层空着；打开一次"设置 → 在线值守"它就有了。
   */
  renewal(): StandbyRenewal | undefined
}

/** 值守续期日那一条（{@link StandbyAssembly.renewal}）。 */
export interface StandbyRenewal {
  workspace_id: WorkspaceId
  status: StandbyStatus
  period_end: Iso8601
  seats: number
}

/** `https://<云>/w/<ws>`：桌面壳与 widget 都指这个。 */
export function publicUrlOf(base: string, workspace_id: WorkspaceId): string {
  return `${base.replace(/\/+$/, '')}/w/${workspace_id}`
}

/** 商家复制到自己网站上的那一行。 */
export function embedSnippet(base: string, workspace_id: WorkspaceId): string {
  return `<script src="${publicUrlOf(base, workspace_id)}/widget.js" async></script>`
}

export function createStandby(options: StandbyOptions): StandbyAssembly {
  const { clock, secrets, env, workspace_id } = options
  const base = cloudBaseUrl(env)

  /** 工作区服务令牌（WP58 关联账号时存进去的）。**取值即用，不缓存。** */
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

  const doFetch: StandbyFetch =
    options.fetch ??
    (async (input, init) =>
      fetch(input, {
        method: init.method,
        headers: init.headers,
        // Uint8Array → 独占的 ArrayBuffer（`Buffer` 的底层是池子里的一块）
        ...(init.body === undefined ? {} : { body: init.body.slice().buffer as ArrayBuffer }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }))

  /** 打云侧一跳。`token` 由调用方确认过在——这里不做第二次判断。 */
  const call = async (
    path: string,
    init: { method: string; token: string; body?: Uint8Array; timeoutMs?: number },
  ): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    arrayBuffer(): Promise<ArrayBuffer>
  }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, init.timeoutMs ?? STANDBY_READ_TIMEOUT_MS)
    try {
      return await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${init.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/zip' }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 云侧的错误信封 → 一句人话（原样透传它写好的那句，别自己编第二句）。 */
  const humanize = async (
    res: { status: number; json(): Promise<unknown> },
    fallback: string,
  ): Promise<never> => {
    let message = fallback
    try {
      const body = (await res.json()) as { message?: string; code?: string }
      if (typeof body.message === 'string' && body.message !== '') message = body.message
      if (body.code === 'forbidden') message = `${message}（${NO_STANDBY_SCOPE}）`
    } catch {
      // 云侧回了一个不是 JSON 的东西：用兜底那句
    }
    // 402 / 422 / 503 都是"这一次不行"，不是"这台机器坏了"
    throw new ApiError(res.status === 402 ? 'budget_exhausted' : 'invalid_input', message, {
      status: res.status,
    })
  }

  const requireToken = (): string => {
    const token = tokenOf()
    // 409 conflict：不是"你写错了"，是"这台机器现在还不具备做这件事的条件"
    if (token === undefined) throw new ApiError('conflict', NOT_LINKED)
    return token
  }

  const requireDataDir = (): string => {
    const dir = options.dbDir
    if (dir === undefined)
      throw new ApiError('conflict', '这个服务进程跑在内存档上（没有数据目录），没有东西可以搬。')
    return dir
  }

  /** 云上那一份（没开通 / 云连不上都回 `undefined`，**不是错**）。 */
  const cloudView = async (token: string): Promise<StandbyWorkspace | undefined> => {
    try {
      const res = await call(`/v1/standby/workspaces/${workspace_id}`, { method: 'GET', token })
      if (!res.ok) return undefined
      return (await res.json()) as StandbyWorkspace
    } catch {
      return undefined
    }
  }

  const seatPrice = async (token: string): Promise<number | undefined> => {
    try {
      const res = await call('/v1/standby/workspaces', { method: 'GET', token })
      if (!res.ok) return undefined
      return ((await res.json()) as { seat_price?: number }).seat_price
    } catch {
      return undefined
    }
  }

  /** 最近一次真的读到的云上那一份（WP74 的续期日图层从它取；不打网络）。 */
  let lastKnown: StandbyRenewal | undefined

  const remember = (view: StandbyWorkspace): void => {
    lastKnown = {
      workspace_id: view.workspace_id,
      status: view.status,
      period_end: view.period_end,
      seats: view.seats,
    }
  }

  const port: StandbyPort = {
    async view(_actor: StandbyActor): Promise<StandbyLocalView> {
      const remote_url = options.remoteUrl?.()
      const token = tokenOf()
      if (token === undefined)
        return {
          linked: false,
          reason: NOT_LINKED,
          remote: false,
        }
      const [cloud, seat_price] = await Promise.all([cloudView(token), seatPrice(token)])
      if (cloud !== undefined) remember(cloud)
      /*
       * `remote_url` 与 `remote` 是两件事：前者是"桌面壳该指到哪儿"，后者是
       * "这台电脑现在是不是已经指过去了"。合成一格的话，还没切过去的人就看不到
       * 该填什么地址——而那正是他这一刻唯一需要的信息。
       */
      return {
        linked: true,
        remote: remote_url !== undefined && remote_url !== '',
        ...(cloud === undefined
          ? {}
          : {
              cloud,
              remote_url: publicUrlOf(base, workspace_id),
              embed_snippet: embedSnippet(base, workspace_id),
            }),
        ...(seat_price === undefined ? {} : { seat_price }),
      }
    },

    async switchToCloud(_actor, input): Promise<StandbySwitchView> {
      const token = requireToken()
      const dataDir = requireDataDir()

      // ③ 本地导出（WP36：一致性快照 + 清单 + 每个文件的 sha256）
      const out = join(
        backupDirOf(env, dataDir),
        `standby-${clock.now().replace(/[-:]/g, '').slice(0, 15)}.zip`,
      )
      mkdirSync(backupDirOf(env, dataDir), { recursive: true })
      const pkg = exportWorkspace({ dataDir, workspace_id, out, clock })

      // ④ 上传并开通。包**不经内存拼接**：读一次、传一次
      const bytes = new Uint8Array(readFileSync(pkg.out))
      const query = `seats=${String(input.seats)}${input.force === true ? '&force=true' : ''}`
      const res = await call(`/v1/standby/workspaces/${workspace_id}/import?${query}`, {
        method: 'POST',
        token,
        body: bytes,
        timeoutMs: STANDBY_TIMEOUT_MS,
      })
      if (!res.ok) await humanize(res, '云上没能开起来。')
      const view = (await res.json()) as StandbyWorkspace
      remember(view)
      return {
        status: view.status,
        remote_url: publicUrlOf(base, workspace_id),
        bytes: pkg.bytes,
        period_end: view.period_end,
        embed_snippet: embedSnippet(base, workspace_id),
      }
    },

    async bringHome(_actor): Promise<StandbyBringHomeView> {
      const token = requireToken()
      const dataDir = requireDataDir()

      // ① 先把云上那一份拉回来（到期停了也能导——41 §2.3 第一条纪律）
      const res = await call(`/v1/standby/workspaces/${workspace_id}/export`, {
        method: 'GET',
        token,
        timeoutMs: STANDBY_TIMEOUT_MS,
      })
      if (!res.ok) await humanize(res, '云上那一份没能导出来。')
      const buffer = Buffer.from(await res.arrayBuffer())
      const dir = backupDirOf(env, dataDir)
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `from-cloud-${clock.now().replace(/[-:]/g, '').slice(0, 15)}.zip`)
      writeFileSync(out, buffer)

      /*
       * ② 包**落地之后**才停云上那个进程。
       *
       * 顺序不能换：先停再导的话，中间任何一步出错（网络断、磁盘满）都会留下
       * 一个"云上停了、本地没有包"的状态——那时候这个工作区哪儿都不在跑。
       */
      const stop = await call(`/v1/standby/workspaces/${workspace_id}/stop`, {
        method: 'POST',
        token,
      })

      // 接回本机了就没有"下一次续期"这回事——那一层该当场空掉，不是继续画一个过时的日子
      if (stop.ok) lastKnown = undefined
      return {
        out,
        bytes: buffer.byteLength,
        stopped: stop.ok,
        next:
          `包已经落在 ${out}。停掉本机的服务进程，跑一次 ` +
          `\`agentsws import ${out}\`，再把桌面壳切回"本机"——` +
          '导入是对着没在跑的数据目录做的，不能在跑着的进程底下换库。',
      }
    },
  }

  return { port, renewal: () => lastKnown }
}
