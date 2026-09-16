#!/usr/bin/env node
/**
 * 假的 stdio MCP 服务器（WP86 preset 用例的对手方）。
 *
 * 与 `apps/server/test/fixtures/fake-mcp-server.mjs` 同一个角色，但**一个依赖都不用**：
 * MCP 的 stdio 传输就是"一行一个 JSON-RPC 报文"，这里手写三个方法就够
 * （`initialize` / `tools/list` / `tools/call`）。这个包不依赖
 * `@modelcontextprotocol/sdk`——为了一个测试替身把它拖进来不值当。
 *
 * 它报两个工具：`look`（只读）与 `touch`（会动外面的东西）。用例靠这一读一写
 * 钉住 `read_tools` 那条判定。
 *
 * `--name <x>` 改报出来的 serverInfo 名字（不影响工具名：工具名的命名空间由
 * **我们的配置** `serverName` 决定，不是它自报的名字——上游这条纪律用例里也钉着）。
 * 环境变量 `FAKE_MCP_TOKEN` 会原样回显在 `look` 的结果里，用来验证凭据引用真的送到了。
 */
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'look',
    description: '看一眼，什么都不动',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  {
    name: 'touch',
    description: '动一下外面的东西',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
]

const send = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // 通知没有 id，不用回
  if (msg.id === undefined) return
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }
  if (msg.method === 'tools/call') {
    const token = process.env.FAKE_MCP_TOKEN ?? ''
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `${msg.params?.name ?? '?'} ok token=${token}` }],
        isError: false,
      },
    })
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, result: {} })
})
