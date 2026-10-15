/**
 * WP336：dsh-genui 的行内富文本遇到 `$…$` 会交给 KaTeX 排公式。当场回答里用不到公式，而 KaTeX
 * 连字体有几百 KB，所以打包时（vite.config.ts，只对 dsh-genui 里的引用）换成这份：原样写回去，
 * 看起来跟没解析一样（「$12 – $15」这类价格不会变样）。
 */
function render(source: string, el: HTMLElement, options: { displayMode?: boolean } = {}): void {
  el.textContent = options.displayMode === true ? `$$${source}$$` : `$${source}$`
}

export default { render }
