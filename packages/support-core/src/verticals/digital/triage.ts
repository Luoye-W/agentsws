/**
 * 虚拟产品与服务的邮件词表分流。
 *
 * 词面取自 `digital/intents.ts` 的聊天分类器表（同一批词在两个渠道上是同一个意思），
 * 顺序按同一条理由排：**钱和账号排在前面**——一句话同时像账单问题和使用方法时，
 * 判成账单的代价是多转一次人工，判成使用方法的代价是 AI 拿着知识库去回答一个它没有
 * 事实依据的扣费问题。
 *
 * 与 goods 的**根本差异是有没有那道门**。goods 先问"是不是客服诉求"（`SUPPORT_TERMS`）
 * 再细分；digital 没有这道门，因为它按**方向**判定：客户写来问"我为什么被扣了两次费"
 * 是标准客服工单，Stripe 发来的月度发票不是——同一个词、两个方向。
 *
 * 方向在词表这一层只能做到这个程度：把**第三方服务商的发件域**列成一条排在最前面的
 * 排除规则（来信人地址也在匹配文本里）。真正的判据是 `intents.triageScope` 那两行，
 * 它们进模型侧 prompt；词表层是模型不在时的兜底，宁可把供应商通知漏判成客服邮件
 * ——那封信最坏也只是停在人审队列里，而把客户的扣费问题判成"不是客服"会直接没人管。
 */

import { BUSINESS_TERMS, COMPLAINT_TERMS, MARKETING_TERMS, SPAM_TERMS } from '../../lexicon.js'
import type { VerticalTriagePack } from '../types.js'

/** 第三方服务商发给你们团队自己的通知（按**发件域**判，不按主题词判）。 */
const VENDOR_NOTICE_TERMS = [
  '@stripe.com',
  '@paypal.com',
  '@vercel.com',
  '@github.com',
  '@notifications.google.com',
  '@aws.amazon.com',
  'no-reply@',
  'noreply@',
  'billing@stripe',
] as const

const BILLING_TERMS = [
  'invoice',
  'charged',
  'charge me',
  'billing',
  'refund',
  'subscription',
  'renew',
  'cancel my plan',
  'cancel my subscription',
  'upgrade',
  'downgrade',
  'credits',
  'quota',
  'usage limit',
  'chargeback',
  '扣费',
  '发票',
  '账单',
  '退款',
  '订阅',
  '续费',
  '积分',
  '额度',
  '收费',
  '拒付',
] as const

const ACCOUNT_TERMS = [
  'log in',
  'login',
  'logged in',
  'sign in',
  'signin',
  'sign up',
  'password',
  'reset link',
  'reset my',
  '2fa',
  'two-factor',
  'two factor',
  'verification code',
  'locked out',
  'magic link',
  'hacked',
  'compromised',
  'unauthorized access',
  'unauthorised access',
  '登录',
  '登陆',
  '密码',
  '验证码',
  '账号',
  '帐号',
  '注册不了',
  '被盗',
  '盗号',
] as const

const DATA_PRIVACY_TERMS = [
  'gdpr',
  'ccpa',
  'delete my data',
  'delete my account',
  'delete all my',
  'erase my',
  'remove my data',
  'export my data',
  'download my data',
  'data retention',
  'privacy',
  'dpa',
  'where is my data',
  'data stored',
  '删除数据',
  '删除我的',
  '注销账号',
  '导出数据',
  '隐私',
  '数据存在哪',
  '数据保留',
] as const

const FEATURE_REQUEST_TERMS = [
  'feature request',
  'would be great',
  'would be nice',
  'can you add',
  'please add',
  'roadmap',
  'any plans to',
  'when will you support',
  'when will you add',
  'when will you ship',
  'when will you release',
  'when do you plan to',
  'release date',
  'eta for',
  'any eta',
  '路线图',
  '希望增加',
  '什么时候上线',
  '什么时候支持',
  '什么时候发布',
  '会不会做',
  '能加个',
] as const

const BUG_TERMS = [
  'error',
  'errors',
  'not working',
  "doesn't work",
  'does not work',
  'stopped working',
  'broken',
  'crash',
  'crashed',
  'crashing',
  'failed',
  'failing',
  'fails',
  'bug',
  'blank screen',
  'stuck on',
  'timed out',
  'timeout',
  'outage',
  'downtime',
  'is down',
  'was down',
  'unavailable',
  '报错',
  '打不开',
  '失败',
  '崩溃',
  '挂了',
  '卡住',
  '用不了',
  '没反应',
  '白屏',
  '宕机',
  '停机',
] as const

const INTEGRATION_TERMS = [
  'api',
  'api key',
  'webhook',
  'sdk',
  'integrate',
  'integration',
  'oauth',
  'sso',
  'saml',
  'zapier',
  'endpoint',
  'rate limit',
  'sandbox',
  '接入',
  '集成',
  '对接',
  '回调',
  '密钥',
] as const

const PRESALES_TERMS = [
  'pricing',
  'price',
  'how much',
  'plan',
  'plans',
  'trial',
  'free tier',
  'free plan',
  'does it support',
  'do you support',
  'compare',
  'seats',
  'enterprise',
  '价格',
  '多少钱',
  '套餐',
  '试用',
  '免费版',
  '支持吗',
  '能不能做',
  '对比',
] as const

