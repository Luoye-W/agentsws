/**
 * 文档区、更新日志、条款三页、404 的页面文案（正文在 markdown 里）。
 */
import type { Lang } from './common.js'

const zh = {
  docs: {
    meta: {
      title: '教程 · Agents 工坊',
      description:
        '接模型、连店铺与邮箱、装浏览器插件、开聊天窗……Agents 工坊的每一步，都有一篇白话教程。',
    },
    eyebrow: '教程',
    title: '每一步，都有一篇白话教程。',
    sub: '和工作台右栏「教程」是同一份文章。',
    groups: {
      start: '先看这篇',
      models: '接上 AI',
      tools: '浏览器、电脑操控与数据',
      connect: '连接店铺、邮箱与平台',
      channels: '消息渠道与聊天窗',
    },
    toc: '本页目录',
    all: '全部教程',
    edit: '在 GitHub 上改这一篇',
    prev: '上一篇',
    next: '下一篇',
  },
  changelog: {
    meta: {
      title: '更新日志 · Agents 工坊',
      description: 'Agents 工坊每一次对外能说的更新，写成人话。',
    },
    eyebrow: '更新日志',
    title: '每一步，都摊开给你看。',
    sub: '需求来自社群，进度写在仓库里。这里挑对你有用的，写成人话。',
    repo: '完整的开发记录在 GitHub',
  },
  legal: {
    updated: '生效日期',
    others: '相关条款',
    terms: { title: '用户条款', description: '使用 Agents 工坊开源软件与云端服务的条款。' },
    privacy: {
      title: '隐私政策',
      description: 'Agents 工坊收集什么、存在哪、给谁用、你能怎么管。',
    },
    refund: {
      title: '退款政策',
      description: '积分一经购买不退款、不折现；只有重复扣款、系统多扣、法律强制三种例外。',
    },
  },
  notFound: {
    meta: { title: '找不到这一页 · Agents 工坊', description: '这一页不存在或已经搬走了。' },
    title: '这一页不在这儿。',
    sub: '可能搬走了，也可能地址打错了一个字。',
    home: '回首页',
    docs: '看教程',
  },
}

export type PagesCopy = typeof zh

const en: PagesCopy = {
  docs: {
    meta: {
      title: 'Guides · Agents Workshop',
      description:
        'Connect a model, your store and mailbox, install the browser extension, add website chat — every step of Agents Workshop has a plain-language guide.',
    },
    eyebrow: 'Guides',
    title: 'A plain-language guide for every step.',
    sub: 'The same articles you see in the app’s Guides panel.',
    groups: {
      start: 'Start here',
      models: 'Connect an AI',
      tools: 'Browser, computer use and data',
      connect: 'Connect your store, mailbox and platforms',
      channels: 'Messaging channels and website chat',
    },
    toc: 'On this page',
    all: 'All guides',
    edit: 'Edit this page on GitHub',
    prev: 'Previous',
    next: 'Next',
  },
  changelog: {
    meta: {
      title: 'Changelog · Agents Workshop',
      description: 'Every Agents Workshop update worth telling you about, in plain words.',
    },
    eyebrow: 'Changelog',
    title: 'Every step, out in the open.',
    sub: 'Requests come from the community; progress lives in the repo. Here are the parts that matter to you.',
    repo: 'The full development log is on GitHub',
  },
  legal: {
    updated: 'Effective',
    others: 'Related',
    terms: {
      title: 'Terms of Service',
      description: 'Terms for using the Agents Workshop open-source software and cloud services.',
    },
    privacy: {
      title: 'Privacy Policy',
      description:
        'What Agents Workshop collects, where it lives, who processes it, and how you control it.',
    },
    refund: {
      title: 'Refund Policy',
      description:
        'Credits are non-refundable once purchased, except for duplicate charges, system overcharges and where the law requires.',
    },
  },
  notFound: {
    meta: {
      title: 'Page not found · Agents Workshop',
      description: 'This page doesn’t exist or has moved.',
    },
    title: 'This page isn’t here.',
    sub: 'It may have moved, or the address has a typo.',
    home: 'Back home',
    docs: 'Read the guides',
  },
}

export const PAGES: Record<Lang, PagesCopy> = { zh, en }
