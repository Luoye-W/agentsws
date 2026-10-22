/**
 * WP461（WP456 §2.7）：把操作系统挂到 `<html data-os>` 上，CSS 才能只在 Windows 上换细滚动条
 * （Mac 的浮动滚动条照旧）。只看 userAgent，不问外壳——浏览器里打开工作台也一样生效。
 */
export type OsName = 'windows' | 'mac' | 'other'

export function osOf(userAgent: string): OsName {
  if (/Windows/iu.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/iu.test(userAgent)) return 'mac'
  return 'other'
}

export function applyOsAttr(doc: Document = document): void {
  doc.documentElement.dataset.os = osOf(globalThis.navigator?.userAgent ?? '')
}
