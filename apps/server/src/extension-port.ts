/**
 * WP119（68 / 52 O1）：**一个品牌一份**的插件端口。
 *
 * 配对那张表是**整台机器共用一张**（它本来就是"这台浏览器配上了哪个工作区"
 * 的记录，一把令牌上写着 `workspace_id`）；而 `ingest` / `hello` 要落到
 * **令牌上那个品牌**的红人库与加密库里——这正是 52 O1 那条：
 * 品牌 A 的红人在 B 的任何路由里都读不到，插件这条新路也不例外。
 *
 * 所以这个文件干的事只有一句：**按 session 上的 workspace_id 取那一套模块**。
 * 它自己不实现任何业务，业务在 `extension-service.ts` 里。
 */

import type { ExtensionPort, ExtensionStore } from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import type { ExtensionServiceOptions } from './extension-service.js'
import { createExtensionService } from './extension-service.js'

export interface BrandExtensionPortOptions {
  /** 整台机器共用那一张配对 / 令牌表。 */
  store: ExtensionStore
  /** 按工作区取一套装配好的选项（红人库、加密库、品牌名、云端转发口）。 */
  serviceOf(
    workspace_id: WorkspaceId,
  ): Promise<Omit<ExtensionServiceOptions, 'store' | 'workspace_id'>>
}

export function brandExtensionPort(options: BrandExtensionPortOptions): ExtensionPort {
  const cache = new Map<WorkspaceId, ExtensionPort>()

  const portOf = async (workspace_id: WorkspaceId): Promise<ExtensionPort> => {
    const hit = cache.get(workspace_id)
    if (hit !== undefined) return hit
    const made = createExtensionService({
      ...(await options.serviceOf(workspace_id)),
      workspace_id,
      store: options.store,
    })
    cache.set(workspace_id, made)
    return made
  }

  return {
    // 配对与令牌不按品牌分：一把令牌自己就带着 `workspace_id`。
    store: options.store,
    hello: async (session) => (await portOf(session.workspace_id)).hello(session),
    ingest: async (session, input) => (await portOf(session.workspace_id)).ingest(session, input),

    /* ── WP119c：每一条都按 session 上的 workspace_id 取那一套模块（52 O1 不变）── */
    setup: async (session) => (await portOf(session.workspace_id)).setup(session),
    saveCreator: async (session, input) =>
      (await portOf(session.workspace_id)).saveCreator(session, input),
    creatorReport: async (session, key) =>
      (await portOf(session.workspace_id)).creatorReport(session, key),
    revealPricing: async (session) => (await portOf(session.workspace_id)).revealPricing(session),
    contactLookup: async (session, key) =>
      (await portOf(session.workspace_id)).contactLookup(session, key),
    contactContribute: async (session, key, input) =>
      (await portOf(session.workspace_id)).contactContribute(session, key, input),
    contactDispute: async (session, key, input) =>
      (await portOf(session.workspace_id)).contactDispute(session, key, input),
    saveContact: async (session, input) =>
      (await portOf(session.workspace_id)).saveContact(session, input),
    contentObservation: async (session, input) =>
      (await portOf(session.workspace_id)).contentObservation(session, input),
    contentSave: async (session, input) =>
      (await portOf(session.workspace_id)).contentSave(session, input),
    bioLinkObservation: async (session, input) =>
      (await portOf(session.workspace_id)).bioLinkObservation(session, input),
    seedSignature: async (session, key) =>
      (await portOf(session.workspace_id)).seedSignature(session, key),

    /* ── WP131：「采集后自动评分」开关（每工作区一个，按 session 取那一套） ── */
    autoScore: async (session) => {
      const port = await portOf(session.workspace_id)
      if (port.autoScore === undefined) throw new Error('auto-score not wired')
      return port.autoScore(session)
    },
    setAutoScore: async (session, input) => {
      const port = await portOf(session.workspace_id)
      if (port.setAutoScore === undefined) throw new Error('auto-score not wired')
      return port.setAutoScore(session, input)
    },
  }
}
