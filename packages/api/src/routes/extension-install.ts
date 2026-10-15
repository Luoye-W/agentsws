/**
 * WP345（决策 871）：**插件随工坊安装与更新**的本机一面。
 *
 * 插件不上架商店。桌面版把安装包里的插件放到数据目录下一个固定文件夹（`apps/desktop/src/extension-sync.ts`），
 * 用户第一次「加载已解压」选它；之后工坊换掉文件夹里的文件，插件空闲时自己 `runtime.reload()`。
 *
 * 两种调用方，判权与 `/v1/extension/*` 那一套完全一样：
 *
 * - **工作台**（Bearer + `X-Assignment`）：`GET /v1/extension/install` 看文件夹在哪、里面是哪一版、上次换成没有、
 *   已配上的插件正在跑哪一版；`POST /v1/extension/install/open` 让本机打开插件文件夹 / Chrome 扩展页
 *   （连接卡上那两个按钮：网页自己打不开 `chrome://`，也打不开本机文件夹）。
 * - **插件**（插件令牌 + Origin）：`POST /v1/extension/version` 报自己正在跑的版本（重载之后报「从哪版换来」，
 *   重载了还是旧版报「放弃了」），回文件夹里是哪一版。插件每分钟问一次——这就是「新版已到位」的那条通道：
 *   还是插件主动找本机，本机永远不伸手进浏览器。
 */

import type { Iso8601, MaybePromise, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ExtensionSession } from '../extension-store.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { extensionSessionOf } from './extension.js'

/** 桌面壳上次换文件夹的结果（`<文件夹>.json`）。 */
export interface ExtensionFolderSync {
  status: 'installed' | 'updated' | 'unchanged' | 'failed' | 'no_bundle'
  at: Iso8601
  /** 没换成的原因（`failed` 才有）。 */
  error?: string
}

/** 一个已配上的插件正在跑的版本（插件自己报的；本机重启后要等它下一次来问才有）。 */
export interface ExtensionRunningVersion {
  token_id: string
  extension_id: string
  version: string
  at: Iso8601
  /** 重载过、还是没换成文件夹里那一版（多半是从别的文件夹加载的）：这里是它想换成的那一版。 */
  stuck_on?: string
}

/** `GET /v1/extension/install` 的回执。 */
export interface ExtensionInstallView {
  /** 插件的固定文件夹（桌面版才有；服务在别的电脑上 / 开发时直接跑服务没有）。 */
  folder?: string
  /** 文件夹里那一版（manifest 的 `version_name`，没有就 `version`）。 */
  folder_version?: string
  /** 安装包里带的那一版（与 `folder_version` 不一样 = 上次没换成）。 */
  bundled_version?: string
  sync?: ExtensionFolderSync
  /** 这个工作区里已配上的插件各自正在跑的版本。 */
  running: ExtensionRunningVersion[]
  /** 这台电脑上能不能打开文件夹 / Chrome 扩展页（有固定文件夹 = 服务就在这台电脑上）。 */
  can_open: boolean
}

export type ExtensionOpenTarget = 'folder' | 'chrome'

export interface ExtensionOpenResult {
  opened: boolean
  /** 没打开时的一句人话（没找到 Chrome / 这台电脑上没有插件文件夹）。 */
  message?: string
  /**
   * 打开扩展页时：要粘贴到地址栏的那个地址（`chrome://extensions` / `edge://extensions`）。
   * Chrome 不让从外面直接打开 `chrome://` 页（实测 155：命令行带上它只开一个新标签页），所以卡上把它复制好、
   * 说一句「地址栏粘贴」。
   */
  address?: string
}

/** 插件报版本的入参。 */
export interface ExtensionVersionReport {
  /** 正在跑的版本（`version_name`，没有就 `version`）。 */
  version: string
  /** 刚因为工坊换了新版而重载：重载前是哪一版。 */
  reloaded_from?: string
  /** 重载过一次、还是没换成：想换成的那一版（插件不再为它重试）。 */
  gave_up?: string
}

export interface ExtensionVersionReply {
  /** 工坊文件夹里那一版；没有固定文件夹（不是桌面版）就没有这一格，插件什么都不做。 */
  folder_version?: string
}

export interface ExtensionInstallPort {
  view(workspace_id: WorkspaceId): MaybePromise<ExtensionInstallView>
  open(target: ExtensionOpenTarget): Promise<ExtensionOpenResult>
  report(
    session: ExtensionSession,
    input: ExtensionVersionReport,
  ): MaybePromise<ExtensionVersionReply>
}

/** 读与连接页同一把闸；「打开」与发配对码同一把（装插件和授权连接器是同一类事）。 */
const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const MANAGE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

function portOf(deps: GatewayDeps): ExtensionInstallPort {
  const p = deps.extensionInstall
  if (p === undefined)
    throw new ApiError('not_implemented', '这个本机服务版本还不会随工坊安装 / 更新插件。')
  return p
}

const VERSION = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.+-]+$/, '版本号只认数字、字母与 . + -')

const openSchema = z.object({ target: z.enum(['folder', 'chrome']) }).strict()
const reportSchema = z
  .object({
    version: VERSION,
    reloaded_from: VERSION.optional(),
    gave_up: VERSION.optional(),
  })
  .strict()

export function extensionInstallRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/extension/install',
        operationId: 'extensionInstallView',
        summary: '插件装在哪、文件夹里是哪一版、上次换成没有、已配上的插件正在跑哪一版',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ExtensionInstallView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/install/open',
        operationId: 'extensionInstallOpen',
        summary: '在这台电脑上打开插件文件夹 / Chrome 扩展页（连接卡上那两个按钮）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        body: openSchema,
        returns: 'ExtensionOpenResult',
      },
      async (c, deps) => {
        const input = await body(c, openSchema)
        return ok(c, await portOf(deps).open(input.target))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/version',
        operationId: 'extensionVersionReport',
        summary: '插件报自己正在跑的版本、问工坊文件夹里是哪一版（每分钟一次；重载后报从哪版换来）',
        tag: 'extension',
        auth: 'public',
        body: reportSchema,
        returns: 'ExtensionVersionReply',
      },
      async (c, deps) => {
        const session = extensionSessionOf(c, deps)
        const input = await body(c, reportSchema)
        return ok(c, await portOf(deps).report(session, input as ExtensionVersionReport))
      },
    ),
  ]
}
