#!/usr/bin/env node
/**
 * 假的 stdio MCP 服务器（WP83 探测用例的对手方）。
 *
 * 只做一件事：起来、报一个工具、等着被列一次。**不联网、不读文件、不看环境变量**——
 * 探测这条路要证明的是"我们连得上、列得出来"，不是这台服务器能干什么。
 *
 * 用法：`node fake-mcp-server.mjs`（探测时由 `StdioClientTransport` 起）。
 * 传 `--silent` 就什么也不注册（用来断言"连上了但一个工具都没有"也算成功）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const silent = process.argv.includes('--silent')

const server = new Server(
  { name: 'fake-mcp-server', version: '0.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: silent
    ? []
    : [
        {
          name: 'echo',
          description: '把你说的话原样说回来',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
        {
          name: 'add',
          inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
        },
      ],
}))

await server.connect(new StdioServerTransport())