const HOW_TO_TERMS = [
  'how do i',
  'how to',
  'how can i',
  'where can i',
  'where do i',
  'is there a way',
  'tutorial',
  'set up',
  'setup',
  '怎么',
  '如何',
  '在哪',
  '怎样',
  '教程',
  '设置',
] as const

export const DIGITAL_TRIAGE: VerticalTriagePack = {
  rules: [
    {
      intent: 'spam',
      is_customer_service: false,
      terms: SPAM_TERMS,
      confidence: 0.92,
      reason: '命中垃圾邮件词面，不进客服队列。',
    },
    {
      intent: 'platform_notification',
      is_customer_service: false,
      terms: VENDOR_NOTICE_TERMS,
      confidence: 0.9,
      reason: '发件方是第三方服务商，这是发给团队自己的通知，不是客户来信。',
    },
    {
      intent: 'complaint',
      is_customer_service: true,
      terms: COMPLAINT_TERMS,
      confidence: 0.95,
      reason: '邮件包含投诉、差评或争议信号，应由客服职责接管。',
    },
    {
      intent: 'billing',
      is_customer_service: true,
      terms: BILLING_TERMS,
      confidence: 0.9,
      reason: '客户在问账单、扣费、订阅或额度，只能引用已核实的账户事实，涉退款转人工。',
    },
    {
      intent: 'account_access',
      is_customer_service: true,
      terms: ACCOUNT_TERMS,
      confidence: 0.88,
      reason: '客户登录或账号出了问题，只能指路自助入口、不得代办账号操作。',
    },
    {
      intent: 'data_privacy',
      is_customer_service: true,
      terms: DATA_PRIVACY_TERMS,
      confidence: 0.9,
      reason: '客户在提数据或隐私请求，删除/导出有法定时限，一律转人工。',
    },
    {
      intent: 'feature_request',
      is_customer_service: true,
      terms: FEATURE_REQUEST_TERMS,
      confidence: 0.78,
      reason: '客户在提功能建议或问路线图，记录诉求但绝不承诺上线时间。',
    },
    {
      intent: 'bug_report',
      is_customer_service: true,
      terms: BUG_TERMS,
      confidence: 0.86,
      reason: '客户在报故障，先收集复现信息，不要断言原因或声称已修复。',
    },
    {
      intent: 'integration',
      is_customer_service: true,
      terms: INTEGRATION_TERMS,
      confidence: 0.82,
      reason: '客户在做接入或集成，按文档与已学知识给配置口径，不要编字段或限额。',
    },
    {
      intent: 'pre_sales',
      is_customer_service: true,
      terms: PRESALES_TERMS,
      confidence: 0.84,
      reason: '客户在付费前确认套餐、价格或能力，只能基于真实在售套餐与知识库作答。',
    },
    // `how to` 的词面极宽（"can i…"），所以排在最后一条客服规则：前面那些更具体的
    // 意图先取走"can i get a refund" / "can i change my email"这类。
    {
      intent: 'how_to',
      is_customer_service: true,
      terms: HOW_TO_TERMS,
      confidence: 0.8,
      reason: '客户在问使用方法，应引用文档与知识库里的步骤作答。',
    },
    {
      intent: 'marketing',
      is_customer_service: false,
      terms: MARKETING_TERMS,
      confidence: 0.89,
      reason: '邮件更像推广、SEO、广告或合作邀约，不进客服队列。',
    },
    {
      intent: 'business',
      is_customer_service: false,
      terms: BUSINESS_TERMS,
      confidence: 0.86,
      reason: '邮件更像商务合作或供应链沟通，不进客服队列。',
    },
  ],
  fallback: {
    intent: 'other',
    is_customer_service: false,
    confidence: 0.75,
    reason: '未发现明确的产品客服诉求，默认保持在原收件箱。',
  },
  takenOverIntent: 'post_sales',
  /**
   * 风险词只从冻结词集里取 digital 用得上的那四个（退款 / 拒付 / 法律 / 差评）。
   * `tracking` / `customs` / `damaged` 这些实物词一个都不用——没有包裹就没有丢件。
   */
  riskTerms: ['refund', 'chargeback', 'lawsuit', 'review'],
  /**
   * 缺什么资料。**"订单号"一个字都不许出现**：这个垂直的 AI 手上没有订单，
   * 账单与账号类该收的是**注册邮箱**；故障类收的是复现信息（在哪一步、什么提示、大致时间）。
   */
  needs: [
    {
      terms: [
        'log in',
        'login',
        'password',
        'sign in',
        'account',
        'invoice',
        'charged',
        'billing',
        'subscription',
        'refund',
        '登录',
        '密码',
        '账号',
        '帐号',
        '账单',
        '扣费',
        '订阅',
        '退款',
      ],
      need: 'registered_email',
    },
    {
      terms: [
        'error',
        'crash',
        'bug',
        'not working',
        'failed',
        '报错',
        '崩溃',
        '失败',
        '用不了',
        '打不开',
      ],
      need: 'repro_steps',
    },
  ],
  recordRefNeed: 'registered_email',
}
