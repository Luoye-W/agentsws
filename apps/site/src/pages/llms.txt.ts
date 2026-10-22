import { siteCatalog } from '../lib/catalog.js'
import { llmsTxt } from '../lib/machine.js'

/** `/llms.txt`：一页纸说工坊是什么，再列全部教程与笔记。 */
export function GET(): Response {
  return new Response(llmsTxt(siteCatalog().index), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
