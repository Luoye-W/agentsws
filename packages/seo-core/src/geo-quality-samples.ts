/**
 * WP380：**录好的样本**（测试、模拟、截图共用；不调真实接口、不花钱）。
 *
 * 一个编的品牌 NordVolt（`.example` 域名，没有任何真实店铺数据）、它的官方事实表（价格带十月一日从
 * $39–$59 改成 $45–$69，所以说「$39」的算过时）、六条 AI 回答原文和当时模型对每条的判断回文、
 * 两张页面（我们的商品页、一家评测站）与模型对评测站的回文。模型回文是照真实格式录的固定串。
 */
import type { AiPlatform, GeoOfficialFact } from '@agentsws/contracts'

export const GEO_SAMPLE_BRAND = {
  name: 'NordVolt',
  domains: ['nordvolt.example'],
  competitors: ['Anker', 'Belkin'],
} as const

export const GEO_SAMPLE_FACTS: readonly GeoOfficialFact[] = [
  { key: 'name', value: 'NordVolt', as_of: '2026-03-01', source: 'profile' },
  { key: 'category', value: 'travel power bank', as_of: '2026-03-01', source: 'profile' },
  {
    key: 'price',
    value: '$45–$69',
    as_of: '2026-10-01',
    source: 'profile',
    previous: [{ value: '$39–$59', until: '2026-10-01' }],
  },
  {
    key: 'selling_points',
    value: 'flight-safe 10000mAh, charges a phone three times, 180 g',
    as_of: '2026-03-01',
    source: 'profile',
  },
  { key: 'markets', value: 'US, DE', as_of: '2026-03-01', source: 'profile' },
]

/** 一条录好的回答：问的什么、哪个 AI、原文、规则会认出的竞品、当时模型的判断回文。 */
export interface GeoSampleAnswer {
  id: string
  prompt: string
  platform: AiPlatform
  text: string
  rivals: readonly string[]
  reply: string
}

const j = (o: unknown): string => JSON.stringify(o)

