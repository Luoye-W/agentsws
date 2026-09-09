/**
 * `@agentsws/sdk` —— 第三方前端与 CLI 接 `/v1` 的东西（28 §3）。
 *
 * 两半：
 * - `schema.ts`：**由 OpenAPI 生成**的类型（路径 / 请求体 / 响应体 / 参数）。别手改，
 *   跑 `node scripts/gen-sdk.mjs` 重生成；CI 里生成后 `git diff --exit-code`。
 * - `client.ts`：一个极薄的 fetch 客户端（拼 URL、带三个头、拆信封、抛统一错误）。
 *
 * 事件流（`/v1/ws`）不在这里包一层：它的协议在 `openapi.json` 的 `x-asyncapi` 里写清了，
 * 一个 `new WebSocket(url, ['agentsws.v1', ...])` 就够，包一层反而多一处要同步的东西。
 * 这里只导出那几个字面量与帧的类型，免得调用方自己拼错。
 */
export {
  AgentswsApiError,
  AgentswsClient,
  type ApiErrorBody,
  type ApiPath,
  type CallOptions,
  type ClientOptions,
  createClient,
  type RequestBodyOf,
  type ResponseOf,
} from './client.js'
export type { components, operations, paths } from './schema.js'
export {
  eventStreamUrl,
  subscribe,
  WS_BEARER_PREFIX,
  WS_SUBPROTOCOL,
  type WsClientMessage,
  type WsControlFrame,
  type WsEventFrame,
  type WsFrame,
  type WsFrameType,
} from './ws.js'
