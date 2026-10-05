/**
 * WP218：Windows 托盘图标上色。
 *
 * 托盘图标是 macOS 的 template 图（黑色 + 透明），mac 会按菜单栏明暗自动反色；Windows 不认
 * template，黑色图标落在默认的深色任务栏上几乎看不见。所以 Windows 上把不透明的像素染成
 * 品牌标记的青绿（深浅任务栏上都看得清），透明度原样保留。
 *
 * 输入输出都是 Electron `NativeImage.toBitmap()` 的原始 BGRA 字节。
 */

/** `--ws-brand-mark-1`（品牌标记里的青绿）。 */
export const WINDOWS_TRAY_TINT = { r: 0x1f, g: 0xb8, b: 0xa4 } as const

export function tintBitmap(
  bgra: Uint8Array,
  color: { r: number; g: number; b: number } = WINDOWS_TRAY_TINT,
): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    out[i] = color.b
    out[i + 1] = color.g
    out[i + 2] = color.r
    out[i + 3] = bgra[i + 3] ?? 0
  }
  return out
}
