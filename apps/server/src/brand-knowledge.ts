/**
 * 确认档案卡那一刻，往知识库里建的**首批条目**（70 §3.5，WP121b）。
 *
 * 分析读到的东西里，只有两类值得一开始就进知识库：
 *
 * | 建什么 | 为什么是它 |
 * |---|---|
 * | 政策要点（退换货 / 物流 / 保修 / 隐私 / 条款） | 客服岗**第一天**就要用 |
 * | 主打商品卡（名 + 价） | 问"多少钱"是最常见的一句 |
 *
 * 其余字段（品牌名、主色、社媒链接…）进的是**工作区档案**，不是知识库：
 * 知识库答的是"客户问了我们怎么说"，品牌主色不在这个问题的答案里。
 *
 * 三条纪律：
 *
 * 1. **一律 `proposed`**（19 §4 / 70 §3.5）。这是机器从别人网页上读来的一句话，
 *    在人点头之前它不该被任何 Agent 当成"我们的口径"引用。`propose` 本身就把
 *    状态钉死成 `proposed`，这里不碰它。
 * 2. **每条都带出处**（19 原则②）：哪个网址、原文那一段。没有出处的条目
 *    `propose` 会直接拒——那是对的，一条"我们 30 天退款"如果说不出从哪儿看来的，
 *    它就是编的。
 * 3. **层次分清**：政策进 `policy`（承诺类，永不自动激活），商品价进 `fact`。
 *    把价格当政策的后果是它跟着政策的审批节奏走，而价格是天天变的。
 *
 * 这个文件是**纯函数**：它只把档案翻译成一叠"待提议的卡"，谁来提、提到哪个库
 * 由调用方决定（`apps/server/src/server.ts` 装的是 `knowledge.store.propose`）。
 */
import type {
  BrandIntakeProfile,
  FactCard,
  Iso8601,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'

/** `propose` 的入参形状（`packages/knowledge` 那边的 `Omit<FactCard, …>`）。 */
export type ProposedCard = Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>

/** 政策那几类各自的一句话说法（界面与知识库用同一份）。 */
const POLICY_LABEL: Record<string, string> = {
  refund: '退换货',
  shipping: '物流与配送',
  warranty: '保修',
  privacy: '隐私',
  terms: '服务条款',
}

/**
 * 「自动分析，待核」。
 *
 * 它不是一个额外的状态位——`proposed` + `unverified` 已经把"待核"说完了。
 * 这一串进 `locator`，answers 的是**这条是谁读来的**：人在知识库里看见它，
 * 一眼知道这不是同事写的，是我们从网页上读的。
 */
export const BRAND_INTAKE_LOCATOR = '自动分析，待核'

function baseOf(workspace_id: WorkspaceId, at: Iso8601, owner: PersonId) {
  return {
    schema_version: 1 as const,
    workspace_id,
    scope: [],
    confidence: { value: 0.5, state: 'unverified' as const },
    valid: { from: at },
    owner,
    // **是机器建的，就说是机器建的**：以后谁来问"这句话哪来的"，这一格与
    // `provenance.locator` 一起答得清楚
    created_by: { kind: 'agent' as const, id: 'brand-intake' },
  }
}

/**
 * 把一份确认下来的品牌档案翻译成首批知识条目。
 *
 * 抓不到的一条都不建：**没有 `url` 的政策、没有价的商品直接跳过**。
 * 一条说不出出处的知识比没有这条更糟——它会被引用，然后没有人查得出它错在哪儿。
 */
export function brandKnowledgeCards(
  profile: BrandIntakeProfile,
  input: { workspace_id: WorkspaceId; at: Iso8601; owner: PersonId },
): ProposedCard[] {
  const base = baseOf(input.workspace_id, input.at, input.owner)
  const brand = profile.brand_name?.value ?? profile.legal_name?.value ?? '这个品牌'
  const out: ProposedCard[] = []

  for (const policy of profile.policies?.value ?? []) {
    if (policy.url === '' || policy.summary === '') continue
    out.push({
      ...base,
      layer: 'policy',
      domain: 'company',
      sensitivity: 'internal',
      subject: { type: 'policy', id: policy.kind, key: `policy:${policy.kind}` },
      statement: `${POLICY_LABEL[policy.kind] ?? policy.kind}：${policy.summary}`,
      provenance: [
        {
          source: 'web',
          ref: policy.url,
          locator: BRAND_INTAKE_LOCATOR,
          quote: policy.summary,
          at: input.at,
        },
      ],
    })
  }

  for (const product of profile.products?.value ?? []) {
    if (product.title === '' || product.price_snapshot === undefined) continue
    const ref = product.url ?? profile.logo_url?.evidence[0]?.url
    if (ref === undefined) continue
    out.push({
      ...base,
      layer: 'fact',
      domain: 'company',
      sensitivity: 'internal',
      subject: {
        type: 'product',
        ...(product.asin === undefined ? {} : { id: product.asin }),
        key: `product:${product.title}`,
      },
      statement: `${brand} 的「${product.title}」标价 ${product.price_snapshot}`,
      structured: {
        title: product.title,
        price_snapshot: product.price_snapshot,
        ...(product.currency === undefined ? {} : { currency: product.currency }),
      },
      provenance: [
        {
          source: 'web',
          ref,
          locator: BRAND_INTAKE_LOCATOR,
          quote: `${product.title} ${product.price_snapshot}`,
          at: input.at,
        },
      ],
    })
  }

  return out
}
