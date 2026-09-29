/**
 * WP194：这一次打云「算在谁头上」——本机公司成员（`person_id`）+ 岗位。
 *
 * 云上的工作区令牌是工作区级的、分不出人，所以由持令牌的本机服务在请求头里声明
 * （`X-Agentsws-Member` / `X-Agentsws-Position`，云上按人 / 按岗位判每月上限）。
 *
 * 为什么是 `AsyncLocalStorage`：打云的地方散在好几个客户端里（公共红人库、搜索数据、
 * 红人云同步……），一个个把 actor 递下去要改几十个签名；而"这一次是谁"在两个地方就知道了——
 * 一次 HTTP 请求绑定分配的那一刻（`requestScope`），与一次运行开跑的那一刻（`aroundRun`）。
 * 在那两处开一个作用域，底下每个客户端取 {@link currentCloudHeaders} 就行。模块级变量不行：
 * 请求在 await 处交错，可变的"当前是谁"会串号——串号就是把 A 的账记到 B 头上。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Attribution } from '@agentsws/contracts'
import { attributionHeaders } from '@agentsws/contracts'

const SCOPE = new AsyncLocalStorage<Attribution>()

/** 在一个「算在谁头上」的作用域里跑。 */
export function withCloudAttribution<T>(who: Attribution, fn: () => T): T {
  return SCOPE.run(who, fn)
}

/** 当前作用域的归属（没有就是 `undefined` = 不带，云上只按公司余额判）。 */
export function currentCloudAttribution(): Attribution | undefined {
  return SCOPE.getStore()
}

/** 当前作用域 → 请求头（没有 / 不合法的不带）。 */
export function currentCloudHeaders(): Record<string, string> {
  return attributionHeaders(SCOPE.getStore())
}
