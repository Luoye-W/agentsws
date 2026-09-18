/**
 * WP97：**渲染超时**——五秒之内画不出来就不画了，给"下载查看"。
 *
 * 为什么要这道闸：三种格式的解析全在**主线程**上（壳的 CSP 是
 * `default-src 'self'`，`worker-src` 跟着它回落，连同源 blob 的 Worker 都起不来——
 * 见 `office-preview-panel.tsx` 顶上那张表）。一个两万行的 xlsx 能把主线程按住十几秒，
 * 那期间整个工作台不响应：左栏点不动、⌘K 弹不出来。
 *
 * **这不是真的取消。** JS 没法打断一段正在跑的同步代码——超时之后那段解析仍在跑，
 * 我们只是不再等它、也不再用它的结果。这话要说在明处：写成"取消"会让下一个人
 * 以为超时之后 CPU 就空出来了。真正的解法是把解析挪进 Worker，而那要先动壳的 CSP
 * （`worker-src 'self' blob:`），那是一条要 Luoye 定的线。
 */

/** 五秒（派工书定的数）。 */
export const RENDER_DEADLINE_MS = 5_000

export class RenderTimeoutError extends Error {
  constructor() {
    super('render timeout')
    this.name = 'RenderTimeoutError'
  }
}

export function isRenderTimeout(e: unknown): boolean {
  return e instanceof RenderTimeoutError
}

/**
 * 等一个 promise，最多等 `ms`。
 *
 * 赢了的那一边把定时器清掉——不清的话 jsdom 里每个用例都会留一个五秒的 handle，
 * vitest 退出时要么等它、要么报一句"有未清理的定时器"。
 */
export function withDeadline<T>(p: Promise<T>, ms: number = RENDER_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RenderTimeoutError())
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}
