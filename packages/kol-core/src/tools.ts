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
      '在一条渠道上找红人，可以按关键词、也可以只按粉丝区间。没连这条渠道的官方接口时自动退到你自己的红人库 / 公共红人库；几条路回的是同一个形状。要找人、找频道、找账号、拉一批候选时用它。**没有合适的关键词就别编一个**（「YouTube」「频道」这类词说的是渠道，不是要找什么样的人）——留空表示"这条渠道上的人都算候选"。',
    input_schema: {
      type: 'object',
      properties: {
        channel: CHANNEL_ENUM,
        q: str('关键词：品类、产品词或人群词。没有就不填'),
        limit: { type: 'number', description: '最多要几个，默认 20' },
        // WP117b（66 复测 #15）：粉丝区间以前只出现在回话里，从没进过入参
        min_followers: { type: 'number', description: '粉丝数下限（含）' },
        max_followers: { type: 'number', description: '粉丝数上限（含）' },
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
     * WP483（决策 1661）：在浏览器（ego）里读到的红人**公开**主页数据，和浏览器插件采集的走同一条路：
     * 存进本机红人库，同时备份到工坊云端（公共红人库的那一份；只上粉丝数等几格）。私信、账号凭据不在这里。
     */
    name: 'record_creator_observations',
    description:
      '把你在浏览器里（ego）亲眼读到的红人公开主页数据记下来：存进本机红人库，同时和浏览器插件采集的一样备份到工坊云端。一次最多 50 个。只记公开主页上看得到的（账号、名字、粉丝数、作品数、简介），不记私信、不记任何账号密码；联系方式不在这里收（要邮箱走取联系方式那一步）。数字以页面上看到的为准，看不清就不填。',
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
    description: '按 id 取一个红人的全部明细：账号、粉丝与互动、打分、联系方式（脱敏）、合作历史。',
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
