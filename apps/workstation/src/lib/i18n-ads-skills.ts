/**
 * WP452（docs/109 §5.2 #12–16、§6.3）：投放第二批技能在界面上的那几句——实验「保留 / 停 / 再测」卡、
 * 品牌档案「卖的是什么」。中英各一份，在 `i18n.ts` 的 `TABLES` 那一行并进去。少字：怎么算的进问号。
 */
export const ADS_SKILLS_ZH: Record<string, string> = {
  'kind.ads_experiment_readout': '广告实验结果',
  'card.options.hint.ads_experiment_readout': '选了只把结论记进实验记忆，不改广告。',
  'adsx.arm': '版本',
  'adsx.rate': '比例',
  'adsx.lift': '对基准',
  'adsx.sure': '差得确定吗',
  'adsx.sure.yes': '确定',
  'adsx.sure.no': '还不确定',
  'adsx.base': '基准',
  'adsx.plan': '每版要 {per_arm}，护栏：{guards}',
  'adsx.plan.no_guard': '没设',
  'adsx.hint': '按设计时定的样本量、显著性和护栏判的；数是规则算的，不经 AI。',
  'onboarding.brand.offering': '卖的是',
  'onboarding.brand.offering.hint':
    '可不填。只有投放与 SEO 的建议读它：比如 Apple 搜索广告只推 App，没 App 就不建议开。',
  'onboarding.brand.offering.unknown': '没说',
  'onboarding.brand.offering.physical': '实物',
  'onboarding.brand.offering.app': 'App',
  'onboarding.brand.offering.digital': '别的数字产品',
  'skill.name.ads-experiment': '广告实验',
  'skill.name.ads-attribution': '归因对照',
}

export const ADS_SKILLS_EN: Record<string, string> = {
  'kind.ads_experiment_readout': 'Ad experiment result',
  'card.options.hint.ads_experiment_readout':
    'Your pick is recorded in the experiment log. No ad is changed.',
  'adsx.arm': 'Version',
  'adsx.rate': 'Rate',
  'adsx.lift': 'vs base',
  'adsx.sure': 'Confident?',
  'adsx.sure.yes': 'Yes',
  'adsx.sure.no': 'Not yet',
  'adsx.base': 'Base',
  'adsx.plan': '{per_arm} per version; guardrails: {guards}',
  'adsx.plan.no_guard': 'none',
  'adsx.hint':
    'Judged by the sample size, significance and guardrails set at design time. Rule-based, not AI.',
  'onboarding.brand.offering': 'You sell',
  'onboarding.brand.offering.hint':
    'Optional. Only ad and SEO suggestions read it: e.g. Apple Search Ads only promote apps.',
  'onboarding.brand.offering.unknown': 'Not set',
  'onboarding.brand.offering.physical': 'Physical goods',
  'onboarding.brand.offering.app': 'An app',
  'onboarding.brand.offering.digital': 'Other digital products',
  'skill.name.ads-experiment': 'Ad experiments',
  'skill.name.ads-attribution': 'Attribution side by side',
}
