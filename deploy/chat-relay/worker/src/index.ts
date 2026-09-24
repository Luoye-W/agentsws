// Agents 工坊 · 聊天转发器（自建 Worker 档）。
// 全部逻辑来自同一份 @agentsws/chat-relay：这里只是把它接上 Workers 运行时。
// 相对路径引用仓库内源码；esbuild 会把 TS 与依赖一起打进 Worker 包。
//
// 两把必填 secret：PAIRING_TOKEN、VISITOR_SECRET（没配整台 503，见 README 路 B）。
// 留言要另配 MESSAGE_KEY（选填；没配就不收留言）。
import {
  createStandaloneWorker,
  type StandaloneEnv,
} from '../../../../packages/chat-relay/src/standalone-worker.js'

const worker = createStandaloneWorker()

export default {
  fetch(request: Request, env: StandaloneEnv) {
    return worker.fetch(request, env)
  },
}
