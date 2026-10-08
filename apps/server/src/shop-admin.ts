/**
 * WP261（决策 175 第 1 步）：**店铺后台接口的统一口子**（`ShopifyAdmin`）+ 它的第一种实现「Shopify CLI `store execute`」。
 *
 * 运营工具（`shop-ops.ts` / `shop-tools.ts`）与审批卡只认 {@link ShopifyAdmin}：以后决策 146 的自家公开应用（长期令牌）、
 * OpenConnector 版只是另一种实现，工具和卡片不用改。
 *
 * CLI 版怎么跑（读 `@shopify/cli@4.8.5` 发行包核过，见报告 §1）：
 *
 * - `<node> <入口> store execute --json --store <店> --query-file <q> --variable-file <v> --output-file <o> --version <版本>`；
 *   改动另带 `--allow-mutations`（**只有 {@link ShopifyAdmin.mutate} 带，它只给执行器——人批过的卡**）。
 * - 文档与变量写成**文件**再交给 CLI（不走命令行参数）：Windows 上 `"` / `%` 转不准、命令行还有 8191 字的上限。
 *   文件放在本品牌那一份 CLI 会话目录的 `work/` 下，跑完就删（只删我们自己建的那一个子目录）。
 * - 结果从 `--output-file` 读（`data` 那一层，JSON）；不读 stdout，免得混进 CLI 的提示行。
 * - 令牌在 CLI 自己的配置里（`shopify-cli-store`，按品牌分目录）；**我们不读它**，过期 / 被收回 / 缺权限都从 CLI 的报错认。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformStoreAdminSpec } from '@agentsws/contracts'
import { type RunCli, ShopifyThemeError, scrubCliOutput } from './shopify-theme.js'

/** 一条写死的 Admin GraphQL（名字只用来记事件与测试，文档里自己也有操作名）。 */
export interface AdminOperation {
  name: string
  document: string
  variables?: Record<string, unknown>
}

/**
 * 店铺后台接口（与底层无关）。`query` 只认查询文档（文档里是 mutation 直接拒）；`mutate` 只给执行器。
 */
export interface ShopifyAdmin {
  /** 哪一种实现（事件里记；以后还有 `app_token` / `open_connector`）。 */
  /** `cloud_app`（WP265）：云端一键授权的应用，经云代发（店铺令牌不出云）。 */
  readonly via: 'cli_store_execute' | 'stand_in' | 'cloud_app'
  readonly store: string
  query<T = unknown>(op: AdminOperation): Promise<T>
  mutate<T = unknown>(op: AdminOperation): Promise<T>
}

/** AI 那一侧（运营工具）只拿得到这一半。 */
export type ShopifyAdminReader = Pick<ShopifyAdmin, 'via' | 'store' | 'query'>

export type ShopAdminErrorCode =
  /** CLI 里没有这家店的授权（从没授权过 / 换了会话目录）。 */
  | 'not_authorized'
  /** 令牌过期且续不上。 */
  | 'expired'
  /** 授权被收回（店主在后台删了 / 换了账号），CLI 已经把那份删了。 */
  | 'revoked'
  /** 这一项权限没给（`missing` 里是 Shopify 说要的那几项）。 */
  | 'missing_scope'
  /** 店铺冻结 / 停用（HTTP 402）。 */
  | 'store_unavailable'
  | 'network'
  /** Shopify 回了 GraphQL 错误（文档不对 / 参数不对）。 */
  | 'graphql'
  | 'cli_missing'
  /** 想用查询那一半跑改动（我们自己的闸）。 */
  | 'mutation_refused'
  | 'timeout'
  | 'failed'

export class ShopAdminError extends Error {
  constructor(
    readonly code: ShopAdminErrorCode,
    message: string,
    readonly opts: { missing?: string[]; detail?: string } = {},
  ) {
    super(message)
    this.name = 'ShopAdminError'
  }
}

