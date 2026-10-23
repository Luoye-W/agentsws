/** 移植自 agentsws-extension `test/helpers/dom.ts` @ 57fca9c。 */
/**
 * 测试用的 HTML → Document 帮手。
 *
 * 旧插件的测试用 linkedom（那个仓的 devDependency），它的 `parseHTML`
 * 回一个 `{ document }` 形状的包——三个测试文件都按 `.document` 取。
 * 本仓**零新增依赖**，jsdom 已在 devDependencies 里，这里提供同一个形状。
 */
import { JSDOM } from "jsdom"

export function parseHTML(html: string): { document: Document } {
  const dom = new JSDOM(html)
  return { document: dom.window.document }
}
