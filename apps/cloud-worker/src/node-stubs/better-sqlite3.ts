/**
 * `better-sqlite3` 在 Cloudflare Workers 上的**替身**（WP114）。
 *
 * 为什么需要它：云侧几个包的主入口里有 better-sqlite3 那一档存储
 * （`SqliteIdempotencyStore`、`createSqliteWalletStore`…）。Workers 形态一条都
 * 用不上——库是 Durable Object 自己的 SQLite——但打包器顺着 import 还是会找到
 * 那个**原生模块**，而原生模块在 Workers 上根本装不进去。
 *
 * 所以 `wrangler.toml` 的 `[alias]` 把它换成这个文件。它**只在真被 new 出来时抛**：
 * 一句人话，说清楚这是走错了路，而不是在部署当天给一段看不懂的打包错误。
 *
 * 这不是"偷偷绕过去"：Workers 形态里没有任何一条代码路径会走到这里，
 * 走到了就是装配错了，当场炸掉正是想要的行为。
 */

const MESSAGE =
  'Workers 形态里没有 better-sqlite3（原生模块装不进去）。' +
  '云上的库是 Durable Object 自己的 SQLite，走 `doSyncDb(ctx.storage)`。' +
  '会走到这一行，说明装配时拿错了那一档存储。'

class NotAvailable {
  constructor() {
    throw new Error(MESSAGE)
  }
}

export default NotAvailable
