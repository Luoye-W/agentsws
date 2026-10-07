/**
 * WP254（决策 100 / 123）：「换国内源再试」与设置 · 诊断「下载源」那一行的词条（中英各一份）。
 * 单独一个文件、在 `i18n.ts` 的表里并进去（同 `i18n-own-sub.ts`）。界面少字：长说明进问号。
 */
export const NPM_REGISTRY_ZH: Record<string, string> = {
  'npm_registry.retry_mirror': '换国内源再试',
  'npm_registry.retry_mirror.hint':
    '改从国内镜像（npmmirror）下载，校验照旧；这台电脑之后都用它，可在「设置 · 诊断」改回官方源。',
  'npm_registry.title': '下载源',
  'npm_registry.hint':
    '一键安装平台 CLI、下载连接器从哪里取包。国内网络连不上官方源时用国内源（npmmirror），校验照旧。只影响这台电脑。',
  'npm_registry.source.official': '官方源',
  'npm_registry.source.npmmirror': '国内源（npmmirror）',
  'npm_registry.use_official': '改回官方源',
  'npm_registry.use_mirror': '改用国内源',
  'npm_registry.env_override': '这台电脑的环境里另设了下载源，官方源这一档会用它。',
}

export const NPM_REGISTRY_EN: Record<string, string> = {
  'npm_registry.retry_mirror': 'Retry with China mirror',
  'npm_registry.retry_mirror.hint':
    'Download from the npmmirror mirror instead (same integrity checks). This computer keeps using it; switch back in Settings · Diagnostics.',
  'npm_registry.title': 'Download source',
  'npm_registry.hint':
    'Where one-click CLI installs and the connector download fetch packages. Use the China mirror (npmmirror) when the official registry is unreachable; integrity checks stay the same. This computer only.',
  'npm_registry.source.official': 'Official registry',
  'npm_registry.source.npmmirror': 'China mirror (npmmirror)',
  'npm_registry.use_official': 'Switch back to official',
  'npm_registry.use_mirror': 'Use China mirror',
  'npm_registry.env_override':
    'This computer sets its own registry in the environment; the official option uses it.',
}