export const GEO_SAMPLE_ANSWERS: readonly GeoSampleAnswer[] = [
  {
    id: 's1',
    prompt: 'Anker or NordVolt for a travel power bank?',
    platform: 'chatgpt',
    text: 'Both are solid. For flying, NordVolt Air is the better pick because it is flight-safe and only 180 g. Anker PowerCore is cheaper at home.',
    rivals: ['Anker'],
    reply: j({
      sentiment: 'positive',
      quote:
        'For flying, NordVolt Air is the better pick because it is flight-safe and only 180 g.',
      brands: [],
      compare: {
        verdict: 'ours',
        rival: 'Anker',
        quote:
          'For flying, NordVolt Air is the better pick because it is flight-safe and only 180 g.',
      },
      claims: [
        {
          field: 'selling_points',
          verdict: 'correct',
          said: 'flight-safe, 180 g',
          quote:
            'For flying, NordVolt Air is the better pick because it is flight-safe and only 180 g.',
        },
      ],
    }),
  },
  {
    id: 's2',
    prompt: 'Best power bank for long flights?',
    platform: 'gemini',
    text: 'Belkin BoostCharge is the one I would buy first. NordVolt is a newer travel power bank brand that sells for about $39.',
    rivals: ['Belkin'],
    reply: j({
      sentiment: 'neutral',
      quote: 'NordVolt is a newer travel power bank brand that sells for about $39.',
      brands: [],
      compare: {
        verdict: 'competitor',
        rival: 'Belkin',
        quote: 'Belkin BoostCharge is the one I would buy first.',
      },
      claims: [
        {
          field: 'category',
          verdict: 'correct',
          said: 'travel power bank brand',
          quote: 'NordVolt is a newer travel power bank brand that sells for about $39.',
        },
        {
          field: 'price',
          verdict: 'wrong',
          said: 'about $39',
          quote: 'NordVolt is a newer travel power bank brand that sells for about $39.',
        },
      ],
    }),
  },
  {
    id: 's3',
    prompt: 'Is NordVolt a good power bank brand?',
    platform: 'claude',
    text: 'NordVolt makes car jump starters and ships only within the UK.',
    rivals: [],
    reply: j({
      sentiment: 'neutral',
      quote: 'NordVolt makes car jump starters and ships only within the UK.',
      brands: [],
      claims: [
        {
          field: 'category',
          verdict: 'wrong',
          said: 'car jump starters',
          quote: 'NordVolt makes car jump starters and ships only within the UK.',
        },
        {
          field: 'markets',
          verdict: 'wrong',
          said: 'UK only',
          quote: 'NordVolt makes car jump starters and ships only within the UK.',
        },
      ],
    }),
  },
  {
    id: 's4',
    prompt: 'Anker or NordVolt for a travel power bank?',
    platform: 'google_ai_overview',
    text: 'Anker and NordVolt both make reliable power banks; pick by price.',
    rivals: ['Anker'],
    reply: j({
      sentiment: 'neutral',
      quote: 'Anker and NordVolt both make reliable power banks; pick by price.',
      brands: [],
      compare: {
        verdict: 'tie',
        rival: 'Anker',
        quote: 'Anker and NordVolt both make reliable power banks; pick by price.',
      },
      claims: [],
    }),
  },
  {
    id: 's5',
    prompt: 'Best power bank for long flights?',
    platform: 'chatgpt',
    text: 'NordVolt Air charges a phone three times and costs $49, a fair price next to Anker.',
    rivals: ['Anker'],
    reply: j({
      sentiment: 'positive',
      quote: 'NordVolt Air charges a phone three times and costs $49, a fair price next to Anker.',
      brands: [],
      compare: {
        verdict: 'ours',
        rival: 'Anker',
        // 录的时候模型摘错了一句（回答里没有）：这一条比较不能算
        quote: 'NordVolt is clearly better than Anker.',
      },
      claims: [
        {
          field: 'price',
          verdict: 'correct',
          said: '$49',
          quote:
            'NordVolt Air charges a phone three times and costs $49, a fair price next to Anker.',
        },
      ],
    }),
  },
  {
    id: 's6',
    prompt: 'Cheapest reliable power bank?',
    platform: 'gemini',
    text: 'Anker and Belkin are the usual picks.',
    rivals: ['Anker', 'Belkin'],
    reply: j({ sentiment: null, quote: null, brands: [] }),
  },
]

/** 两张页面（去标签后的正文 + 结构化数据），和模型读评测站那页的回文。 */
export const GEO_SAMPLE_PAGES = [
  {
    url: 'https://nordvolt.example/products/air-10000',
    text: 'NordVolt Air 10000. Flight-safe 10000mAh power bank, 180 g. Was $39–$59, now on sale.',
    jsonld: [
      {
        '@type': 'Product',
        name: 'Air 10000',
        brand: { '@type': 'Brand', name: 'NordVolt' },
        offers: { '@type': 'Offer', price: '29.00', priceCurrency: 'USD' },
      },
    ],
    reply: j({ findings: [] }),
  },
  {
    url: 'https://travelgear.example/reviews/nordvolt-air',
    text: 'We tested the NordVolt Air for a month. It is sold only in the UK and the battery is 5000mAh.',
    jsonld: [],
    reply: j({
      findings: [
        {
          field: 'markets',
          verdict: 'wrong',
          said: 'sold only in the UK',
          quote: 'It is sold only in the UK and the battery is 5000mAh.',
        },
        {
          field: 'selling_points',
          verdict: 'wrong',
          said: '5000mAh battery',
          quote: 'It is sold only in the UK and the battery is 5000mAh.',
        },
        {
          field: 'price',
          verdict: 'wrong',
          said: 'made up',
          quote: 'This sentence is not on the page.',
        },
      ],
    }),
  },
] as const
