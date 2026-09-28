/**
 * 首次设置的 B2B 分支：按官网 / 公司描述 / 材料判断行业，推荐打法与认证清单（docs/84 §3.1、docs/70）。
 *
 * 出处：Luoye/BtoBAgents（Luoye 自己的私有仓库，本机 `~/Documents/BtoBAgents`）
 * `src/features/btobagents/runtime-v2/onboarding.ts`（`buildOnboardingRecommendation`），
 * 首次 `5d4ed9c`、`29f93fe` 改过、`c832e1e` 改名，移植时仓库 HEAD `940f12b`；
 * 入参 / 出参形状摘自同目录 `types.ts` 的 `OnboardingInput` / `OnboardingRecommendation`。
 * 不在 KOLAgents 纯模板提交 `cb506142` 里。
 *
 * 移植改动：
 * 1. **要人确认的商业授权补齐四个数**（原来只有毛利 / 折扣 / 账期三个），提议值取契约的
 *    `DEFAULT_B2B_QUOTE_MANDATE`——两套阈值统一成一套（docs/84 §3.2）。
 * 2. 推荐连接去掉 `firecrawl`（docs/84 §6.1：看官网本机就能做，第一版不接）与
 *    `apify-linkedin`（§11.1 第 7 条：Apify 查 LinkedIn 默认关），改成本仓连接目录的 kind；
 *    日历标"待增加"。
 * 3. 发信域名那一格（§11.1 第 4 条）：**强烈建议**独立发信域名、由用户选，不替他设。
 * 4. 字段改成本仓的 snake_case；行业正则、打法名、认证清单、默认销售阶段原样。
 */
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

export interface OnboardingInput {
  website?: string
  company_name?: string
  description?: string
  employee_range?: string
  annual_revenue_range?: string
  target_markets?: string[]
  products?: string[]
  materials?: Array<{ name: string; text: string }>
}

export interface OnboardingRecommendation {
  profile: {
    company_name: string
    website?: string
    industry: string
    sub_industry: string
    business_model: string
    stage: string
    size: string
    target_markets: string[]
    products: string[]
    evidence: string[]
  }
  auto_applied: Array<{ key: string; label: string; value: JsonValue; reason: string }>
  requires_confirmation: Array<{
    key: string
    label: string
    proposed_value: JsonValue
    reason: string
    risk: 'commercial' | 'compliance' | 'automation'
  }>
  recommended_integrations: string[]
  recommended_playbooks: string[]
  missing_information: string[]
}

const lower = (value: string | undefined) => (value ?? '').toLowerCase()
const unique = <T>(values: T[]) => [...new Set(values)]

/** 行业识别的结论（{@link buildOnboardingRecommendation} 的一部分，单独导出给模拟包与测试用）。 */
export interface IndustryGuess {
  industry: string
  sub_industry: string
  products: string[]
  playbooks: string[]
  certifications: string[]
}

export function guessIndustry(corpus: string, products: string[] = []): IndustryGuess {
  const text = corpus.toLowerCase()
  if (
    /gan|charger|充电|power bank|移动电源|tws|earbud|耳机|3c|consumer electronics|智能硬件/.test(
      text,
    )
  )
    return {
      industry: '消费电子 / 3C',
      sub_industry: /charger|充电|gan/.test(text) ? '充电与电源产品' : '消费电子配件',
      products: products.length ? products : ['GaN 充电器', '移动电源', 'TWS 耳机'],
      playbooks: [
        '3c-distributor-development',
        '3c-private-label',
        'trade-show-followup',
        'dormant-reactivation',
        'repurchase-expansion',
      ],
      certifications: ['CE', 'FCC', 'RoHS', 'UKCA', 'PSE', 'UL/ETL（按产品与市场确认）'],
    }
  if (/apparel|garment|fashion|服装|纺织|面料/.test(text))
    return {
      industry: '服装与纺织',
      sub_industry: 'OEM / ODM 服装',
      products: products.length ? products : ['成衣', '面料', 'Private Label'],
      playbooks: ['apparel-brand-development', 'seasonal-buying-cycle', 'trade-show-followup'],
      certifications: [],
    }
  if (/smart home|智能家居|iot|matter/.test(text))
    return {
      industry: '智能家居',
      sub_industry: 'IoT 硬件',
      products: products.length ? products : ['智能家居设备', 'IoT 模组'],
      playbooks: ['smart-home-distributor', 'private-label', 'technical-evaluation'],
      certifications: ['CE', 'FCC', 'RoHS', 'Matter/Thread（按产品确认）'],
    }
  if (/automotive|auto parts|汽配|车载/.test(text))
    return {
      industry: '汽车电子 / 汽配',
      sub_industry: '车载电子',
      products: products.length ? products : ['车载电子产品'],
      playbooks: ['automotive-distributor', 'fitment-qualification', 'sample-validation'],
      certifications: ['CE', 'FCC', 'RoHS', 'ECE / IATF 相关要求需人工确认'],
    }
  return {
    industry: 'B2B 出口贸易',
    sub_industry: '综合产品',
    products,
    playbooks: ['new-account-outbound', 'trade-show-followup', 'dormant-reactivation'],
    certifications: [],
  }
}

