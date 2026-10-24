/**
 * WP117（66 断点 #1）：**红人的能力作为工具接进 Agent 运行时**。
 *
 * 之前这个包里的十一个模块只有服务端的路由在调，三个运行时（stub / direct / dsh）
 * 一个都看不见——所以「让红人岗位找 20 个频道」回的是客服的话：工具面里没有一个
 * 与红人有关的名字，模型只能拿它有的那几个（`get_order` / `search_policies`）凑。
 *
 * 这个文件只干一件事：**说清有哪些工具、各自吃什么**。纯定义，没有 IO——
 * 真正干活的执行器在服务进程那一侧（`apps/server/src/kol-tools.ts`），
 * 它把这些名字接到 `KolPort` 上。运行时只认名字与 schema。
 *
 * 命名沿用仓里的惯例（47 J3 的三组）：
 *
 * | 组 | 工具 |
 * |---|---|
 * | 查对象 | `search_creators` `get_creator` `list_collaborations` `list_deliverables` `list_tracked_links` |
 * | 查知识 | （沿用 `search_policies`，不新增） |
 * | 提议动作 | `score_creator` `add_to_campaign` `draft_outreach` `advance_collaboration` `register_deliverable` `review_deliverable` `create_tracked_link` |
 *
 * `score_creator` 归「提议动作」是因为 47 J3 的兜底一律最严；它其实只读，
 * 但登记表里没有它对应的 Action，判不出来就排最后——排后面不影响它能被调到。
 */
import type { KolChannel } from '@agentsws/contracts'

/** 一个工具的名字 + 一句人话 + 入参。 */
export interface KolToolSpec {
  name: string
  /** 给模型看的一句话：说清「什么时候用它」，不是说清它怎么实现。 */
  description: string
  input_schema: unknown
}

const str = (description: string): { type: 'string'; description: string } => ({
  type: 'string',
  description,
})

const CHANNEL_ENUM = {
  type: 'string',
  enum: ['youtube', 'instagram', 'tiktok', 'facebook', 'x'] satisfies KolChannel[],
  description: '渠道：youtube / instagram / tiktok / facebook / x',
}

/**
 * 十二个工具（WP295 加了读归因的 `list_tracked_links`）。顺序就是一件事的顺序（找人 → 打分 → 进池 → 建联 → 推进 → 交付 → 归因），
 * 真正进 prompt 的顺序由 `@agentsws/ontology` 的 `orderTools` 重排。
 */
