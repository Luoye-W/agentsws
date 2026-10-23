import { siteCatalog } from '../../lib/catalog.js'

/** 教程上官网（私有 docs/113 §4.1）：全部教程、笔记、更新日志的目录，软件定时拉、本机缓存。 */
export function GET(): Response {
  return new Response(`${JSON.stringify(siteCatalog().index, null, 1)}\n`, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
