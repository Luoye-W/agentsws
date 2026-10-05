/**
 * 价格页文案。**单价一个都不写在这里**：价目与充值档位构建时从云上公开接口取（`lib/pricing.ts`）。
 * 这里只写已经公开在教程里的口径：1 积分 = ¥1、1 美元 = 7 积分、注册送 10 积分、充值永不过期。
 */
import type { Lang } from './common.js'

const zh = {
  meta: {
    title: '价格 · Agents 工坊',
    description: '开源版全功能免费；用积分按用量扣，1 积分 = ¥1，充值的积分永不过期。',
  },
  eyebrow: '价格',
  title: ['开源版免费。', '用积分，按用量。'],
  sub: '没有席位费，没有年约。用你自己 key 的那部分，一分不扣。',
  open: {
    tag: '开源版',
    price: '¥0',
    unit: '永久',
    line: '装在你电脑上，全部功能。',
    items: [
      '全部岗位、全部功能',
      '自带模型 key，直连各家',
      '多店铺、多品牌、审批、知识库',
      '源码公开，Apache-2.0',
    ],
    cta: '免费下载',
  },
  paid: {
    tag: 'Agents 工坊（用积分）',
    price: '1 积分 = ¥1',
    unit: '按用量',
    line: '不想自己去各家开账号，就用我们的。',
    items: [
      '不填 key，关联一次账号就能用',
      '注册送 10 积分',
      '充值的积分永不过期',
      '每项能力随时切回自己的 key',
    ],
    bonusHint: '点开登录信那一刻到账，90 天内有效；扣的时候先扣快到期的。',
    cta: '充值',
  },
  topup: {
    eyebrow: '充值',
    title: '选一档，充一次。',
    sub: '1 美元 = {rate} 积分。按美元结算，价钱不随汇率天天变。',
    credits: '积分',
    cta: '去充值',
    safe: '付款在收银台页面完成，我们碰不到你的卡号。',
    safeHint:
      '点「去充值」先登录 Agents 工坊账号（邮箱收一封登录信），再跳到收银台；付完回来余额自己刷新。',
    none: '充值档位暂时拿不到，登录后在账号页看。',
  },
  blocks: {
    eyebrow: '钱花在哪',
    title: '三块，花法各不一样。',
    data: { h: '数据接口', p: '红人查询、社媒抓取、网页、转写', unit: '按次 · 按页 · 按分钟' },
    ai: { h: 'AI 使用', p: '对话、写稿、生图', unit: '按 token · 生图按张' },
    service: { h: '增值服务', p: '红人库云端同步、客服云端值守', unit: '按月' },
  },
  table: {
    title: '价目表',
    cloud: '云上实时',
    sample: '样例',
    head: ['能力', '单位', '积分'],
    note: '执行前先显示价格；出不来不扣。',
    asOf: '取自云上公开价目 · {date}',
    sampleNote: '这是仓库里的一份样例价目（构建时没连上云），以控制台为准。',
    models: '各模型单价（积分 / 千 token）',
    model: '模型',
    input: '输入',
    output: '输出',
    region: '境内',
  },
  faq: {
    title: '关于积分',
    items: [
      ['用我自己的 key，也扣积分吗？', '不扣。那几条根本不经过我们，本地直连。'],
      ['积分会过期吗？', '充值的永不过期。送的 90 天内有效；扣的时候先扣快到期的。'],
      ['余额不够了会怎样？', '只拒这一次，不冻结。充上就能接着用，卡片上会提前提醒。'],
      [
        '增值服务欠费，数据会删吗？',
        '不删。同步先暂停，云上和本地的数据一条不动，充上值自己接上。',
      ],
      ['团队怎么付？', '一个公司一份余额，负责人来付；可以给每位成员、每个岗位设每月上限。'],
      [
        '能退款吗？',
        '不退。积分买了就不退、不折现；重复扣款、系统多扣这类错误，查实后退回。细则见退款政策。',
      ],
    ],
  },
  final: {
    title: '先用开源版，想省事了再充值。',
    download: '免费下载',
    login: '登录看余额',
  },
}

export type PricingCopy = typeof zh

