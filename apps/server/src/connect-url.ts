/**
 * OpenConnector 本地 runtime 的地址——**全仓只在这一处定**（08 / 18）。
 *
 * WP12 的适配器只收 `baseUrl` 参数、不读环境变量；WP16 的桌面壳另有一份
 * `DEFAULT_CONNECT_URL` 常量。两处各自写死同一个 `http://127.0.0.1:3000` 就是两个真源，
 * 换端口时必然漏一个。约定收敛成一条：**环境变量 `AGENTSWS_CONNECT_URL`**，
 * 服务进程按这里解析，桌面壳读同名变量（它自己不再决定默认值）。
 */

/** 自托管 runtime 的默认 origin（`open-connector` 的默认端口）。 */
export const DEFAULT_CONNECT_URL = 'http://127.0.0.1:3000'

/** 环境变量名。桌面壳、docker compose、CI 都用这一个名字。 */
export const CONNECT_URL_ENV = 'AGENTSWS_CONNECT_URL'

/**
 * `AGENTSWS_CONNECT_URL` → origin（去掉末尾斜杠，不带 `/v1`）。
 * 不合法的值直接抛：宁可起不来，也不要连到一个谁也不知道是什么的地方。
 */
export function connectBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[CONNECT_URL_ENV]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_CONNECT_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${CONNECT_URL_ENV} 不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`${CONNECT_URL_ENV} 只能是 http / https：${raw}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
