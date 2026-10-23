/**
 * WP477（Luoye 10-23：按岗位 / 职责看体验）：页面拿到数据后报上「这一页是哪个内置岗位模板、哪条内置职责」。
 *
 * 岗位页报岗位 id（内置岗位的 id 就是模板 id，用户改了名 id 不变；自建岗位是 `pos-…`，本机服务记成 `custom`），
 * 职责页再报职责 id，事项页报事项挂的那条职责与岗位，卡片页报卡的职责。**岗位名永远不报。**
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { setTelemetryContext, type TelemetryPageContext } from './client'

export function useTelemetryContext(ctx: TelemetryPageContext | undefined): void {
  const { pathname } = useLocation()
  const position = ctx?.position_template
  const role = ctx?.role_id
  const ready = ctx !== undefined
  useEffect(() => {
    if (!ready) return
    setTelemetryContext(pathname, {
      ...(position === undefined ? {} : { position_template: position }),
      ...(role === undefined ? {} : { role_id: role }),
    })
    return () => {
      setTelemetryContext(pathname, undefined)
    }
  }, [pathname, position, role, ready])
}
