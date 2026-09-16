/**
 * WP86（55 §4 第三层）：**这条职责挂哪几台 MCP 服务器**（`roleConnections`）。
 *
 * 这一份是单元级的：直接装一个 `createConnectionDirectory`，塞一条写了
 * `connectors: [{ kind: 'mcp:my-tools' }]` 的假职责，看它算出来的
 * `RunRequest.connections` 长什么样。端到端那一半在 `connection-directory.test.ts`。
 *
 * 钉三件：
 * 1. 职责模板里没写 `mcp:<名字>` 的一台都不挂（"谁用哪台"由模板说了算，不是谁登记谁生效）；
 * 2. 上一次探测失败的不挂（它报的工具清单不可信）；
 * 3. 凭据只有**引用名**，值一个字节都不在这条 `RunConnection` 里。
 */
import type { McpProbeResult, RunConnection } from '@agentsws/contracts'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import { createConnectionDirectory, mcpHeaderRef } from '../src/connection-directory.js'
import type { SecretStore } from '../src/secret-store.js'

const NOW = '2026-09-16T09:00:00.000Z'

/** 只实现被用到的那几个成员；别的路径这个用例一步都不走。 */
function fakeSecrets(): SecretStore {
  const table = new Map<string, Record<string, string>>()
  return {
    available: true,
    put: (id, fields) => {
      table.set(id, { ...fields })
      return {
        connection_id: id,
        field_names: Object.keys(fields),
        created_at: NOW,
        updated_at: NOW,
      }
    },
    get: (id) => table.get(id),
    list: () => [],
    record: () => undefined,
    remove: (id) => table.delete(id),
    rotate: () => ({ rotated: 0 }),
    close: () => undefined,
  } as unknown as SecretStore
}

function fakeRoles(connectors: { kind: string; required: boolean }[]): RoleStore {
  return {
    roles: new Map([
      [
        'x.role',
        {
          id: 'x.role',
          name: { zh: '测试职责', en: 'Test role' },
          connectors: connectors.map((c) => ({ ...c, grants: [], ownership: 'workspace' })),
        },
      ],
    ]),
  } as unknown as RoleStore
}

function directoryWith(options: {
  connectors: { kind: string; required: boolean }[]
  probe: McpProbeResult
}) {
  return createConnectionDirectory({
    clock: { now: () => NOW },
    workspace_id: 'ws_local' as never,
    secrets: fakeSecrets(),
    roles: fakeRoles(options.connectors),
    positions: () => [],
    connectedKinds: () => [],
    // 探测替身：不真起子进程，直接回一份结果
    probeMcp: async () => ({
      ok: options.probe.ok,
      tools: [...options.probe.tools],
      ...(options.probe.detail === undefined ? {} : { detail: options.probe.detail }),
    }),
  })
}

const PROBE_OK: McpProbeResult = {
  ok: true,
  at: NOW,
  tools: [{ name: 'look' }, { name: 'touch' }],
}

describe('roleConnections：职责模板说了算', () => {
  it('模板写了 mcp:<名字> 的挂上，工具清单与只读清单一起带出去', async () => {
    const dir = directoryWith({
      connectors: [{ kind: 'mcp:my-tools', required: false }],
      probe: PROBE_OK,
    })
    await dir.saveMcp({
      name: 'my-tools',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      read_tools: ['look'],
    })
    const conns: RunConnection[] = dir.roleConnections('x.role')
    expect(conns).toHaveLength(1)
    const [conn] = conns
    expect(conn?.kind).toBe('mcp:my-tools')
    // serverName 带 workspace：一个进程装得下多个品牌，不带就会撞名（52 O1）
    expect(conn?.server_name).toBe('ws_local_my-tools')
    expect(conn?.read_tools).toEqual(['look'])
    expect(conn?.tools).toEqual(['look', 'touch'])
  })

  it('模板没写的一台都不挂（登记过 ≠ 这条职责能用）', async () => {
    const dir = directoryWith({ connectors: [{ kind: 'email', required: true }], probe: PROBE_OK })
    await dir.saveMcp({ name: 'my-tools', transport: 'stdio', command: 'node' })
    expect(dir.roleConnections('x.role')).toEqual([])
  })

  it('上一次探测没连上的不挂（它报的工具清单不可信）', async () => {
    const dir = directoryWith({
      connectors: [{ kind: 'mcp:my-tools', required: false }],
      probe: { ok: false, at: NOW, tools: [], detail: '连不上' },
    })
    await dir.saveMcp({ name: 'my-tools', transport: 'stdio', command: 'node' })
    expect(dir.roleConnections('x.role')).toEqual([])
  })

  it('凭据只有引用名：值一个字节都不在这条 RunConnection 里', async () => {
    const dir = directoryWith({
      connectors: [{ kind: 'mcp:remote', required: false }],
      probe: PROBE_OK,
    })
    await dir.saveMcp({
      name: 'remote',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer super-secret' },
    })
    const [conn] = dir.roleConnections('x.role')
    expect(conn?.header_refs).toEqual({
      Authorization: mcpHeaderRef('remote', 'Authorization'),
    })
    expect(JSON.stringify(conn)).not.toContain('super-secret')
    expect(JSON.stringify(conn)).not.toContain('Bearer')
  })

  it('认不出来的职责回空数组（不编一条出来）', () => {
    const dir = directoryWith({ connectors: [], probe: PROBE_OK })
    expect(dir.roleConnections('nobody.here')).toEqual([])
  })
})
