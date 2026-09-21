// Agents 工坊 · 聊天转发器（自建 Worker 档）。
// 全部逻辑来自同一份 @agentsws/chat-relay：这里只是把它接上 Workers 运行时。
// 相对路径引用仓库内源码；esbuild 会把 TS 与依赖一起打进 Worker 包。
import { createStandaloneWorker } from '../../../../packages/chat-relay/src/standalone-worker.js'

const worker = createStandaloneWorker()

export default {
  fetch(request: Request, env: { WORKSPACE?: string; PAIRING_TOKEN?: string; VISITOR_SECRET?: string }) {
    return worker.fetch(request, env)
  },
}
