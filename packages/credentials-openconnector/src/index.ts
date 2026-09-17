/**
 * `@agentsws/credentials-openconnector` —— 官方 `ctx.credentials` 的 provider（55 §4 凭据段）。
 *
 * 为什么是**单独一个包**而不是放进 `@agentsws/connect-adapter`：
 * connect-adapter 是纯 HTTP + 领域逻辑，`apps/server` 依赖它而**不依赖 dsh**。
 * 把 `@deepseek-ai/dsh-credentials` + cordis 塞进去，等于把整棵 dsh 依赖拖进服务进程的
 * 模块图（31 §3.5「执行器不装第三方代码」那条纪律的反面）。这个包只被
 * `dsh-adapter` 那一侧与它自己的用例引用。
 */
export type {
  CompositeCredentialsConfig,
  ConnectionGrantPayload,
} from './provider.js'
export {
  CompositeCredentials,
  CredentialsBoundaryError,
  connectionCredentialKey,
  credentialSegment,
  SUBSCRIPTION_RECORD_SCOPE,
} from './provider.js'
export type {
  CredentialRefSource,
  OpenConnectorGrant,
  OpenConnectorSource,
  OpenConnectorSourceOptions,
  RefHit,
  SubscriptionRecordSource,
} from './source.js'
export { envRefSource, openConnectorSource } from './source.js'
