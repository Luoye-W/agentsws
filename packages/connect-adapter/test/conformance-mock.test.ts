import type { Connect } from '@agentsws/contracts'
import { createStandIns, SyntheticClock } from '@agentsws/stand-ins'
import { runConnectConformance } from './connect-conformance.js'
import type { ScenarioCtx } from './scenarios.js'

/**
 * 一致性套件第一遍：跑在 stand-ins 的 mock OpenConnector 上。
 * 第二遍在 `conformance-adapter.test.ts` 里跑真适配器（fixture 回放）。
 */
const ctx: ScenarioCtx = {
  workspace_id: 'ws_stand_in',
  assignment_id: 'asg_conformance',
  service: 'shopify_admin',
  read_action: 'shopify_admin.get_order',
  read_input: { order_id: 'ord_1001' },
  write_action: 'shopify_admin.create_refund',
  write_input: { order_id: 'ord_1001', amount: 5, reason: 'conformance' },
  unknown_action: 'shopify_admin.__no_such_action__',
  connection_id: 'conn_shopify_admin',
  other_connection_id: 'conn_shopify_admin_second',
  other_service_connection_id: 'conn_gmail',
  api_key_service: 'klaviyo',
}

runConnectConformance({
  name: 'stand-ins mock OpenConnector',
  ctx,
  make(): Connect {
    const { connect } = createStandIns({
      seed: 12,
      clock: new SyntheticClock('2026-09-09T09:00:00.000Z'),
    })
    // 同一个 service 的第二条连接：验证"未授权的连接"与"跨 service 的连接"是两回事
    connect.putConnection({
      id: ctx.other_connection_id,
      service: 'shopify_admin',
      alias: 'second store',
      ownership: 'workspace',
      workspace_id: ctx.workspace_id,
      status: 'active',
    })
    return connect
  },
  secrets: () => [],
})