export const KOL_TOOL_SPECS: readonly KolToolSpec[] = [
  {
    name: 'search_creators',
    description:
      '在一条渠道上找红人，可以按关键词、也可以只按粉丝区间。没连这条渠道的官方接口时自动退到你自己的红人库 / 公共红人库；几条路回的是同一个形状。给了 tag（人工标签）或 review（人工审核决定）就只在你自己的红人池里筛，每行带 tags / review。要找人、找频道、找账号、拉一批候选时用它。**没有合适的关键词就别编一个**（「YouTube」「频道」这类词说的是渠道，不是要找什么样的人）——留空表示"这条渠道上的人都算候选"。',
    input_schema: {
      type: 'object',
      properties: {
        channel: CHANNEL_ENUM,
        q: str('关键词：品类、产品词或人群词。没有就不填'),
        limit: { type: 'number', description: '最多要几个，默认 20' },
        // WP117b（66 复测 #15）：粉丝区间以前只出现在回话里，从没进过入参
        min_followers: { type: 'number', description: '粉丝数下限（含）' },
        max_followers: { type: 'number', description: '粉丝数上限（含）' },
        // WP502（决策 1763 B）：按人工标签 / 审核决定筛自己的红人池（给了就只查本机库）
        tag: str('只看打了这个人工标签的人（只查你自己的红人池）'),
        review: {
          type: 'string',
          enum: ['approved', 'rejected', 'pending'],
          description:
            '只看这个人工审核决定的人：approved 已通过 / rejected 已淘汰 / pending 还没定（只查你自己的红人池）',
        },
      },
    },
  },
  {
    name: 'save_creator',
    description:
      '把找人结果里的一个人收进红人库（不花钱、不出卡；同渠道同账号已在库里就回那一个）。收进来之后才能对他打分、起草开发信。联系方式要另外取（公共库取邮箱要花积分，先报价）。',
    input_schema: {
      type: 'object',
      properties: {
        channel: CHANNEL_ENUM,
        handle: str('账号名（找人结果里的 handle）'),
        display_name: str('名字'),
        url: str('主页链接'),
        followers: { type: 'number', description: '粉丝数（找人结果里有就带上）' },
        category: str('做什么内容'),
        language: str('语言'),
        region: str('地区'),
      },
      required: ['handle'],
    },
  },
  {
    /*
     * WP496（决策 1738 / 1739 A）：ego 路采集红人与插件**同一套**——打开页面后由插件那套采集器读数（AI 不填数），
     * 走插件同一个入口记下（本机红人库 + 公开联系方式 + 登录了云账号就备份上云）。读不出来才用下面那个手记。
     */
    name: 'capture_creator_pages',
    description:
      '在浏览器（ego）里打开红人主页 / 视频或帖子页 / 搜索或话题列表页 / Linktree，用和浏览器插件**同一套采集规则**读出数据并记下来（存进本机红人库，和插件采集的一样备份到工坊云端）。读到的有：粉丝 / 订阅、作品数、平均播放、总播放、国家、加入时间、简介、外链与公开联系方式、近期作品、更新规律，以及体检（播放 / 粉丝比、疑似刷粉）、受众真实性信号、频道估值区间；**读到的每个红人主页都会存入红人池**（和插件「存入红人池」同一个入口，国家、加入时间、总播放、近期作品也存；回执里 summary 说存了几个、新增几个）。列表页读出页面上的每个候选人、全记下来；视频页右栏每行带插件预筛的相关度分（relevance_score，按分排好，plugin_would_skip 标的是插件会筛掉的），挑人先看前面的。**记红人数据优先用它**——你只负责挑要看哪几页，数字由采集规则读。一次最多 10 页，每页十几秒。YouTube / TikTok / Instagram / Linktree 之外的页面或读不出来时，再用 record_creator_observations 手记。',
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          description: '要读的页面地址（https://），一次最多 10 个',
          items: { type: 'string' },
        },
        record: {
          type: 'boolean',
          description: '读完记不记下来，默认记（只想先看看就填 false）',
        },
      },
      required: ['urls'],
    },
  },
  {
    /*
     * WP483（决策 1661）：在浏览器（ego）里读到的红人**公开**主页数据，和浏览器插件采集的走同一条路：
     * 存进本机红人库，同时备份到工坊云端（公共红人库的那一份；只上粉丝数等几格）。私信、账号凭据不在这里。
     * WP487（1661 补）：加上主页上**公开写着的**联系方式（`public_contacts`），和插件那条路同一个形状。
     */
    name: 'record_creator_observations',
    description:
      '**兜底用**：先用 capture_creator_pages（插件同一套采集规则读数）；它读不出来（不是那几家平台、页面读不全）时，才用这个把你在浏览器里（ego）亲眼读到的红人公开主页数据手记下来：存进本机红人库，同时和浏览器插件采集的一样备份到工坊云端。一次最多 50 个。只记公开主页上看得到的（账号、名字、粉丝数、作品数、简介，以及主页 / 简介 / 「关于」里公开写着的联系方式：邮箱、网站、其它平台主页、商务合作入口、经纪联系）。不记私信内容、不记任何账号密码、不记你自己账号上的东西（页面顶上登录着的那个号的邮箱、设置页、收件箱都不算）。数字以页面上看到的为准，看不清就不填。',
    input_schema: {
      type: 'object',
      properties: {
        channel: CHANNEL_ENUM,
        observations: {
          type: 'array',
          description: '每个红人一行',
          items: {
            type: 'object',
            properties: {
              handle: str('账号名（不带 @ 也行）'),
              display_name: str('名字'),
              url: str('主页链接'),
              followers: {
                type: 'number',
                description: '粉丝 / 订阅数（页面上的数字，换算成整数）',
              },
              video_count: { type: 'number', description: '作品 / 视频数' },
              avg_views: { type: 'number', description: '最近作品的平均播放（页面上算得出才填）' },
              country: str('国家 / 地区（主页上写了才填）'),
              bio: str('简介原文'),
              public_contacts: {
                type: 'array',
                description:
                  '主页上公开写着的联系方式（没写就不填，不要猜、不要从私信里抄）。最多 10 条',
                items: {
                  type: 'object',
                  properties: {
                    kind: {
                      type: 'string',
                      enum: ['email', 'website', 'social', 'business', 'agent'],
                      description:
                        'email 公开邮箱 / website 网站或 link-in-bio 页 / social 别的平台主页 / business 商务合作入口（邮箱或表单链接）/ agent 经纪或代理公司联系',
                    },
                    value: str('邮箱，或 https:// 开头的链接（原样抄页面上的）'),
                    label: str('页面上写在旁边的那几个字（如 Business inquiries），没有就不填'),
                  },
                  required: ['kind', 'value'],
                },
              },
            },
            required: ['handle'],
          },
        },
      },
      required: ['observations'],
    },
  },
  {
    name: 'get_creator',
    description:
      '按 id 取一个红人的全部明细：账号、粉丝与互动、打分、联系方式（脱敏）、合作历史；存入过红人池的账号还带主页资料（profiles：国家、加入时间、总播放、平均播放、作品数、简介、头像、横幅、近期作品，saved_at 是那一刻）；算得出来的账号带估算（checks：体检的播放 / 粉丝比、点赞率中位数、单条合作参考价区间（美分）、更新规律、粉丝 30 天变化——都是公开页面上的数推出来的，不是平台官方数据）；自动评分做过云端体检的带 audit；人打过的标签带 tags，人工审核决定带 review（decision：approved 通过 / rejected 淘汰，reason 是理由；没有 review = 还没审）。近期作品带 url 的是原作品链接。',
    input_schema: {
      type: 'object',
      properties: { creator_id: str('红人 id') },
      required: ['creator_id'],
    },
  },
  {
    name: 'list_collaborations',
    description:
      '列出合作，可按渠道与阶段过滤；每行带红人名字与几天没动静。回答「合作到哪一步了」「谁还没回」「谁该交稿」时用它。',
    input_schema: {
      type: 'object',
      properties: {
        channel: CHANNEL_ENUM,
        stage: str(
          '只要某一个阶段的：sourced / contacted / replied / negotiating / agreed / sample_sent（已寄样）/ delivering / delivered / closed / declined',
        ),
        // WP295：「谁还没回」一次读出来（每行带 display_name 与 days_since_activity）
        quiet_days: {
          type: 'number',
          description: '只要「已建联、这么多天没动静」的那几条（问「谁还没回」时填 7）',
        },
      },
    },
  },
  {
    name: 'list_deliverables',
    description: '列出交付物，可按合作过滤，也可只要待审的。要审稿、要看谁交了什么时用它。',
    input_schema: {
      type: 'object',
      properties: {
        collaboration_id: str('只看这一条合作的'),
        pending: { type: 'boolean', description: 'true = 只要待审的' },
      },
    },
  },
  {
    /*
     * WP295：「哪几个真带货了」以前没有工具能答——十一个工具里没有一个读得到追踪链接的
     * 点击 / 订单 / 收入，岗位页那句快捷提示回的是「看合作清单：2 条」。只读，不动钱。
     */
    name: 'list_tracked_links',
    description:
      '列出这条渠道上的追踪链接带来的点击、订单、收入（每行带红人名字，按收入从高到低），外加还没建追踪链接的合作。回答「哪几个真带货了」「这次合作值不值」时用它。归不上的订单不在这里——数只会偏小，不是猜的。',
    input_schema: {
      type: 'object',
      properties: {
        channel: CHANNEL_ENUM,
        collaboration_id: str('只看这一条合作的'),
      },
    },
  },
  {
    name: 'score_creator',
    description:
      '给一个红人体检打分：粉丝量、互动率、品类匹配、地区、活跃度五项各自可解释，并标出疑似刷粉。要判断「值不值得谈」时用它。',
    input_schema: {
      type: 'object',
      properties: { creator_id: str('红人 id') },
      required: ['creator_id'],
    },
  },
  {
    name: 'add_to_campaign',
    description:
      '把一批红人收进候选池并挂到一个活动上（还没建联，只是进池）。给出的是一份清单卡，人点了才真建合作。',
    input_schema: {
      type: 'object',
      properties: {
        creator_ids: { type: 'array', items: { type: 'string' }, description: '红人 id 列表' },
        campaign: str('活动名；不给就用这次事项的标题'),
        product: str('要推的产品'),
      },
      required: ['creator_ids'],
    },
  },
  {
    name: 'draft_outreach',
    description:
      '给一个红人起草开发信（首封 / 3 天跟进 / 7 天收尾三档）。**起草不等于发出**：回来的是一张待人批的卡；正文里出现具体报价、佣金、独家这类承诺会被当场打回。',
    input_schema: {
      type: 'object',
      properties: {
        creator_id: str('红人 id'),
        channel: CHANNEL_ENUM,
        step: {
          type: 'string',
          enum: ['first', 'follow_up', 'final'],
          description: '第几封，默认 first',
        },
        product: str('要推的产品（不给就用存过的默认产品）'),
        reason: str('为什么找这个人（一句话，会进正文）'),
        brand_pitch: str(
          '一句话介绍我们是做什么的（会进正文）。不给就从品牌档案取；品牌档案里也没有时，按你知道的品牌情况写一句，卡上会标出来让人确认',
        ),
      },
      required: ['creator_id'],
    },
  },
  {
    name: 'advance_collaboration',
    description:
      '把一条合作推到下一个阶段（找到人 → 已建联 → 有回音 → 谈条件 → 谈成 →（已寄样 →）交付中 → 已交付 → 结案；也能推到「谢绝了」）。阶段机不许跳步，跳了会被拒并说清为什么。',
    input_schema: {
      type: 'object',
      properties: {
        collaboration_id: str('合作 id'),
        stage: str('要推到哪个阶段'),
        note: str('一句话理由，进时间线'),
      },
      required: ['collaboration_id', 'stage'],
    },
  },
  {
    name: 'register_deliverable',
    description: '登记一条交付物（视频 / 帖子 / 短视频 / 直播）：挂到哪条合作、什么时候交、链接。',
    input_schema: {
      type: 'object',
      properties: {
        collaboration_id: str('合作 id'),
        kind: {
          type: 'string',
          enum: ['video', 'post', 'story', 'reel', 'thread', 'live'],
          description: '交付物形态',
        },
        due_at: str('交稿时间（ISO 8601）'),
        url: str('已经有链接的话填上'),
      },
      required: ['collaboration_id'],
    },
  },
  {
    name: 'review_deliverable',
    description:
      '验收一条交付物：通过 / 要改 / 不合格。要改与不合格必须写清楚改什么。结果是一张待人批的卡。',
    input_schema: {
      type: 'object',
      properties: {
        deliverable_id: str('交付物 id'),
        review: {
          type: 'string',
          enum: ['approved', 'changes_requested', 'rejected'],
          description: '结论',
        },
        notes: str('逐条写清广告标识、禁用词、链接与折扣码哪里不对'),
      },
      required: ['deliverable_id', 'review'],
    },
  },
  {
    name: 'create_tracked_link',
    description:
      '给一条合作建一条带 UTM 的追踪链接（可选联盟折扣码）。归因全靠它——合作谈成之后、寄样之前就该建好。',
    input_schema: {
      type: 'object',
      properties: {
        collaboration_id: str('合作 id'),
        target_url: str('落地页地址（必填：不知道就先问人，不要编一个）'),
        campaign: str('UTM 的 campaign'),
        discount_code: str('联盟折扣码，不给就不带码'),
      },
      required: ['collaboration_id'],
    },
  },
  {
    name: 'import_creator_sheet',
    description:
      'WP489：用户贴了一条在线表格链接（飞书 / Google 表格 / 其它）说要导入红人：用工坊自己已登录的浏览器读那张表，出一张「导入红人表」预览卡（新增几个、合并几个、带几条合作），人点了才导。读不了会回一句该怎么办（登录一下 / 下载成 Excel 拖进来），照原话转告。拖进来的文件不用调它（已自动出卡）。',
    input_schema: {
      type: 'object',
      properties: { url: str('表格链接（用户贴的原样）') },
      required: ['url'],
    },
  },
  {
    name: 'update_stages_from_mail',
    description:
      'WP489：用户说「用邮件更新一下红人状态」这类话：读过往邮件里与红人有关的往来，先估人数与花费、出一张卡，人点了才判；判出的每一步都带依据邮件，和表格写的不一样会再出卡让人选。',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'number', description: '回看几个月，默认 12（用户说了才改）' },
      },
    },
  },
]

/** 全部红人工具的名字（已排序，进 `tools.allow` 的那一份）。 */
export const KOL_TOOL_NAMES: readonly string[] = KOL_TOOL_SPECS.map((s) => s.name)
  .slice()
  .sort()

/** 名字 → spec。 */
export function kolToolSpec(name: string): KolToolSpec | undefined {
  const bare = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
  return KOL_TOOL_SPECS.find((s) => s.name === bare)
}

/**
 * 这条职责是红人的哪一条渠道。
 *
 * 判据只有 `role_id` 的前缀（`kol.youtube` → `youtube`）——不查登记表、不读 YAML，
 * 所以回放时算得出同一个答案（17 §6.2 字节稳定）。
 */
export function kolChannelOfRole(role_id: string): KolChannel | undefined {
  if (!role_id.startsWith('kol.')) return undefined
  const tail = role_id.slice('kol.'.length)
  return (['youtube', 'instagram', 'tiktok', 'facebook', 'x'] as const).find((c) => c === tail)
}

/** 这条职责是不是红人营销里的一条。 */
export function isKolRole(role_id: string): boolean {
  return kolChannelOfRole(role_id) !== undefined
}
