/**
 * 托管实例的**容器环境变量契约**（WP128 定形；WP165 从 `@agentsws/hosted` 搬进契约包，
 * docs/83 §2）。
 *
 * 两头用同一份名字表与同一对 build / parse：云上的 `HostedInstanceDO` 起容器时写
 * （`buildHostedEnv`），容器里那一份开源的 `apps/server` 起来时读（`parseHostedEnv`）。
 * 搬进契约包是因为云端要搬去私有仓，而 `apps/server` 留在开源仓——两边之间唯一的
 * 约定就该是契约，不是彼此的实现包。改名只改这里，测试钉住「写出去的读得回来」。
 *
 * 值只经环境变量传一次，**不落 DO 的日志、不进任何响应体**。纯逻辑、不碰 node 内置模块
 * （派生库密钥那一步要 `node:crypto`，留在 `@agentsws/hosted`）。
 *
 * 与 `packages/standby` 拉子进程时给的那一份刻意同名（`AGENTSWS_DATA_DIR` /
 * `AGENTSWS_CLOUD_WORKSPACE_TOKEN` / …）：同一份 `apps/server`，两种托管方式
 * 不该要两套开关。
 *
 * **给「共享容器」留的口子**（Luoye 09-23）：
 *
 * - 镜像里**没有**任何工作区号；启动参数里工作区号**只出现在一处**
 *   （`AGENTSWS_WORKSPACE_ID`）——转发器地址是容器里按「云地址 + 工作区号」拼出来的，
 *   不另传一份；
 * - DO → 容器这一跳的形状是 {@link HostedContainerSpec}：一份容器级的配置 +
 *   `tenants[]`（每个工作区一份令牌与配对）。本轮 `tenants.length` 只能是 1
 *   （{@link HOSTED_MAX_TENANTS_PER_CONTAINER}），拍平进环境变量；改共享版时
 *   这张表不变，只把「拍平进环境变量」换成「容器起来后经控制口下发」。
 */

export const HOSTED_ENV = {
  /** `1` = 这个进程是托管实例（换对端为 `hosted`、种令牌、推快照）。 */
  flag: 'AGENTSWS_HOSTED',
  workspace: 'AGENTSWS_WORKSPACE_ID',
  cloudBase: 'AGENTSWS_CLOUD_BASE_URL',
  cloudToken: 'AGENTSWS_CLOUD_WORKSPACE_TOKEN',
  relayPairing: 'AGENTSWS_HOSTED_RELAY_PAIRING',
  dataDir: 'AGENTSWS_DATA_DIR',
  port: 'AGENTSWS_PORT',
  bindHost: 'AGENTSWS_BIND_HOST',
  dataKey: 'AGENTSWS_DATA_KEY',
  secretsKey: 'AGENTSWS_SECRETS_KEY',
} as const

/** 容器里的数据目录（盘是临时的：睡着 / 重起就是一张新盘，所以才要快照）。 */
export const HOSTED_DATA_DIR = '/data'

/** 容器里 `apps/server` 监听的端口（根 Dockerfile 的 `AGENTSWS_PORT`）。 */
export const HOSTED_PORT = 4317

/** 容器里多久推一次快照回来。 */
export const SNAPSHOT_PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 本轮一个容器只托管一个工作区（每个订阅工作区一个容器，隔离最干净）。 */
export const HOSTED_MAX_TENANTS_PER_CONTAINER = 1

/** 容器里的一个工作区（租户）：只有它自己的令牌与配对，没有别的。 */
export interface HostedTenant {
  workspace_id: string
  /** `wst_hosted_…`：只能 `ai` + `wallet:read`。 */
  cloud_token: string
  /** 托管那一头连转发器用的配对密钥（`hrp_…`，与商家本机那把不是同一把）。 */
  relay_pairing: string
}

/** DO → 容器：一份容器级配置 + N 个租户（本轮 N = 1）。 */
export interface HostedContainerSpec {
  cloud_base_url: string
  /** 库密钥（本轮 = 这个唯一租户的派生密钥）。 */
  key: string
  tenants: HostedTenant[]
}

