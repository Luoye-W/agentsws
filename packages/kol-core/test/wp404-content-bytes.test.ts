/**
 * WP404：红人剧本的词表（意图判据、搜索去噪词、渠道词）从 .ts 挪成数据文件前后，判出来的东西一个字节不变。
 *
 * 全部内置红人职责的快捷提示 + 一批手写句子，过一遍意图判定、搜索词、渠道识别，取哈希和外置前比。
 * 真要改内容：`WP404_WRITE_FIXTURE=1` 重记，PR 里写明为什么。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { channelInText, classifyKolTask, parseOutreachStep, searchQueryOf } from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/wp404-content-bytes.json', import.meta.url))
const hash = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex').slice(0, 16)

const TEXTS = [
  '按这个品类在 YouTube 上找 20 个粉丝 1 万到 10 万的频道，按匹配度排给我',
  '给这个频道起草一封开发信：说清合作形式和寄样安排，不提具体报价',
  '建联发出去超过 7 天还没回音的频道有哪些，列出来告诉我要不要跟进',
  '红人交的这条视频审一遍：该标的广告标识、禁用词、链接和折扣码对不对',
  '上个月YouTube合作过的人里，按归因链接看哪几个真带来了订单，没带来的也列出来',
  '起草一条建联私信：说清合作形式、寄样和带货方式',
  '帮我在油管上找一批做露营装备测评的博主',
  '在抖音和小红书上搜美妆达人',
  'Find 10 TikTok creators for skincare',
  '这个合作到哪一步了，寄样了吗',
  '对方报价 800 美元，帮我谈价',
  '给 Instagram 上那几位再发一封跟进',
  '收尾那封信写一下',
  'IG 上有没有做户外的 up 主',
  'X 上的科技博主',
  '脸书群组里的宝妈',
  '随便聊聊',
]

function snapshot(): Record<string, string> {
  return {
    classify: hash(TEXTS.map((t) => classifyKolTask(t))),
    search: hash(TEXTS.map((t) => searchQueryOf(t))),
    channel: hash(TEXTS.map((t) => channelInText(t) ?? null)),
    step: hash(TEXTS.map((t) => parseOutreachStep(t))),
  }
}

describe('WP404 红人剧本词表外置前后逐字节相同', () => {
  it('意图判定、搜索词、渠道识别与外置前一致', () => {
    const now = snapshot()
    if (process.env.WP404_WRITE_FIXTURE === '1' || !existsSync(FIXTURE))
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })
})
