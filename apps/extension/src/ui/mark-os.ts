/**
 * WP456-T7（§2.7）：在 `<html>` 上挂 `data-os="windows"`，样式里给 Windows 换细滚动条（Mac 的浮动滚动条照旧）。
 * 与工作台 `main.tsx` 同一个口径：按 userAgent 认。
 */
export function markOs(doc: Document = document, ua: string = navigator.userAgent): void {
  if (/Windows/iu.test(ua)) doc.documentElement.dataset.os = 'windows'
}
