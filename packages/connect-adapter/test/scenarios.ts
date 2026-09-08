import type { AssignmentId, Connect, ConnectToken, WorkspaceId } from '@agentsws/contracts'

/**
 * 契约一致性套件与 fixture 录制脚本共用的"场景"定义。
 *
 * 录制侧按 `driveScenarios` 把所有会打网络的调用跑一遍，回放侧（conformance）再断言。
 * token 的签发参数必须两边完全一致——磁带的键里含请求体哈希。
 */
export interface ScenarioCtx {
  workspace_id: WorkspaceId
  assignment_id: AssignmentId
  service: string
  read_action: string
  read_input: unknown
  write_action: string
  write_input: unknown
  /** 目录里不存在的 Action id。 */
  unknown_action: string
  connection_id: string
  /** 同一个 service 的另一条连接（用来验证"未授权的连接"）。 */
  other_connection_id: string
  /** 另一个 service 的连接（用来验证"连接与 Action 不同 service"）。 */
  other_service_connection_id: string
  /** api_key / custom_credential 类 provider，`beginConnect` 走 secure form。 */
  api_key_service: string
  /** oauth2 类 provider；没有就跳过 OAuth 场景。 */
  oauth_service?: string
}

export function readTokenInput(ctx: ScenarioCtx): {
  assignment_id: AssignmentId
  kind: ConnectToken['kind']
  allowed_actions: string[]
  allowed_connections: string[]
} {
  return {
    assignment_id: ctx.assignment_id,
    kind: 'role-read',
    allowed_actions: [ctx.read_action],
    allowed_connections: [ctx.connection_id],
  }
}

export function applyTokenInput(ctx: ScenarioCtx): {
  assignment_id: AssignmentId
  kind: ConnectToken['kind']
  allowed_actions: string[]
  allowed_connections: string[]
} {
  return {
    assignment_id: ctx.assignment_id,
    kind: 'role-apply',
    allowed_actions: [ctx.write_action, ctx.read_action, ctx.unknown_action],
    allowed_connections: [ctx.connection_id],
  }
}

/** 幂等场景专用的第二把 apply token（与上面那把参数不同，磁带键才分得开）。 */
export function idempotencyTokenInput(ctx: ScenarioCtx): {
  assignment_id: AssignmentId
  kind: ConnectToken['kind']
  allowed_actions: string[]
  allowed_connections: string[]
} {
  return {
    assignment_id: `${ctx.assignment_id}_idem`,
    kind: 'role-apply',
    allowed_actions: [ctx.write_action, ctx.read_action],
    allowed_connections: [ctx.connection_id],
  }
}

export const IDEMPOTENCY_KEY = 'chg_conformance_0001'

async function swallow(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // 录制期只关心"这条请求打出去过"，断言留给 conformance
  }
}

/**
 * 把 conformance 会触发的每一条 HTTP 交互都走一遍。回放靠请求内容寻址，所以顺序不重要，
 * 重要的是"每个键至少被录到一次、且需要多次不同响应的键按顺序录够"。
 */
export async function driveScenarios(connect: Connect, ctx: ScenarioCtx): Promise<void> {
  await connect.providers()
  await connect.actions(ctx.service)
  await connect.connections(ctx.workspace_id)

  await swallow(() =>
    connect.beginConnect(ctx.api_key_service, {
      workspace_id: ctx.workspace_id,
      ownership: 'workspace',
      alias: 'conformance_api_key',
      mode: 'own_app',
    }),
  )
  if (ctx.oauth_service !== undefined) {
    await swallow(() =>
      connect.beginConnect(ctx.oauth_service as string, {
        workspace_id: ctx.workspace_id,
        ownership: 'workspace',
        alias: 'conformance_oauth',
        mode: 'own_app',
      }),
    )
  }
  await connect.pollConnect('creq_definitely_unknown')

  // 拒签路径（其中"未知连接"会打 /api/connections）
  await swallow(() => connect.issueToken({ ...readTokenInput(ctx), allowed_connections: [] }))
  await swallow(() => connect.issueToken({ ...readTokenInput(ctx), allowed_actions: [] }))
  await swallow(() =>
    connect.issueToken({ ...readTokenInput(ctx), allowed_connections: ['conn_ghost_0000'] }),
  )
  await swallow(() =>
    connect.issueToken({ ...readTokenInput(ctx), allowed_actions: [ctx.write_action] }),
  )

  const read = await connect.issueToken(readTokenInput(ctx))
  const apply = await connect.issueToken(applyTokenInput(ctx))

  await connect.execute(ctx.read_action, ctx.read_input, { token: read.token })
  await swallow(() => connect.execute(ctx.write_action, ctx.write_input, { token: read.token }))
  await swallow(() => connect.execute(ctx.unknown_action, {}, { token: apply.token }))
  await swallow(() =>
    connect.execute(ctx.read_action, ctx.read_input, {
      token: read.token,
      connection: ctx.other_connection_id,
    }),
  )
  await swallow(() =>
    connect.execute(ctx.read_action, ctx.read_input, {
      token: read.token,
      connection: ctx.other_service_connection_id,
    }),
  )
  await swallow(() =>
    connect.execute(ctx.read_action, ctx.read_input, { token: 'oct_bogus_token' }),
  )

  // 幂等：同键两次（第二次重放）、同键换 Action（冲突）
  const idem = await connect.issueToken(idempotencyTokenInput(ctx))
  await swallow(() =>
    connect.execute(ctx.write_action, ctx.write_input, {
      token: idem.token,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  )
  await swallow(() =>
    connect.execute(ctx.write_action, ctx.write_input, {
      token: idem.token,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  )
  await swallow(() =>
    connect.execute(ctx.read_action, ctx.read_input, {
      token: idem.token,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  )

  await swallow(() => connect.transferConnection(ctx.connection_id, 'ws_transfer_target'))
  await connect.transferConnection(ctx.connection_id, ctx.workspace_id)

  await connect.revokeTokens(ctx.assignment_id)
  await swallow(() => connect.execute(ctx.read_action, ctx.read_input, { token: read.token }))
  await connect.revokeTokens(`${ctx.assignment_id}_idem`)
}
