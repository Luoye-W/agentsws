/**
 * 四个岗位共用的那一份注入（71 §5 第一条）。
 *
 * **只有这一个地方拼这段话。** 设计、建站、社媒、投放各自拼一遍的话，过两周
 * 它们就会拼得不一样——而"为什么社媒出的图和建站出的页面不是一套颜色"这种
 * 问题，事后没人查得出来是哪一行提示词的差别造成的。
 *
 * 三条克制，都是从"这段话要被塞进每一次出活的提示词里"这个事实推出来的：
 *
 * 1. **短。** 令牌全文几百行，塞进去等于每次出活都先烧一遍钱。这里只出色板、
 *    字体、圆角、间距与几条守则，压在 {@link MAX_CONTEXT_CHARS} 以内。
 * 2. **不编。** 没抓到的项**整行不出现**，而不是写"未指定"——后者会被模型
 *    当成一条指令去满足它。
 * 3. **没有规范时 `present: false`，`prompt` 为空串。** 调用方照常干活，
 *    只是不注入。一个空的品牌规范不该让出图这件事停下来。
 */
import type { BrandDesignContext, BrandDesignProfile } from '@agentsws/contracts'
import { fontsOf, paletteOf, tokensOf } from './serialize.js'

/** 注入的那段话最多多长。超了截断——省的是每一次出活的钱。 */
export const MAX_CONTEXT_CHARS = 900

/** 没有规范时的那一份。**调用方照常干活。** */
export const EMPTY_BRAND_DESIGN_CONTEXT: BrandDesignContext = {
  present: false,
  prompt: '',
  tokens: {},
  palette: [],
  fonts: [],
}

export interface BrandDesignContextInput {
  profile?: BrandDesignProfile
  /** 哪个岗位要用（只影响最后那一两句的侧重）。 */
  role?: 'design' | 'site' | 'social' | 'ads'
}

/**
 * 职责 id → 四个吃规范的岗位族（WP122b）。
 *
 * 职责 id 的**第一段**就是岗位域（`packages/roles/roles/<域>/*.yml`），
 * 设计 / 建站 / 社媒 / 投放四个域各吃同一份 `DESIGN.md` 的一个侧面。
 * 四个域以外的职责（客服、仓储、公关……）回 `undefined`——它们没有
 * "出图 / 出页面"这一步，注一段品牌令牌进去只是烧 token。
 */
export function designRoleFamily(
  role_id: string,
): 'design' | 'site' | 'social' | 'ads' | undefined {
  if (role_id.startsWith('design.')) return 'design'
  if (role_id.startsWith('site.')) return 'site'
  if (role_id.startsWith('social.')) return 'social'
  if (role_id.startsWith('ads.')) return 'ads'
  return undefined
}

/** 每个岗位最关心的那一句。**只有一句**——多了就成了模板文学。 */
const ROLE_NOTE: Record<NonNullable<BrandDesignContextInput['role']>, string> = {
  design: '出图时：主色只用在一张图里最重要的那一处，其余用中性色撑。',
  site: '出页面时：间距与圆角照上面的阶梯取值，不要自己造中间档。',
  social: '出社媒图文时：同一组帖子里字体不超过两种。',
  ads: '出广告素材时：文字压在图上要够对比度，主色留给行动按钮。',
}

/**
 * 拼那一段话。
 *
 * `profile` 没给、或者给了但色板与字体都空 → {@link EMPTY_BRAND_DESIGN_CONTEXT}。
 */
export function brandDesignContext(input: BrandDesignContextInput = {}): BrandDesignContext {
  const profile = input.profile
  if (profile === undefined) return EMPTY_BRAND_DESIGN_CONTEXT

  const palette = paletteOf(profile)
  const fonts = fontsOf(profile)
  const tokens = tokensOf(profile)
  if (palette.length === 0 && fonts.length === 0) return EMPTY_BRAND_DESIGN_CONTEXT

  const lines: string[] = []
  const name = profile.name?.value
  lines.push(`【品牌设计规范${name === undefined ? '' : `｜${name}`}】`)

  if (profile.colors !== undefined && palette.length > 0) {
    const named = Object.entries(profile.colors)
      .map(([token, v]) => `${token} ${v.value}`)
      .join('、')
    lines.push(`色：${named}`)
  }
  if (fonts.length > 0) lines.push(`字：${fonts.join('、')}`)

  const sizes = Object.entries(profile.typography ?? {})
    .map(([token, v]) =>
      v.value.fontSize === undefined ? undefined : `${token} ${v.value.fontSize}`,
    )
    .filter((x): x is string => x !== undefined)
  if (sizes.length > 0) lines.push(`字号：${sizes.join('、')}`)

  const rounded = Object.entries(profile.rounded ?? {}).map(([k, v]) => `${k} ${v.value}`)
  if (rounded.length > 0) lines.push(`圆角：${rounded.join('、')}`)

  const spacing = Object.entries(profile.spacing ?? {}).map(([k, v]) => `${k} ${String(v.value)}`)
  if (spacing.length > 0) lines.push(`间距：${spacing.join('、')}`)

  const logo = profile.logos?.value[0]
  if (logo?.min_width_px !== undefined) lines.push(`logo 最小宽度 ${String(logo.min_width_px)}px`)
  if (logo?.clear_space_ratio !== undefined)
    lines.push(`logo 四周留白不小于它宽度的 ${String(logo.clear_space_ratio)} 倍`)

  const voice = profile.voice?.value
  if (voice !== undefined) lines.push(`气质：${voice}`)

  lines.push('【纪律】只用上面列的色与字。要用别的，先说明理由。')
  if (input.role !== undefined) lines.push(ROLE_NOTE[input.role])

  let prompt = lines.join('\n')
  if (prompt.length > MAX_CONTEXT_CHARS) prompt = `${prompt.slice(0, MAX_CONTEXT_CHARS - 1)}…`

  return { present: true, prompt, tokens, palette, fonts }
}
