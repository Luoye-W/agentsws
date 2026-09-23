/**
 * 容器环境变量的契约（`HostedInstanceDO` 写、容器里的 `apps/server` 读）。
 *
 * 两头用同一份名字表与同一对 build / parse：改名只改这里，测试钉住「写出去的
 * 读得回来」。值只经环境变量传一次，**不落 DO 的日志、不进任何响应体**。
 *
 * 与 `packages/standby` 拉子进程时给的那一份刻意同名（`AGENTSWS_DATA_DIR` /
 * `AGENTSWS_CLOUD_WORKSPACE_TOKEN` / …）：同一份 `apps/server`，两种托管方式
 * 不该要两套开关。
 */
import { createHmac } from 'node:crypto'
import { HOSTED_PORT } from './lifecycle.js'

export const HOSTED_ENV = {
  /** `1` = 这个进程是托管实例（换对端为 `hosted`、种令牌、推快照）。 */
  flag: 'AGENTSWS_HOSTED',
  workspace: 'AGENTSWS_WORKSPACE_ID',
  cloudBase: 'AGENTSWS_CLOUD_BASE_URL',
  cloudToken: 'AGENTSWS_CLOUD_WORKSPACE_TOKEN',
  relayEndpoint: 'AGENTSWS_HOSTED_RELAY_ENDPOINT',
  relayPairing: 'AGENTSWS_HOSTED_RELAY_PAIRING',
  dataDir: 'AGENTSWS_DATA_DIR',
  port: 'AGENTSWS_PORT',
  bindHost: 'AGENTSWS_BIND_HOST',
  dataKey: 'AGENTSWS_DATA_KEY',
  secretsKey: 'AGENTSWS_SECRETS_KEY',
} as const

/** 容器里的数据目录（盘是临时的：睡着 / 重起就是一张新盘，所以才要快照）。 */
export const HOSTED_DATA_DIR = '/data'

export interface HostedBootConfig {
  workspace_id: string
  cloud_base_url: string
  cloud_token: string
  relay_endpoint: string
  relay_pairing: string
}

/**
 * 每个工作区一把库密钥：`HMAC-SHA256(种子, 工作区号)` 的 hex（64 位，
 * `parseSecretsKey` 认的形状）。
 *
 * 种子是 Worker 的 secret（`AGENTSWS_HOSTED_KEY_SEED`），**不进仓库、不进 DO 存储**；
 * 同一个工作区每次都派生出同一把，所以容器重起之后读得回自己推上去的快照。
 */
export function deriveHostedKey(seed: string, workspace_id: string): string {
  return createHmac('sha256', seed).update(`agentsws-hosted:${workspace_id}`).digest('hex')
}

/** DO 那一侧：拼出要交给 `ctx.container.start({ env })` 的那张表。 */
export function buildHostedEnv(config: HostedBootConfig & { key: string }): Record<string, string> {
  return {
    [HOSTED_ENV.flag]: '1',
    [HOSTED_ENV.workspace]: config.workspace_id,
    [HOSTED_ENV.cloudBase]: config.cloud_base_url,
    [HOSTED_ENV.cloudToken]: config.cloud_token,
    [HOSTED_ENV.relayEndpoint]: config.relay_endpoint,
    [HOSTED_ENV.relayPairing]: config.relay_pairing,
    [HOSTED_ENV.dataDir]: HOSTED_DATA_DIR,
    [HOSTED_ENV.port]: String(HOSTED_PORT),
    // 容器里必须绑 0.0.0.0：DO 经 getTcpPort 打进来，绑回环就是空的。
    // 公网上没有任何路径能直达这个端口——只有它自己的 DO 打得到
    [HOSTED_ENV.bindHost]: '0.0.0.0',
    [HOSTED_ENV.dataKey]: config.key,
    [HOSTED_ENV.secretsKey]: config.key,
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
    relay_endpoint: read(HOSTED_ENV.relayEndpoint),
    relay_pairing: read(HOSTED_ENV.relayPairing),
  }
  const missing = Object.entries(fields)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k)
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    config: {
      workspace_id: fields.workspace_id as string,
      cloud_base_url: (fields.cloud_base_url as string).replace(/\/+$/, ''),
      cloud_token: fields.cloud_token as string,
      relay_endpoint: fields.relay_endpoint as string,
      relay_pairing: fields.relay_pairing as string,
    },
  }
}

/** 托管实例推 / 拉快照的地址（令牌是 `hct_` 那一把）。 */
export function hostedSnapshotUrl(cloud_base_url: string): string {
  return `${cloud_base_url.replace(/\/+$/, '')}/v1/hosted/snapshot`
}
