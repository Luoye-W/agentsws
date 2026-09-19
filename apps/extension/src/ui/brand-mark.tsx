/**
 * 母品牌标记。**几何与颜色从 `@agentsws/brand` 来，这里一个数字都不自己画**
 * （与工作台的 `BrandMark`、桌面壳的图标脚本同一份真源）。
 *
 * 面板里那一枚只有 20px——按 `§1.3` 的规矩，小于 28px 一律走单色版：
 * 再小方块之间的缝会并起来，渐变只剩一团糊。
 */

import { BRAND_MARK_SVG_MONO } from '@agentsws/brand'

export function BrandMark(): React.ReactNode {
  // SVG 是这个包里的常量字符串（不是用户输入、不来自页面），所以直接塞进去。
  return (
    <span
      className="ws-mark"
      aria-hidden
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 常量 SVG，来自 @agentsws/brand
      dangerouslySetInnerHTML={{ __html: BRAND_MARK_SVG_MONO }}
    />
  )
}
