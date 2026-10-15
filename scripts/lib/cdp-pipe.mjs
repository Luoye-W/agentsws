/**
 * WP345：最小的「经管道连 Chrome 调试协议」客户端（`--remote-debugging-pipe`）。
 *
 * 为什么不用 Playwright：品牌版 Chrome 137 起不认 `--load-extension`，装「已解压的扩展」只剩
 * 调试协议的 `Extensions.loadUnpacked`，而它**只在管道连接 + `--enable-unsafe-extension-debugging`**
 * 时可用；Playwright 连品牌 Chrome 会带 `--enable-automation` 等一串开关，正好会压掉我们要看的提示。
 * 这里自己起进程：只带我们写明的开关，用一个临时用户目录（不碰用户自己的 Chrome 配置）。
 *
 * 用法：`const c = await launchChrome({ executable, userDataDir, args })` → `c.send(method, params, sessionId)`。
 * 关：`c.close()`（先 Browser.close，等进程退；超时才按 PID 结束它自己）。
 */
import { spawn } from 'node:child_process'

export async function launchChrome({ executable, userDataDir, args = [], pipe = true }) {
  const base = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
  ]
  const child = spawn(
    executable,
    [...base, ...(pipe ? ['--remote-debugging-pipe'] : []), ...args, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', ...(pipe ? ['pipe', 'pipe'] : [])] },
  )
  const stderr = []
  child.stderr.on('data', (d) => {
    stderr.push(String(d))
    if (stderr.length > 200) stderr.shift()
  })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  if (!pipe)
    return {
      child,
      pid: child.pid,
      stderr,
      exited,
      async close(ms = 10_000) {
        child.kill('SIGTERM')
        const t = setTimeout(() => child.kill('SIGKILL'), ms)
        await exited
        clearTimeout(t)
      },
    }

  const writer = child.stdio[3]
  const reader = child.stdio[4]
  let nextId = 1
  const waiting = new Map()
  const listeners = new Set()
  let buf = ''
  reader.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    for (;;) {
      const i = buf.indexOf('\0')
      if (i < 0) break
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (msg.id !== undefined && waiting.has(msg.id)) {
        const w = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.error !== undefined) w.reject(new Error(`${w.method}: ${msg.error.message}`))
        else w.resolve(msg.result)
      } else for (const l of listeners) l(msg)
    }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject, method })
      writer.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      )
    })
  const client = {
    child,
    pid: child.pid,
    stderr,
    exited,
    send,
    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** 在某个页面 / worker 目标里求值（自动 attach，flatten 会话）。 */
    async evaluate(targetId, expression) {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      try {
        const out = await send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        )
        if (out.exceptionDetails !== undefined)
          throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text)
        return out.result.value
      } finally {
        await send('Target.detachFromTarget', { sessionId }).catch(() => {})
      }
    },
    async targets() {
      return (await send('Target.getTargets')).targetInfos
    },
    async close(ms = 10_000) {
      await send('Browser.close').catch(() => {})
      const t = setTimeout(() => child.kill('SIGKILL'), ms)
      await exited
      clearTimeout(t)
    },
  }
  // 第一句：确认管道通了
  await send('Browser.getVersion')
  return client
}