const en: PricingCopy = {
  meta: {
    title: 'Pricing · Agents Workshop',
    description:
      'The open-source edition is complete and free. Credits are pay-as-you-go: 1 credit = ¥1, and purchased credits never expire.',
  },
  eyebrow: 'Pricing',
  title: ['Open source is free.', 'Credits are pay as you go.'],
  sub: 'No seats, no annual contract. Anything that runs on your own key costs nothing.',
  open: {
    tag: 'Open source',
    price: '¥0',
    unit: 'forever',
    line: 'Installed on your computer, every feature.',
    items: [
      'Every role, every feature',
      'Bring your own model key, direct to each provider',
      'Multiple stores and brands, approvals, knowledge base',
      'Source code public, Apache-2.0',
    ],
    cta: 'Download free',
  },
  paid: {
    tag: 'Agents Workshop credits',
    price: '1 credit = ¥1',
    unit: 'pay as you go',
    line: 'Don’t want to open accounts everywhere? Use ours.',
    items: [
      'No keys — link your account once',
      '10 free credits when you sign up',
      'Purchased credits never expire',
      'Switch any capability back to your own key anytime',
    ],
    bonusHint:
      'Credited the moment you open the sign-in email; valid for 90 days. Credits closest to expiry are used first.',
    cta: 'Top up',
  },
  topup: {
    eyebrow: 'Top up',
    title: 'Pick a pack. Pay once.',
    sub: '1 US dollar = {rate} credits. Priced in USD, so the price doesn’t drift with exchange rates.',
    credits: 'credits',
    cta: 'Top up',
    safe: 'Payment happens on the checkout page. We never see your card number.',
    safeHint:
      'Clicking "Top up" signs you in to your Agents Workshop account (we email you a link), then opens checkout. Your balance refreshes when you come back.',
    none: 'Packs are unavailable right now — sign in to see them on your account page.',
  },
  blocks: {
    eyebrow: 'Where credits go',
    title: 'Three kinds of spend.',
    data: {
      h: 'Data APIs',
      p: 'Creator lookups, social data, web pages, transcripts',
      unit: 'Per call · per page · per minute',
    },
    ai: { h: 'AI usage', p: 'Chat, drafting, images', unit: 'Per token · images per piece' },
    service: {
      h: 'Add-on services',
      p: 'Cloud sync for your creator list, cloud support standby',
      unit: 'Monthly',
    },
  },
  table: {
    title: 'Price list',
    cloud: 'Live from the cloud',
    sample: 'Sample',
    head: ['Capability', 'Unit', 'Credits'],
    note: 'You see the price before anything runs. Failed runs are free.',
    asOf: 'From the public price list · {date}',
    sampleNote:
      'This is a sample price list from the repository (the build couldn’t reach the cloud). Your console shows the real prices.',
    models: 'Per-model prices (credits / 1k tokens)',
    model: 'Model',
    input: 'Input',
    output: 'Output',
    region: 'China region',
  },
  faq: {
    title: 'About credits',
    items: [
      [
        'Do I pay credits when I use my own key?',
        'No. Those calls never go through us — they run direct from your computer.',
      ],
      [
        'Do credits expire?',
        'Purchased credits never expire. Free credits last 90 days, and the ones closest to expiry are used first.',
      ],
      [
        'What happens when I run out?',
        'Only that one request is declined — nothing is frozen. Top up and carry on; cards warn you in advance.',
      ],
      [
        'If an add-on lapses, is my data deleted?',
        'No. Sync pauses; nothing in the cloud or on your computer is touched. It resumes when you top up.',
      ],
      [
        'How do teams pay?',
        'One balance per company, paid by the lead. You can set monthly limits for each member and role.',
      ],
      [
        'Can I get a refund?',
        'No. Credits aren’t refundable or cashable once bought. Duplicate charges and system overcharges are put right once confirmed. See the Refund Policy.',
      ],
    ],
  },
  final: {
    title: 'Start with open source. Top up when you want it easy.',
    download: 'Download free',
    login: 'Sign in to see your balance',
  },
}

export const PRICING: Record<Lang, PricingCopy> = { zh, en }
