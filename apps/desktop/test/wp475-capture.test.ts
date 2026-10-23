/** WP475：反馈框「附上截图」——截工坊窗口、缩到最长边 1600、编 JPEG、太大降质量、还大就不给。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS } from '../src/bridge-types.js'
import { type CaptureImage, captureWidth, encodeCapture } from '../src/capture.js'

function fakeImage(
  width: number,
  height: number,
  bytesAt: (q: number) => number,
  log: string[] = [],
): CaptureImage {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: w }) => {
      log.push(`resize ${w}`)
      return fakeImage(w, Math.round((height * w) / width), bytesAt, log)
    },
    toJPEG: (q) => {
      log.push(`jpeg ${q}`)
      return new Uint8Array(bytesAt(q))
    },
  }
}

describe('截图', () => {
  it('最长边超过 1600 才缩，不放大', () => {
    expect(captureWidth({ width: 1200, height: 800 })).toBe(1200)
    expect(captureWidth({ width: 3200, height: 2000 })).toBe(1600)
    expect(captureWidth({ width: 1000, height: 3200 })).toBe(500)
  })

  it('编成 JPEG；太大先降质量，还大就不给；空图不给', () => {
    const log: string[] = []
    const out = encodeCapture(fakeImage(2880, 1800, () => 1000, log))
    expect(out?.content_type).toBe('image/jpeg')
    expect(out?.data_base64).toBe(Buffer.from(new Uint8Array(1000)).toString('base64'))
    expect(log).toEqual(['resize 1600', 'jpeg 82'])
    const shrink = encodeCapture(
      fakeImage(800, 600, (q) => (q > 50 ? 500 : 100)),
      200,
    )
    expect(shrink).not.toBeNull()
    expect(
      encodeCapture(
        fakeImage(800, 600, () => 500),
        200,
      ),
    ).toBeNull()
    expect(encodeCapture(fakeImage(0, 0, () => 1))).toBeNull()
  })

  it('主进程只截发起调用的那个本地窗口；preload 抄了通道名', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const block = main.slice(main.indexOf('BRIDGE_CHANNELS.captureWindow'))
    expect(block.slice(0, 400)).toContain('fromLocalWindow(event)')
    expect(block.slice(0, 600)).toContain('BrowserWindow.fromWebContents(event.sender)')
    const preload = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8')
    expect(preload).toContain(`'${BRIDGE_CHANNELS.captureWindow}'`)
  })
})
