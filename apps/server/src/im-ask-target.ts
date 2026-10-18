/**
 * WP417（自查客服 F7）：在飞书 / 钉钉 / 企业微信里问「小王今天忙吗」——**被问的是小王**，不是提问的人自己。
 *
 * 以前 IM 那一路一律 `ask(提问人, 提问人, 问题)`，于是答的是提问人自己的忙闲。这里从问题里认出点名的同事
 * （工作区成员的名字，最长匹配；`@名字` 也认），认不出就还是问自己（「我今天有什么会」这类）。
 */
export interface NamedPerson {
  id: string
  name: string
}

/** 问题里点名的那位同事（不含提问人自己）；没点名回 `undefined`。 */
export function pickNamedPerson(
  question: string,
  people: readonly NamedPerson[],
  viewer: string,
): NamedPerson | undefined {
  const q = question.toLowerCase()
  let best: NamedPerson | undefined
  for (const p of people) {
    if (p.id === viewer) continue
    const name = p.name.trim()
    // 一个字的名字太容易误命中（「王」「李」）
    if (name.length < 2) continue
    if (!q.includes(name.toLowerCase())) continue
    if (best === undefined || name.length > best.name.length) best = p
  }
  return best
}
