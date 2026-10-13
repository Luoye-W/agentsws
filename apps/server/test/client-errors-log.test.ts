/** WP298：前端报错在服务日志里是一行，带上 kind / 路径 / 层 / 版本 / UA / 栈。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatClientErrorLine, stderrClientErrors } from '../src/client-errors.js'
import { createServer } from '../src/index.js'

describe('前端报错进服务日志', () => {
  it('一行、字段带引号转义（换行写不出第二行）', () => {
    const lines: string[] = []
    stderrClientErrors((l) => lines.push(l)).record({
      kind: 'boundary',
      name: 'TypeError',
      message: 'x is undefined',
      route: '/im-channels',
      scope: 'page',
      app_version: '0.2.0-beta.2',
      user_agent: 'Electron/44',
      stack: 'at a\nat b',
    })
    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ''
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(line).toContain('[client-error] TypeError: x is undefined kind="boundary"')
    expect(line).toContain('route="/im-channels"')
    expect(line).toContain('app="0.2.0-beta.2"')
    expect(formatClientErrorLine({ kind: 'error', name: 'E', message: 'm', route: '/' })).toBe(
      '[client-error] E: m kind="error" route="/"',
    )
  })
})

describe('真服务进程：POST /v1/client-errors', () => {
  it('不带凭据也收，写成一行日志；查询串与邮箱洗掉', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp298-client-errors-'))
    const lines: string[] = []
    const server = await createServer({
      dbDir,
      quiet: true,
      clientErrorLog: (l) => lines.push(l),
      tokenRefreshIntervalMs: 0,
    })
    try {
      const { url } = await server.listen(0)
      const res = await fetch(`${url}/v1/client-errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'boundary',
          name: 'TypeError',
          message: 'boom for a@b.com at http://127.0.0.1:4317/x?token=abc',
          route: '/im-channels?x=1',
          scope: 'page',
        }),
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { data: { logged: boolean } }).data.logged).toBe(true)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('[client-error] TypeError: boom for <email>')
      expect(lines[0]).toContain('route="/im-channels"')
      expect(lines[0]).not.toContain('token=abc')
    } finally {
      await server.close()
      rmSync(dbDir, { recursive: true, force: true })
    }
  }, 60_000)
})
