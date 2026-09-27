import { describe, expect, it } from 'vitest'
import { isWorkspaceBearer } from '../src/worker.js'

describe('公共红人库入口：什么算工作区令牌', () => {
  it('以 Bearer wst_ 开头才算', () => {
    expect(isWorkspaceBearer('Bearer wst_abc123')).toBe(true)
    expect(isWorkspaceBearer('bearer  wst_abc123')).toBe(true)
  })
  it('插件令牌里恰好含 wst_ 不算（原先按「包含」判，会回 401）', () => {
    expect(isWorkspaceBearer('Bearer plg_x9wst_k2')).toBe(false)
    expect(isWorkspaceBearer('Bearer plg_abc')).toBe(false)
    expect(isWorkspaceBearer(undefined)).toBe(false)
    expect(isWorkspaceBearer('wst_abc')).toBe(false)
  })
})
