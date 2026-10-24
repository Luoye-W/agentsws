/**
 * WP504（F4c）：输入框里打 `@` 能搜到的东西——**谁有资料谁登记**（红人库登记红人、知识库登记知识条目），
 * 输入框不认任何一种。选中一条 = 和点 ✦ 一样变成一枚引用小卡。
 *
 * 和面板注册表同一条规矩（`components/rail/registry.ts`）：内置的也走这条公开路，没有后门。
 */
import type { ContextRef } from './ask-ai-store'

/** 一条 `@` 结果：引用小卡本身 + 菜单右边那个灰字（「红人」「知识」）。 */
export interface RefHit {
  ref: ContextRef
  /** 已经翻译好的类型名。 */
  type: string
}

export interface RefSource {
  id: string
  /**
   * 按一个词搜（空串 = 最近的几条）。`lang` 给类型名用。
   * 要轻：每敲一个字可能调一次（输入框那边已经防抖），拿不到就回空。
   */
  search(q: string, lang: 'zh' | 'en'): Promise<RefHit[]>
}

const sources = new Map<string, RefSource>()

/** 登记一种 `@` 能搜到的东西（同 id 再登记 = 换掉）。回一个注销。 */
export function registerRefSource(source: RefSource): () => void {
  sources.set(source.id, source)
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id)
  }
}

/** 全部来源一起搜，每家最多 `per` 条；哪一家出错就当它没有。 */
export async function searchRefs(q: string, lang: 'zh' | 'en', per = 4): Promise<RefHit[]> {
  const all = await Promise.all(
    [...sources.values()].map(async (s) => {
      try {
        return (await s.search(q, lang)).slice(0, per)
      } catch {
        return []
      }
    }),
  )
  return all.flat()
}

/** 只给测试用。 */
export function resetRefSources(): void {
  sources.clear()
}