/** 容器里读回来的那一份（一个租户 + 容器级的地址）。 */
export interface HostedBootConfig extends HostedTenant {
  cloud_base_url: string
  /** 由「云地址 + 工作区号」拼出来，不是另传的。 */
  relay_endpoint: string
}

/** 转发器地址：`<云>/relay/<工作区>`（商家本机填的也是这个形状）。 */
export function hostedRelayEndpoint(cloud_base_url: string, workspace_id: string): string {
  return `${cloud_base_url.replace(/\/+$/, '')}/relay/${workspace_id}`
}

/**
 * DO 那一侧：拼出要交给 `ctx.container.start({ env })` 的那张表。
 * 本轮只收一个租户；多于一个直接抛（共享版要换下发方式，不是多塞几个变量）。
 */
export function buildHostedEnv(spec: HostedContainerSpec): Record<string, string> {
  const [tenant] = spec.tenants
  if (tenant === undefined || spec.tenants.length > HOSTED_MAX_TENANTS_PER_CONTAINER)
    throw new Error(
      `本轮一个容器只托管 ${String(HOSTED_MAX_TENANTS_PER_CONTAINER)} 个工作区（收到 ${String(spec.tenants.length)} 个）`,
    )
  return {
    [HOSTED_ENV.flag]: '1',
    [HOSTED_ENV.workspace]: tenant.workspace_id,
    [HOSTED_ENV.cloudBase]: spec.cloud_base_url.replace(/\/+$/, ''),
    [HOSTED_ENV.cloudToken]: tenant.cloud_token,
    [HOSTED_ENV.relayPairing]: tenant.relay_pairing,
    [HOSTED_ENV.dataDir]: HOSTED_DATA_DIR,
    [HOSTED_ENV.port]: String(HOSTED_PORT),
    // 容器里必须绑 0.0.0.0：DO 经 getTcpPort 打进来，绑回环就是空的。
    // 公网上没有任何路径能直达这个端口——只有它自己的 DO 打得到
    [HOSTED_ENV.bindHost]: '0.0.0.0',
    [HOSTED_ENV.dataKey]: spec.key,
    [HOSTED_ENV.secretsKey]: spec.key,
    NODE_ENV: 'production',
  }
}

/** 容器那一侧：是不是托管实例；是就把配置读全，缺一样就当不是（并说缺哪样）。 */
export function parseHostedEnv(
  env: Record<string, string | undefined>,
): { ok: true; config: HostedBootConfig } | { ok: false; missing: string[] } | undefined {
  if (env[HOSTED_ENV.flag] !== '1') return undefined
  const read = (name: string): string | undefined => {
    const raw = env[name]?.trim()
    return raw === undefined || raw === '' ? undefined : raw
  }
  const fields = {
    workspace_id: read(HOSTED_ENV.workspace),
    cloud_base_url: read(HOSTED_ENV.cloudBase),
    cloud_token: read(HOSTED_ENV.cloudToken),
    relay_pairing: read(HOSTED_ENV.relayPairing),
  }
  const missing = Object.entries(fields)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k)
  if (missing.length > 0) return { ok: false, missing }
  const base = (fields.cloud_base_url as string).replace(/\/+$/, '')
  const workspace_id = fields.workspace_id as string
  return {
    ok: true,
    config: {
      workspace_id,
      cloud_base_url: base,
      cloud_token: fields.cloud_token as string,
      relay_pairing: fields.relay_pairing as string,
      relay_endpoint: hostedRelayEndpoint(base, workspace_id),
    },
  }
}

/** 托管实例推 / 拉快照的地址（令牌是 `wst_hosted_` 那一把）。 */
export function hostedSnapshotUrl(cloud_base_url: string): string {
  return `${cloud_base_url.replace(/\/+$/, '')}/v1/hosted/snapshot`
}
