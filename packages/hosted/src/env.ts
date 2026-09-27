/**
 * 容器环境变量的契约（`HostedInstanceDO` 写、容器里的 `apps/server` 读）。
 *
 * WP165（docs/83 §2）：名字表、build / parse、租户形状**搬进了契约包**
 * （`@agentsws/contracts` 的 `hosted-env.ts`）——云端要搬去私有仓，开源的 `apps/server`
 * 只该依赖契约。这里原样转出，老的导入一行不用改；只有派生库密钥（要 `node:crypto`）
 * 留在这个包里。
 */
import { createHmac } from 'node:crypto'

export {
  buildHostedEnv,
  HOSTED_DATA_DIR,
  HOSTED_ENV,
  HOSTED_MAX_TENANTS_PER_CONTAINER,
  type HostedBootConfig,
  type HostedContainerSpec,
  type HostedTenant,
  hostedRelayEndpoint,
  hostedSnapshotUrl,
  parseHostedEnv,
} from '@agentsws/contracts'

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
