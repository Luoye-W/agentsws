/**
 * WP475：反馈框里「附上截图」——一键截当前工坊窗口（主窗口的 `webContents.capturePage()`）。
 *
 * 这里只放与 electron 无关的那一半（README：只有 main.ts / preload 碰 electron）：拿到的图太大就缩、
 * 编成 JPEG，超了上限再降质量；还是太大就不给（页面上退回「粘贴 / 拖入图片」）。
 * 截的只是工坊自己的窗口，不截整个屏幕、不截别的应用。
 */

/** 截图最长边（像素）：再大看不出更多东西，只是更大。 */
export const CAPTURE_MAX_EDGE = 1600

/** 编完之后至多多少字节（与契约 `FEEDBACK_SCREENSHOT_MAX_BYTES` 同一个数）。 */
export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024

/** `NativeImage` 里用得到的那一点。 */
export interface CaptureImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: {
    width: number
    height?: number
    quality?: 'good' | 'better' | 'best'
  }): CaptureImage
  toJPEG(quality: number): Uint8Array
}

export interface CaptureResult {
  content_type: 'image/jpeg'
  data_base64: string
}

/** 缩到最长边不超过 {@link CAPTURE_MAX_EDGE} 的宽度（不放大）。 */
export function captureWidth(
  size: { width: number; height: number },
  maxEdge = CAPTURE_MAX_EDGE,
): number {
  const edge = Math.max(size.width, size.height)
  if (edge <= maxEdge || edge === 0) return size.width
  return Math.max(1, Math.round((size.width * maxEdge) / edge))
}

/** 截到的图 → 给页面的那一份；空图 / 怎么压都太大回 `null`。 */
export function encodeCapture(
  image: CaptureImage,
  maxBytes = CAPTURE_MAX_BYTES,
): CaptureResult | null {
  if (image.isEmpty()) return null
  const size = image.getSize()
  const width = captureWidth(size)
  const fitted = width === size.width ? image : image.resize({ width, quality: 'good' })
  for (const quality of [82, 65, 45]) {
    const bytes = fitted.toJPEG(quality)
    if (bytes.byteLength <= maxBytes)
      return { content_type: 'image/jpeg', data_base64: Buffer.from(bytes).toString('base64') }
  }
  return null
}