/** 授权有问题的那几类（执行时撞上就把岗位页那一行打回「重新授权」）。 */
export const AUTH_PROBLEM_CODES: ReadonlySet<ShopAdminErrorCode> = new Set([
  'not_authorized',
  'expired',
  'revoked',
  'missing_scope',
])

/** 每一类说的人话（工具回话与岗位页同一套）。 */
export const SHOP_ADMIN_TEXT: Readonly<Record<ShopAdminErrorCode, string>> = {
  not_authorized:
    '还没授权管理商品和页面。请到岗位页点「授权管理商品和页面」，在浏览器里批准后再让我接着做。',
  expired: '店铺授权过期了。请到岗位页点「重新授权」，在浏览器里批准后再让我接着做。',
  revoked: '店铺授权被收回了（可能在后台删了授权或换了账号）。请到岗位页点「重新授权」。',
  missing_scope: '店铺授权里少了这件事要的权限。请到岗位页点「重新授权」补上。',
  store_unavailable: '这家店现在不可用（可能已冻结或停用），去 Shopify 后台看一眼。',
  network: '连不上 Shopify，检查一下网络再试。',
  graphql: 'Shopify 没接受这次请求。',
  cli_missing: '这台电脑还没装 Shopify CLI。请到岗位页点「一键安装」。',
  mutation_refused: '这一步只能查，不能改。',
  timeout: 'Shopify 太久没回话，稍后再试。',
  failed: '这次没跑成，稍后再试。',
}

const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|fetch failed|getaddrinfo|socket hang up|network/i

/** Shopify 报的缺权限：`Required access: \`write_products\` access scope.`（可能一次好几条）。 */
export function requiredScopesOf(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/Required access:?\s*`?([a-z_]+)`?/gi))
    if (m[1] !== undefined) out.add(m[1])
  for (const m of text.matchAll(
    /requires? (?:the )?`?((?:read|write)_[a-z_]+)`? (?:access )?scope/gi,
  ))
    if (m[1] !== undefined) out.add(m[1])
  return [...out].sort()
}

/** `store execute` 退出码非零时，CLI 的话是哪一类（文案照 4.8.5 发行包原文）。 */
export function classifyExecuteFailure(text: string): {
  code: ShopAdminErrorCode
  missing?: string[]
} {
  if (/No stored app authentication found/i.test(text)) return { code: 'not_authorized' }
  if (/no longer valid|has likely been claimed/i.test(text)) return { code: 'revoked' }
  if (/No refresh token stored|Token refresh failed|invalid refresh response/i.test(text))
    return { code: 'expired' }
  const missing = requiredScopesOf(text)
  if (missing.length > 0 || /ACCESS_DENIED|Access denied for/i.test(text))
    return { code: 'missing_scope', missing }
  if (/currently unavailable/i.test(text)) return { code: 'store_unavailable' }
  if (/GraphQL operation failed|Invalid GraphQL syntax/i.test(text)) return { code: 'graphql' }
  if (NETWORK.test(text)) return { code: 'network' }
  return { code: 'failed' }
}

