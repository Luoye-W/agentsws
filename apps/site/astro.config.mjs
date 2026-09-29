/**
 * 官网（WP197）：纯静态出 HTML，零后端、零客户端框架。
 * 中文在 `/`、英文在 `/en/`，同一套路径；不按浏览器语言自动跳（docs/87 §8 第 5 条）。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  site: 'https://agentsws.com',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // 每页的 CSS 直接内联：首屏少一个阻塞渲染的请求（Lighthouse 移动端那一项）
    inlineStylesheets: 'always',
  },
  devToolbar: { enabled: false },
  // 教程文章（docs/help）与产品截图（docs/assets）在仓库根下，不复制一份
  vite: { server: { fs: { allow: [repoRoot] } } },
})
