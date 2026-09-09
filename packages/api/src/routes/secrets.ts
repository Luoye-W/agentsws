/**
 * 本机加密秘密库的**密钥轮换**（13 §4.3；WP20 / WP25 都把「秘密库无密钥轮换」列成遗留）。
 *
 * 为什么需要它：秘密库的密钥是桌面壳首次运行生成、经 safeStorage 存着的一把
 * 32 字节密钥。它泄漏了（日志被贴出去、旧机器没抹干净、协作者拿到过）就得能换，
 * 否则唯一的补救是让用户把所有邮箱凭据重填一遍。
 *
 * 三条纪律：
 * - **密钥不经模型、不经日志、不进响应体**：请求体里带新密钥，响应只回换了几条；
 * - **只有 owner 能换**（策略层写权限；它是整台机器的密钥，不是某个岗位的）；
 * - **整库重加密是一个事务**：中途失败一行都不改，绝不留下一半旧钥一半新钥的库。
 *
 * 调用顺序（桌面壳的「轮换密钥」菜单项就是这么做的）：
 * 生成新密钥 → **先**落 safeStorage → 调这条路由 → 下次起服务进程用新密钥。
 * 顺序反了会得到一个解不开的库。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

/** 32 字节密钥：64 位十六进制，或 base64（与服务进程的 `parseSecretsKey` 同一形状）。 */
const RotateBody = z.object({
  new_key: z.string().min(32).max(200),
})

/** 只有能写工作区策略层的人能换密钥（v1 = owner）。 */
const OWNER = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

export interface SecretsRotationView {
  rotated: number
  at: string
}

/** 网关这一层只转发；库与密钥都在服务进程里。 */
export interface SecretsPort {
  /** 有没有可用的密钥（没有就没什么可轮换的）。 */
  available(): boolean
  /** 换一把密钥，整库重加密。抛错由服务进程给人话。 */
  rotate(new_key: string): SecretsRotationView | Promise<SecretsRotationView>
}

export function secretRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/secrets/rotate',
        operationId: 'rotateSecretsKey',
        summary: '换一把本机秘密库密钥，整库重加密（owner）',
        tag: 'connections',
        auth: 'bearer',
        assignment: true,
        authz: OWNER,
        body: RotateBody,
        returns: '{ rotated, at }（**不回密钥**：它只在请求体里出现一次）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const secrets = deps.secrets
        if (secrets === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配本机秘密库')
        if (!secrets.available())
          throw new ApiError(
            'invalid_input',
            '这台机器没有秘密库密钥（AGENTSWS_SECRETS_KEY 未设置），没有可轮换的东西',
          )
        const input = await body(c, RotateBody)
        const out = await secrets.rotate(input.new_key)
        // 21 §1：谁在什么时候换了密钥必须看得见；**密钥本身一个字节都不进日志**
        deps.eventLog.append?.({
          schema_version: 1,
          workspace_id: p.workspace_id,
          type: 'secrets.key_rotated',
          actor: { kind: 'person', id: p.person_id },
          correlation: { trace_id: c.get('rctx').trace_id },
          payload: { rotated: out.rotated },
        })
        return ok(c, out)
      },
    ),
  ]
}
