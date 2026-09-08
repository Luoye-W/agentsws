import { runConnectConformance } from './connect-conformance.js'
import { eventsOf, makeReplayAdapter, meta, replayCtx } from './replay-harness.js'

/**
 * 一致性套件第二遍：真 connect-adapter，HTTP 全部由录制磁带回放。
 * 和 `conformance-mock.test.ts` 是同一份用例——两边行为必须一致。
 */
runConnectConformance({
  name: '真 connect-adapter（OpenConnector fixture 回放）',
  ctx: replayCtx,
  make: () => makeReplayAdapter(),
  secrets: () => [meta.admin_token_placeholder],
  emitted: (connect) => eventsOf(connect).events,
})
