/**
 * WP119（68 / 48 §5.3）：把插件采到的观测**转发去云端公共红人库**。
 *
 * 为什么这一跳在本机服务里而不在插件里（定论 2）：
 *
 * - 插件里不能有云令牌。一个装在浏览器里的扩展，其存储是可以被任何拿到这台
 *   电脑的人读出来的；而云令牌能代表整个工作区说话。插件只有一把
 *   **只能写本地红人库的三动作令牌**，丢了最多让别人往你的本地库里塞几条假数据。
 * - 「登录了就共享」这条判断要有一个**唯一的真源**。它在本机服务这一侧
 *   （`secrets` 里有没有那把工作区令牌），而不是插件里存的一个布尔。
 *
 * Luoye 09-19 定的那条在这里体现为：这个文件里**没有任何开关**。
 * 有令牌就送，没令牌就不送，没有第三种状态、也没有一个 `contribute: true` 的设置。
 */

import type { Iso8601, KolChannel } from '@agentsws/contracts'
import { cloudBaseUrl } from './cloud.js'
import { CLOUD_TOKEN_SECRET_ID } from './cloud-account.js'
import type { PublicLibraryContributor, PublicObservationRow } from './extension-service.js'
import type { KolPublicFetch } from './kol-public-client.js'
import { KOL_PUBLIC_PREFIX, KOL_PUBLIC_TIMEOUT_MS } from './kol-public-client.js'
import type { SecretStore } from './secret-store.js'

export interface ExtensionContributorOptions {
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** 测试注入（指向内存版云进程）；生产不传，走全局 fetch。 */
  fetch?: KolPublicFetch | undefined
}

/**
 * 一批最多发多少条。
 *
 * 云那一侧按 `{channel, handle}` 一条路径一个人（WP61 的自足键），所以这里
 * 是**一个人一次请求**——批量在插件那一侧已经分好块了（20 条一批），
 * 这里再攒一层只会让"哪一条没进去"更难说清。
 */
export const CONTRIBUTE_MAX_ROWS = 100

export function createExtensionContributor(
  options: ExtensionContributorOptions,
): PublicLibraryContributor {
  const base = `${cloudBaseUrl(options.env)}${KOL_PUBLIC_PREFIX}`
  const doFetch: KolPublicFetch =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<KolPublicFetch>)

  /** 这个品牌那把工作区服务令牌。**取值即用，不缓存、不落日志**。 */
  const tokenOf = (): string | undefined => {
    if (!options.secrets.available) return undefined
    try {
      const token = options.secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
      return token === undefined || token === '' ? undefined : token
    } catch {
      // 换过秘密库密钥：当成"没关联"
      return undefined
    }
  }

  async function postOne(token: string, row: PublicObservationRow): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, KOL_PUBLIC_TIMEOUT_MS)
    try {
      const channel: KolChannel = row.channel
      const path = `/creators/${encodeURIComponent(channel)}/${encodeURIComponent(row.handle)}/observations`
      /*
       * 送上去的**只有这几格**。
       *
       * 云那一侧的 `PUBLIC_OBSERVATION_FIELDS` 是一张更窄的白名单，多一个键整批拒；
       * 这里主动对齐，是为了让「插件到底往公共库送了什么」这个问题
       * 在这个仓库里有一个看得见的答案，而不是"去读云端的 schema"。
       */
      const body = {
        observations: [
          {
            channel,
            handle: row.handle,
            ...(row.followers === undefined ? {} : { followers: row.followers }),
            observed_at: row.observed_at as Iso8601,
          },
        ],
      }
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        // 令牌只在这一行进头
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      return res.ok
    } catch {
      // 网络不通 / 超时：这一条没送成。**不抛**——本机那一半已经写完了，
      // 让整个请求失败等于惩罚一个已经成功的动作。
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    // 「登录了没有」就是「这个品牌有没有那把工作区令牌」，没有第二处真源。
    linked: () => tokenOf() !== undefined,

    contribute: async (rows) => {
      const token = tokenOf()
      if (token === undefined) return { accepted: 0 }
      let accepted = 0
      for (const row of rows.slice(0, CONTRIBUTE_MAX_ROWS)) {
        if (await postOne(token, row)) accepted += 1
      }
      return { accepted }
    },
  }
}
