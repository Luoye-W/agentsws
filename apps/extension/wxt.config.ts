import { defineConfig } from 'wxt'

/**
 * 「Agents 工坊 · 红人助手」的 MV3 清单（WP119 / 68）。
 *
 * **为什么是 WXT 不是 Plasmo**：这个仓库的工作台已经是 Vite 7 + React 19 +
 * Tailwind v4，WXT 本身就是一层 Vite 插件——同一套 `vite.config` 概念、同一个
 * `@tailwindcss/vite`、同一份 `@vitejs/plugin-react`，连 vitest 都能直接复用。
 * Plasmo 自带 Parcel 那一套构建，等于在这个仓里再养第二条工具链。
 *
 * 权限上的四条，每一条都是审核时会被问到的：
 *
 * 1. `host_permissions` 只有三个平台 + `http://127.0.0.1/*`。没有 `<all_urls>`、
 *    没有 `tabs`、没有 `history`、没有 `webRequest`——插件读不到你在别处开了什么。
 * 2. `activeTab` 而不是全局注入：content script 只在那三个域名的页面上跑，
 *    而且**页面上不点按钮就一个字段都不解析**（解析函数由用户动作触发）。
 * 3. `storage` 只用来放三样东西：本机服务端口、配对得来的插件令牌、
 *    桌面应用没开时排队的观测。三样都在设置页看得见、清得掉。
 * 4. 没有 `content_security_policy` 的放宽项：不远程加载任何脚本。
 */
export default defineConfig({
  srcDir: '.',
  modules: ['@wxt-dev/module-react'],
  outDir: 'build',
  manifest: {
    name: 'Agents 工坊 · 红人助手',
    short_name: '红人助手',
    description:
      '在 YouTube / Instagram / TikTok 页面上即时体检红人，一键把公开资料收进你本机的 Agents 工坊红人库。',
    default_locale: 'zh_CN',
    // `alarms` 是给「应用刚打开，把排着的补上去」那个 5 分钟定时用的；
    // 没有它 service worker 一被回收，队列就要等用户下次点按钮才动。
    permissions: ['storage', 'activeTab', 'alarms'],
    host_permissions: [
      'https://*.youtube.com/*',
      'https://*.instagram.com/*',
      'https://*.tiktok.com/*',
      // 本机服务。只有回环——插件不认识任何其它 http 目标。
      'http://127.0.0.1/*',
    ],
    action: { default_title: 'Agents 工坊 · 红人助手' },
  },
  zip: { name: 'agentsws-influencer-assistant' },
})