/** 文档里唯一那个操作是不是 mutation（去掉 `#` 注释看第一个关键字）。 */
export function isMutationDocument(document: string): boolean {
  const body = document.replace(/#[^\n]*/g, '').trim()
  return /^mutation\b/.test(body)
}

export interface CliShopifyAdminOptions {
  store: string
  spec: PlatformStoreAdminSpec
  run: RunCli
  /** 子进程环境（白名单 + 本品牌那一份会话目录，见 `shop-auth.ts` 的 `storeEnv`）。 */
  env(): Record<string, string>
  /** 放临时文件的目录（本品牌会话目录下的 `work/`）；不给 = 系统临时目录。 */
  workDir?: string
  timeoutMs?: number
  /** 撞上授权问题时告诉上层（岗位页那一行打回「重新授权」）。 */
  onAuthProblem?(err: ShopAdminError): void
}

/** CLI 说钉的版本不认了 → 这一进程以后都不带 `--version`（用 CLI 默认的最新稳定版）。 */
const INVALID_VERSION = /Invalid API version/i

export function createCliShopifyAdmin(options: CliShopifyAdminOptions): ShopifyAdmin {
  const { spec, store } = options
  let pinVersion = true
  const exec = async <T>(op: AdminOperation, mutation: boolean): Promise<T> => {
    const isMutation = isMutationDocument(op.document)
    if (isMutation && !mutation)
      throw new ShopAdminError('mutation_refused', SHOP_ADMIN_TEXT.mutation_refused)
    const base = options.workDir
    if (base !== undefined) mkdirSync(base, { recursive: true })
    const dir =
      base === undefined
        ? mkdtempSync(join(tmpdir(), 'agentsws-shop-'))
        : join(base, `op-${randomBytes(6).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    const queryFile = join(dir, 'query.graphql')
    const varsFile = join(dir, 'variables.json')
    const outFile = join(dir, 'out.json')
    try {
      writeFileSync(queryFile, op.document)
      writeFileSync(varsFile, JSON.stringify(op.variables ?? {}))
      const args = (withVersion: boolean): string[] => [
        ...spec.execute_args,
        spec.store_flag,
        store,
        spec.query_file_flag,
        queryFile,
        spec.variable_file_flag,
        varsFile,
        spec.output_file_flag,
        outFile,
        ...(withVersion ? [spec.version_flag, spec.api_version] : []),
        ...(isMutation ? [spec.allow_mutations_flag] : []),
      ]
      const once = async (withVersion: boolean) => {
        try {
          return await options.run(args(withVersion), {
            cwd: dir,
            env: options.env(),
            timeoutMs: options.timeoutMs ?? 120_000,
          })
        } catch (e) {
          if (e instanceof ShopifyThemeError && e.code === 'cli_missing')
            throw new ShopAdminError('cli_missing', SHOP_ADMIN_TEXT.cli_missing)
          if (e instanceof ShopifyThemeError && e.code === 'timeout')
            throw new ShopAdminError('timeout', SHOP_ADMIN_TEXT.timeout)
          throw e
        }
      }
      let res = await once(pinVersion)
      if (res.code !== 0 && pinVersion && INVALID_VERSION.test(`${res.stderr}\n${res.stdout}`)) {
        pinVersion = false
        res = await once(false)
      }
      if (res.code !== 0) {
        const text = scrubCliOutput(`${res.stderr}\n${res.stdout}`)
        const hit = classifyExecuteFailure(text)
        const err = new ShopAdminError(
          hit.code,
          hit.code === 'missing_scope' && (hit.missing?.length ?? 0) > 0
            ? `${SHOP_ADMIN_TEXT.missing_scope}（缺：${(hit.missing ?? []).join('、')}）`
            : hit.code === 'graphql'
              ? `${SHOP_ADMIN_TEXT.graphql}${graphqlMessage(text)}`
              : SHOP_ADMIN_TEXT[hit.code],
          { ...(hit.missing === undefined ? {} : { missing: hit.missing }), detail: tail(text) },
        )
        if (AUTH_PROBLEM_CODES.has(err.code)) options.onAuthProblem?.(err)
        throw err
      }
      if (!existsSync(outFile))
        throw new ShopAdminError('failed', 'Shopify CLI 没写出结果', { detail: tail(res.stderr) })
      try {
        return JSON.parse(readFileSync(outFile, 'utf8')) as T
      } catch {
        throw new ShopAdminError('failed', 'Shopify CLI 写出的结果读不懂')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return {
    via: 'cli_store_execute',
    store,
    query: (op) => exec(op, false),
    mutate: (op) => exec(op, true),
  }
}

/** 输出尾巴（只进事件详情；已抹过令牌）。 */
function tail(text: string): string {
  return text.trim().split('\n').slice(-8).join('\n').slice(-800)
}

/** CLI 把 GraphQL 错误整段 JSON 打出来：挑第一条 message 给人看。 */
function graphqlMessage(text: string): string {
  const m = /"message"\s*:\s*"([^"]{1,300})"/.exec(text)
  return m?.[1] === undefined ? '' : `（${m[1]}）`
}
