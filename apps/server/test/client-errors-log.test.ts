/** WP298：前端报错在服务日志里是一行，带上 kind / 路径 / 层 / 版本 / UA / 栈。 */
import { describe, expect, it } from 'vitest'
import { formatClientErrorLine, stderrClientErrors } from '../src/client-errors.js'

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
