/**
 * 决策 945：服务开给局域网时怎么进门。
 *
 * 本机档（桌面版，只听 127.0.0.1）登录页一按就把一次性 token 交给页面——那台电脑上
 * 能打开这一页的只有主人自己，所以没问题。NAS 版按说明书开给同事以后，同一个开关等于
 * 局域网里谁都能填主人邮箱以主人身份进去。所以分两档：
 *
 * - **local**：服务只听回环口（`AGENTSWS_BIND_HOST` 不设 / 127.0.0.1 / ::1）。行为一点不变。
 * - **shared**：服务听 0.0.0.0 / ::（Docker 镜像默认就是这样），或显式 `AGENTSWS_LOGIN_MODE=shared`。
 *   一次性 token 不进页面、bootstrap 不给主人邮箱；主人用**印在服务日志里的一次性设置码**进门，
 *   同事只能走邀请链接。
 *
 * 为什么 Docker 默认（容器里听 0.0.0.0、宿主只把端口映射到 127.0.0.1）也算 shared：
 * 容器里看不出宿主怎么映射的——请求来源永远是 Docker 网关的地址，不是回环；而说明书还推荐
 * 「NAS 反向代理 → localhost:4317」开给外面，那时宿主映射的确只有 127.0.0.1，可访问的人
 * 却是整个局域网甚至公网。看不清就按「开给别人了」处理。没有往宽里放的开关（不提供
 * `AGENTSWS_LOGIN_MODE=local`），免得有人照着网上的帖子把门又打开。
 */
import { randomInt } from 'node:crypto'
import type { OwnerSetupCodePort } from '@agentsws/api'

export type LoginMode = 'local' | 'shared'
export const LOGIN_MODE_ENV = 'AGENTSWS_LOGIN_MODE'

const LOOPBACK = new Set(['127.0.0.1', '::1'])

/**
 * 这个服务进程用哪一档登录。`host` 是 `bindHost(env)` 的结果（已校验过）。
 * `AGENTSWS_LOGIN_MODE` 只认 `shared`（或空 / `auto`）：只能收紧，不能放宽。
 */
export function loginModeOf(env: Record<string, string | undefined>, host: string): LoginMode {
  const raw = env[LOGIN_MODE_ENV]?.trim().toLowerCase()
  if (raw !== undefined && raw !== '' && raw !== 'auto' && raw !== 'shared')
    throw new Error(
      `${LOGIN_MODE_ENV} 只接受 shared 或 auto（拿到的是 ${raw}）。` +
        '服务只听本机时自动是本机档；没有把局域网档放宽回本机档的开关。',
    )
  if (raw === 'shared') return 'shared'
  return LOOPBACK.has(host) ? 'local' : 'shared'
}

/** 去掉 0/O、1/I/L、U 这些形近字（与邀请码同一张字母表的思路：多半是抄过去的）。 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const CODE_LENGTH = 8
/** 连错几次就换一个新码（旧码作废）：8 位 × 30 个字符 ≈ 39 bit，每个码只给 5 次猜的机会。 */
export const SETUP_CODE_MAX_FAILURES = 5

export interface OwnerSetupCodeOptions {
  /** 主人此刻的邮箱（关联工坊账号后会从占位邮箱换成账号邮箱，所以现取）。 */
  ownerEmail: () => Promise<string>
  /** 印码的地方；默认写 stderr（`docker compose logs server` 看得到）。 */
  log?: (line: string) => void
  /** 测试注入；默认 `crypto.randomInt`。 */
  randomIndex?: (max: number) => number
}

export interface OwnerSetupCode extends OwnerSetupCodePort {
  /** 生成第一个码并印出来（`listen()` 时调；重复调不换码）。 */
  announce(): void
}

/** 用户抄码时可能带空格、横杠、小写——都认。 */
function normalize(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

function pretty(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function createOwnerSetupCode(options: OwnerSetupCodeOptions): OwnerSetupCode {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const pick = options.randomIndex ?? ((max: number) => randomInt(max))
  let current: string | undefined
  let failures = 0

  const rotate = (why: string): void => {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[pick(ALPHABET.length)]
    current = code
    failures = 0
    log(
      `[agentsws] ${why}主人设置码：${pretty(code)}` +
        '（打开工作台登录页，点「我是这台服务器的主人」输入它；用一次就作废，下一个会印在这里）',
    )
  }

  return {
    announce() {
      if (current === undefined) rotate('')
    },
    async redeem(code) {
      if (current === undefined) return undefined
      if (normalize(code) !== current) {
        failures += 1
        if (failures >= SETUP_CODE_MAX_FAILURES) rotate(`连错 ${failures} 次，旧码已作废。新的`)
        return undefined
      }
      rotate('上一个设置码已用掉。下次进门用新的')
      return options.ownerEmail()
    },
  }
}
