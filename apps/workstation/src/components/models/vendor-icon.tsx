/**
 * WP362：AI 厂商图标（输入框 AI 钮每一行左边那一个）。
 *
 * 「先找现成的」：图来自 LobeHub 的 `@lobehub/icons-static-svg` 1.95.1（MIT），**只挑了我们用得到的
 * 十一家**，原样拷进 `assets/vendors/`（出处与许可证见那个目录里的 `LICENSE`），没把整个包打进来。
 *
 * - 彩色的那几家（DeepSeek、通义、智谱、MiniMax、Gemini、豆包、Meta、Mistral）按原图画；
 * - 单色的三家（OpenAI、Anthropic、Kimi）原图是 `currentColor`，当 `<img>` 用会一律画成黑的——
 *   改成 CSS 遮罩，颜色跟着文字走（深色模式下自动变浅）。
 *
 * 认不出的厂商回 `undefined`，调用方落到来源自己的图标（`BrandIcon`）。
 */
const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../assets/vendors/*.svg', { eager: true, import: 'default' }) as Record<
      string,
      string
    >,
  ).map(([path, url]) => [path.replace(/^.*\//, '').replace(/\.svg$/, ''), url]),
)

/** 厂商 id（服务端 `vendorOfModel` 给的）→ 图的文件名。 */
const FILE_OF: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  moonshot: 'kimi',
  deepseek: 'deepseek',
  qwen: 'qwen',
  zhipu: 'zhipu',
  minimax: 'minimax',
  google: 'gemini',
  doubao: 'doubao',
  meta: 'meta',
  mistral: 'mistral',
}

/** 原图是单色（`currentColor`）的那几张。 */
const MONO = new Set(['openai', 'anthropic', 'kimi'])

export function hasVendorIcon(vendor: string | undefined): boolean {
  const file = vendor === undefined ? undefined : FILE_OF[vendor]
  return file !== undefined && URLS[file] !== undefined
}

export function VendorIcon({
  vendor,
  size = 16,
  className = '',
}: {
  vendor: string
  size?: number
  className?: string
}): React.ReactNode {
  const file = FILE_OF[vendor]
  const url = file === undefined ? undefined : URLS[file]
  if (file === undefined || url === undefined) return null
  if (MONO.has(file))
    return (
      <span
        aria-hidden
        data-testid="vendor-icon"
        data-vendor={vendor}
        className={`inline-block shrink-0 bg-current ${className}`}
        style={{
          width: size,
          height: size,
          maskImage: `url("${url}")`,
          WebkitMaskImage: `url("${url}")`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
        }}
      />
    )
  return (
    <img
      aria-hidden
      alt=""
      src={url}
      width={size}
      height={size}
      data-testid="vendor-icon"
      data-vendor={vendor}
      className={`shrink-0 ${className}`}
      style={{ objectFit: 'contain' }}
    />
  )
}
