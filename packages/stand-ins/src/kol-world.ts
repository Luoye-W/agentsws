/**
 * WP117 交付 3：**虚拟红人世界**。
 *
 * 一批合成红人，各有性格；给他们发开发信，他们按性格回信。用途有两处：
 *
 * 1. **模拟回路**：红人那条长场景需要对面真的会回信，不然「回信归并 → 意向分类 →
 *    议价」这几步在接口级永远测不到（66 断点 #11 就是这么来的）；
 * 2. **演练模式**（交付 4）：内测用户在界面上点「演练」，跟的就是这批人。
 *
 * 三条纪律：
 *
 * - **邮件全在内存里**。这个文件里没有 `net`、没有 `fetch`、没有 SMTP / IMAP 客户端。
 *   演练模式那一侧另有一道硬闸（真发送路径在演练活动里被拦），这里是第一道：
 *   连不上真邮箱的代码，拦都不用拦。
 * - **回信由规则 + 种子决定**。同 seed 同一封信 → 逐字相同的回复，回放才是恒等变换。
 *   润色（走模型便宜档）是可选的一层，默认关；开了也只改措辞，不改「回不回、回什么意向」。
 * - **地址一律 `@example.com` 那一族**。合成世界里不许出现一个可能真存在的邮箱。
 */
import type { Iso8601, KolChannel } from '@agentsws/contracts'

/**
 * 六种性格。选这六种不是凑数——它们对应建联漏斗上真正会分叉的六个地方：
 *
 * | 性格 | 在链上造成什么 |
 * |---|---|
 * | `eager` | 秒回、直接答应 → 最短的一条成功路径 |
 * | `slow` | 拖几天才回 → 跟进节奏（3 / 7 天）会先发出去，回信要能并到同一条线程 |
 * | `haggler` | 只谈钱 → 议价卡（money 排版），超预算要人批 |
 * | `sampler` | 先要样品 → 要地址、建寄样任务 |
 * | `bouncer` | 退信 → 地址无效，合作该停在那儿并把人标出来 |
 * | `ghost` | 已读不回 → 跟进上限用满之后不再发（不许无限骚扰） |
 */
export type KolPersona = 'eager' | 'slow' | 'haggler' | 'sampler' | 'bouncer' | 'ghost'

export interface SyntheticCreator {
  id: string
  display_name: string
  channel: KolChannel
  handle: string
  email: string
  followers: number
  engagement_rate: number
  category: string
  language: string
  region: string
  persona: KolPersona
  /** 这个人收到第一封信之后**几小时**回（`ghost` / `bouncer` 没有这一格）。 */
  reply_after_hours?: number
  /** `haggler` 要的价（美元）。 */
  asking_price?: number
}

/** 性格 → 回信延迟（小时）与要价。`undefined` = 不回。 */
const BEHAVIOR: Readonly<
  Record<KolPersona, { hours?: number; price?: number; opt_out?: boolean }>
> = {
  eager: { hours: 2 },
  slow: { hours: 96 },
  haggler: { hours: 8, price: 900 },
  sampler: { hours: 20 },
  bouncer: {},
  ghost: {},
}

const CHANNELS: readonly KolChannel[] = ['youtube', 'instagram', 'tiktok', 'facebook', 'x']

const CATEGORIES = ['数码', '桌面好物', '户外', '家居', '健身', '摄影'] as const
const REGIONS = ['US', 'GB', 'DE', 'CA', 'AU', 'SG'] as const

/** 六种性格按这个比例铺开：多数人是不回的，这才像真的建联漏斗。 */
const MIX: readonly KolPersona[] = [
  'ghost',
  'ghost',
  'slow',
  'eager',
  'haggler',
  'sampler',
  'ghost',
  'bouncer',
]

/** 名字池（合成的，不对应任何真人）。 */
const FIRST = [
  'Gadget',
  'Desk',
  'Trail',
  'Studio',
  'Urban',
  'Quiet',
  'Bright',
  'Copper',
  'Nomad',
  'Orbit',
] as const
const LAST = [
  'Jonas',
  'Rosa',
  'Miko',
  'Alva',
  'Pike',
  'Noor',
  'Reed',
  'Vale',
  'Suri',
  'Kaya',
] as const

/**
 * 造一批合成红人。
 *
 * 同 `count` 同 `seed` → 逐字相同的一批人（26 §3）。id 形如 `syn_kol_001`，
 * 一眼看得出是合成的——真库里的人不会长这样。
 */
export function syntheticCreators(input: { count?: number; seed?: number } = {}): SyntheticCreator[] {
  const count = input.count ?? 48
  const seed = input.seed ?? 42
  const out: SyntheticCreator[] = []
  for (let i = 0; i < count; i += 1) {
    const n = i + seed
    const first = FIRST[i % FIRST.length] ?? 'Gadget'
    const last = LAST[(i * 3 + seed) % LAST.length] ?? 'Jonas'
    const persona = MIX[i % MIX.length] ?? 'ghost'
    const behavior = BEHAVIOR[persona]
    const handle = `${first}${last}`.toLowerCase()
    out.push({
      id: `syn_kol_${String(i + 1).padStart(3, '0')}`,
      display_name: `${first} ${last}`,
      channel: CHANNELS[(i + seed) % CHANNELS.length] ?? 'youtube',
      handle,
      // 合成世界里的地址只有这一族；`bouncer` 用一个明摆着投不出去的域
      email: persona === 'bouncer' ? `${handle}@invalid.example` : `${handle}@example.com`,
      followers: 8_000 + ((n * 7_919) % 420_000),
      engagement_rate: Math.round((0.01 + ((n * 37) % 90) / 1000) * 1000) / 1000,
      category: CATEGORIES[(i + seed) % CATEGORIES.length] ?? '数码',
      language: 'en',
      region: REGIONS[(i * 5 + seed) % REGIONS.length] ?? 'US',
      persona,
      ...(behavior.hours === undefined ? {} : { reply_after_hours: behavior.hours }),
      ...(behavior.price === undefined ? {} : { asking_price: behavior.price }),
    })
  }
  return out
}
