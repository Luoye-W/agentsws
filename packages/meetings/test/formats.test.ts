import { describe, expect, it } from 'vitest'
import {
  detectFormat,
  documentToText,
  parseTimestamp,
  parseTranscript,
} from '../src/sources/formats.js'

describe('导入格式解析', () => {
  it('时间戳：三段 / 两段 / 毫秒补零', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1500)
    expect(parseTimestamp('01:02.5')).toBe(62_500)
    expect(parseTimestamp('1:03')).toBe(63_000)
    expect(parseTimestamp('aa:bb')).toBe(0)
  })

  it('猜格式：vtt / srt / 说话人块 / 纯文本', () => {
    expect(detectFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi')).toBe('vtt')
    expect(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nhi')).toBe('srt')
    expect(detectFormat('张三 0:12\n你好')).toBe('speaker_blocks')
    expect(detectFormat('张三：你好')).toBe('plain')
  })

  it('SRT：说话人从 `名字：` 前缀里认出来', () => {
    const t = parseTranscript('1\n00:00:01,000 --> 00:00:04,000\n罗野：开始吧。')
    expect(t?.segments).toEqual([
      { start_ms: 1000, end_ms: 4000, speaker: '罗野', text: '开始吧。' },
    ])
    expect(t?.speakers).toEqual(['罗野'])
    expect(t?.text).toBe('罗野：开始吧。')
  })

  it('VTT：`<v 名字>` 认说话人，闭合标签也吃得下', () => {
    const t = parseTranscript(
      ['WEBVTT', '', '00:00:02.000 --> 00:00:05.000', '<v Alice>hello</v>'].join('\n'),
    )
    expect(t?.segments?.[0]).toEqual({
      start_ms: 2000,
      end_ms: 5000,
      speaker: 'Alice',
      text: 'hello',
    })
  })

  it('cue 里没有时间行 / 正文为空 → 跳过；全跳过就回 undefined', () => {
    expect(parseTranscript('1\n2\n3', { format: 'srt' })).toBeUndefined()
    expect(parseTranscript('00:00:01,000 --> 00:00:02,000', { format: 'srt' })).toBeUndefined()
    expect(parseTranscript('   ')).toBeUndefined()
  })

  it('说话人块：末段 end_ms 用下一段起点补；没有说话人头的行被丢掉', () => {
    const t = parseTranscript(
      ['开场白（没有头）', 'Alice  0:05', 'first', '', 'Bob  0:30', 'second'].join('\n'),
    )
    expect(t?.segments).toEqual([
      { start_ms: 5000, end_ms: 30_000, speaker: 'Alice', text: 'first' },
      { start_ms: 30_000, end_ms: 30_000, speaker: 'Bob', text: 'second' },
    ])
  })

  it('纯文本：没有冒号就整行当正文；语言可以带上', () => {
    const t = parseTranscript('随便说了一句', { format: 'plain', language: 'zh' })
    expect(t?.segments?.[0]?.speaker).toBeUndefined()
    expect(t?.language).toBe('zh')
    expect(t?.speakers).toBeUndefined()
  })

  it('文档转文本：markdown 去格式', () => {
    const md = [
      '# 标题',
      '',
      '- **张三**：*要点*',
      '> 引用',
      '```js',
      'code',
      '```',
      '[链接](http://x)',
    ].join('\n')
    const text = documentToText(md)
    expect(text).toContain('张三：要点')
    expect(text).toContain('引用')
    expect(text).not.toContain('#')
    expect(text).toContain('链接')
    expect(text).not.toContain('http://x')
  })

  it('文档转文本：HTML 去标签、脚本整段丢掉、实体还原', () => {
    const html =
      '<html><body><script>alert(1)</script><p>甲</p><br>乙 &amp; &lt;丙&gt;</body></html>'
    const text = documentToText(html)
    expect(text).not.toContain('alert')
    expect(text).toContain('甲')
    expect(text).toContain('乙 & <丙>')
    expect(documentToText('<p>x</p>', 'text/html')).toBe('x')
  })
})
