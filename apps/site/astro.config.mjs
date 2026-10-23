/**
 * 官网（WP197）：纯静态出 HTML，零后端、零客户端框架。
 * 中文在 `/`、英文在 `/en/`，同一套路径；不按浏览器语言自动跳（docs/87 §8 第 5 条）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 教程上官网（私有 docs/113 §2.2）：教程改过名（头上 `aliases: [旧名]`）时，旧网址永久跳到新网址。
 * 构建完从刚出的 `help/index.json` 读，写 `dist/_redirects`（Cloudflare 静态资源原生认）。
 */
function helpRedirects() {
  return {
    name: 'agentsws-help-redirects',
    hooks: {
      'astro:build:done': ({ dir }) => {
        const index = JSON.parse(readFileSync(new URL('help/index.json', dir), 'utf8'))
        const lines = []
        for (const item of index.items) {
          if (item.kind !== 'guide' || !Array.isArray(item.aliases)) continue
          const base = item.lang === 'en' ? '/en/docs' : '/docs'
          for (const old of item.aliases) {
            lines.push(`${base}/${old}/ ${base}/${item.slug}/ 301`)
            lines.push(`${base}/${old}.md ${base}/${item.slug}.md 301`)
          }
        }
        if (lines.length > 0) writeFileSync(new URL('_redirects', dir), `${lines.join('\n')}\n`)
      },
    },
  }
}

export default defineConfig({
  site: 'https://agentsws.com',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // 每页的 CSS 直接内联：首屏少一个阻塞渲染的请求（Lighthouse 移动端那一项）
    inlineStylesheets: 'always',
  },
  devToolbar: { enabled: false },
  integrations: [helpRedirects()],
  // 教程文章（docs/help）与产品截图（docs/assets）在仓库根下，不复制一份
  vite: { server: { fs: { allow: [repoRoot] } } },
})