export function buildOnboardingRecommendation(input: OnboardingInput): OnboardingRecommendation {
  const materialText = (input.materials ?? []).map((item) => `${item.name} ${item.text}`).join(' ')
  const corpus = lower(
    [input.company_name, input.website, input.description, materialText, ...(input.products ?? [])]
      .filter(Boolean)
      .join(' '),
  )
  const guess = guessIndustry(corpus, input.products ?? [])
  const { industry, playbooks } = guess

  const size =
    input.employee_range ??
    (/factory|工厂|manufacturer|制造/.test(corpus) ? '50–200 人' : '10–50 人')
  const stage = /global|全球|million|m\b|亿|成熟/.test(corpus) ? '规模化出海' : '增长期出海'
  const business_model = /oem|odm|private label|代工|贴牌/.test(corpus)
    ? 'OEM / ODM / Private Label'
    : '品牌 + B2B 渠道'
  const target_markets = unique(
    input.target_markets?.length ? input.target_markets : ['北美', '欧洲'],
  )
  const company_name =
    input.company_name ??
    new URL(input.website ?? 'https://company.example').hostname.split('.')[0] ??
    '待确认公司'
  const mandate = DEFAULT_B2B_QUOTE_MANDATE

  return {
    profile: {
      company_name,
      ...(input.website === undefined ? {} : { website: input.website }),
      industry,
      sub_industry: guess.sub_industry,
      business_model,
      stage,
      size,
      target_markets,
      products: guess.products,
      evidence: [
        input.website ? `官网：${input.website}` : '未提交官网',
        input.description ? '用户提交的公司描述' : '未提交公司描述',
        input.materials?.length ? `已分析 ${input.materials.length} 份材料` : '未提交额外材料',
      ],
    },
    auto_applied: [
      {
        key: 'workspace.locale',
        label: '默认语言',
        value: 'zh-CN',
        reason: '中国出海团队默认使用中文后台',
      },
      {
        key: 'workspace.industry',
        label: '行业',
        value: industry,
        reason: '根据官网、公司描述和材料中的产品关键词识别',
      },
      {
        key: 'workspace.products',
        label: '产品线',
        value: guess.products,
        reason: '从提交资料中提取，可继续在使用过程中补全',
      },
      {
        key: 'workspace.targetMarkets',
        label: '目标市场',
        value: target_markets,
        reason: '采用提交信息；未提供时使用出海企业常见起点',
      },
      {
        key: 'crm.defaultStages',
        label: '默认销售阶段',
        value: ['建联', '已回复', '会议', '样品', '报价', '谈判', '成交'],
        reason: '按 B2B 出口销售闭环初始化',
      },
      {
        key: 'playbooks.enabled',
        label: '建议 Playbook',
        value: playbooks,
        reason: `根据 ${industry} 和 ${business_model} 自动选择`,
      },
      {
        key: 'automation.safeActions',
        label: '安全自动化',
        value: ['研究', '摘要', '草稿', '提醒', '内部任务'],
        reason: '这些动作不会产生外部商业承诺',
      },
      ...(guess.certifications.length
        ? [
            {
              key: 'companyBrain.certificationMatrix',
              label: '认证矩阵初稿',
              value: guess.certifications,
              reason: '按行业与目标市场生成候选，具体型号仍需核实',
            },
          ]
        : []),
    ],
    requires_confirmation: [
      // 移植改动 1：四个数都在这里（原来少单笔金额），提议值是统一后的那一套
      {
        key: 'commercial.maxQuoteAmountUsd',
        label: '单笔报价上限（美元）',
        proposed_value: mandate.max_amount_usd,
        reason: '超出就转上级批；没有上级转老板',
        risk: 'commercial',
      },
      {
        key: 'commercial.minimumMarginPercent',
        label: '最低毛利率',
        proposed_value: mandate.min_margin_pct,
        reason: '会影响报价由谁批与利润，必须由企业确认',
        risk: 'commercial',
      },
      {
        key: 'commercial.maximumDiscountPercent',
        label: '最大折扣',
        proposed_value: mandate.max_discount_pct,
        reason: '属于不可由 AI 从历史数据擅自学习的商业授权',
        risk: 'commercial',
      },
      {
        key: 'commercial.paymentTermsDays',
        label: '最长账期',
        proposed_value: mandate.max_payment_terms_days,
        reason: '影响现金流和信用风险',
        risk: 'commercial',
      },
      {
        key: 'automation.externalSendLevel',
        label: '外发自动化等级',
        proposed_value: 'L1',
        reason: '发信、报价、缴费、放单、付款一律先出卡，攒够采纳率再逐项提升',
        risk: 'automation',
      },
      // 移植改动 3：发信域名由用户选，强烈建议独立域名，不替他设
      {
        key: 'outbound.sendingDomain',
        label: '开发信发信域名',
        proposed_value: 'separate',
        reason: '冷邮件被投诉多了整个域名信誉会掉，强烈建议另用一个域名；用主域名也能发',
        risk: 'compliance',
      },
      {
        key: 'compliance.apifyLinkedInUse',
        label: '公开资料研究边界',
        proposed_value: '仅候选发现与公开资料读取；LinkedIn 只出你本人去发的任务',
        reason: '不得把抓取结果直接当成已验证身份或自动操作 LinkedIn',
        risk: 'compliance',
      },
    ],
    // 移植改动 2：本仓连接目录的 kind；日历还没有（待增加）
    recommended_integrations: ['email', 'whatsapp_business', 'calendar（待增加）'],
    recommended_playbooks: playbooks,
    missing_information: [
      ...(input.website ? [] : ['公司官网或产品资料']),
      ...(input.products?.length ? [] : ['需要确认主推产品和暂停推广产品']),
      '最低毛利、样品政策、账期、独家政策与自动化授权边界',
    ],
  }
}
