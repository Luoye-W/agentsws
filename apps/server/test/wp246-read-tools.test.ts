/**
 * WP246：两个零配置的只读工具——YouTube 字幕、网页转文字。全程本地假站点，不访问真网站。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createReadRoutesStore } from '../src/read-routes/store.js'
import { createReadToolExecutor } from '../src/read-routes/tools.js'
import { readWebpage } from '../src/read-routes/webpage.js'
import { readYoutubeTranscript, videoIdOf } from '../src/read-routes/youtube.js'
import { startFakeReadSites } from './fake-read-sites.js'

let site: Awaited<ReturnType<typeof startFakeReadSites>>
beforeAll(async () => {
  site = await startFakeReadSites()
})
afterAll(async () => {
  await site.close()
})
const net = () => ({ fetch: site.fetch, lookup: site.lookup })

describe('YouTube 字幕（page_captions）', () => {
  it('认得出各种视频网址', () => {
    expect(videoIdOf('https://www.youtube.com/watch?v=okvideo0001&t=3')).toBe('okvideo0001')
    expect(videoIdOf('https://youtu.be/okvideo0001?si=x')).toBe('okvideo0001')
    expect(videoIdOf('https://www.youtube.com/shorts/okvideo0001')).toBe('okvideo0001')
    expect(videoIdOf('https://m.youtube.com/embed/okvideo0001')).toBe('okvideo0001')
    expect(videoIdOf('okvideo0001')).toBe('okvideo0001')
    expect(videoIdOf('https://vimeo.com/123')).toBeUndefined()
  })

  it('有字幕：标题 / 频道 / 简介 / 时长 + 带时间标记的字幕（人工字幕优先，双重转义解开）', async () => {
    const r = await readYoutubeTranscript(net(), { video: 'https://youtu.be/okvideo0001' })
    expect(r).toMatchObject({
      ok: true,
      video_id: 'okvideo0001',
      title: 'Air3 unboxing',
      channel: 'INMO Official',
      duration_seconds: 95,
      language: 'en',
      auto_generated: false,
    })
    expect(r.transcript).toContain(
      "[0:00] Hi everyone, it's unboxing day The Air3 display is <sharp>",
    )
    expect(r.transcript).toContain('[0:40] Battery lasts four hours')
    expect(r.tracks).toHaveLength(2)
    // 只去了 YouTube 的两页（视频页 + 字幕轨），都是 GET
    const yt = site.seen.filter((s) => s.host === 'www.youtube.com' && s.path !== '/robots.txt')
    expect(yt.map((s) => s.path)).toEqual(['/watch', '/api/timedtext'])
    expect(yt.every((s) => s.method === 'GET')).toBe(true)
  })

  it('新格式（<p t>）与 json3 两种字幕也认得出', async () => {
    const srv3 = await readYoutubeTranscript(net(), { video: 'srv3video01' })
    expect(srv3.transcript).toBe('[0:01] 字幕第一句\n[1:05] 第二句')
    const j = await readYoutubeTranscript(net(), { video: 'json3video1' })
    expect(j.transcript).toBe('[0:00] json captions second line')
  })

  it('拿不到照实说是哪一种；标题简介照样给', async () => {
    const none = await readYoutubeTranscript(net(), { video: 'nocaptions1' })
    expect(none).toMatchObject({ ok: false, failure: 'no_captions', title: 'No captions' })
    const empty = await readYoutubeTranscript(net(), { video: 'emptycaps01' })
    expect(empty).toMatchObject({ ok: false, failure: 'captions_empty', title: 'PO token' })
    expect(empty.message).toContain('只拿到了标题与简介')
    const age = await readYoutubeTranscript(net(), { video: 'agegated001' })
    expect(age).toMatchObject({ ok: false, failure: 'unplayable' })
    const gone = await readYoutubeTranscript(net(), { video: 'removed0001' })
    expect(gone).toMatchObject({ ok: false, failure: 'no_video' })
    const limited = await readYoutubeTranscript(net(), { video: 'ratelimit01' })
    expect(limited).toMatchObject({ ok: false, failure: 'blocked' })
    const changed = await readYoutubeTranscript(net(), { video: 'unknown0000' })
    expect(changed).toMatchObject({ ok: false, failure: 'unparsable' })
    const bad = await readYoutubeTranscript(net(), { video: 'not a video' })
    expect(bad).toMatchObject({ ok: false, failure: 'bad_input' })
  })

  it('字幕轨地址不在 YouTube 站内：不去取', async () => {
    const before = site.seen.length
    const r = await readYoutubeTranscript(net(), { video: 'offhosttrk1' })
    expect(r).toMatchObject({ ok: false, failure: 'unparsable' })
    expect(site.seen.slice(before).some((s) => s.host === 'evil.example')).toBe(false)
  })
})

describe('网页转文字（local_extract → third_party_reader）', () => {
  it('本机抽正文：去导航页眉页脚，跟跳转', async () => {
    const r = await readWebpage(
      { ...net(), thirdParty: () => false },
      { url: 'https://blog.example.com/moved' },
    )
    expect(r).toMatchObject({ ok: true, via: 'local_extract', title: 'Air3 review' })
    expect(r.final_url).toBe('https://blog.example.com/article')
    expect(r.markdown).toContain('# Air3 review')
    expect(r.markdown).not.toContain('Cart 0')
  })

  it('纯文本照原样；PDF 等不是网页的照实说', async () => {
    const t = await readWebpage(
      { ...net(), thirdParty: () => false },
      { url: 'https://blog.example.com/notes.txt' },
    )
    expect(t).toMatchObject({ ok: true, markdown: 'plain text notes' })
    const pdf = await readWebpage(
      { ...net(), thirdParty: () => false },
      { url: 'https://blog.example.com/file.pdf' },
    )
    expect(pdf.ok).toBe(false)
    expect(pdf.message).toContain('application/pdf')
  })

  it('本机抽不出 + 第三方没开（默认）：照实说，第三方一个请求都没去', async () => {
    const before = site.seen.length
    const r = await readWebpage(
      { ...net(), thirdParty: () => false },
      { url: 'https://app.example.com/spa' },
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('第三方转文字没开')
    expect(site.seen.slice(before).some((s) => s.host === 'r.jina.ai')).toBe(false)
  })

  it('第三方开了：本机抽不出才转过去，结果里明说经过了第三方', async () => {
    const r = await readWebpage(
      { ...net(), thirdParty: () => true },
      { url: 'https://app.example.com/spa' },
    )
    expect(r).toMatchObject({ ok: true, via: 'third_party_reader', title: 'Rendered by reader' })
    expect(r.markdown).toContain('# Rendered')
    expect(r.message).toContain('Jina Reader')
    // 本机抽得出的页面不会转给第三方
    const before = site.seen.length
    await readWebpage(
      { ...net(), thirdParty: () => true },
      { url: 'https://blog.example.com/article' },
    )
    expect(site.seen.slice(before).some((s) => s.host === 'r.jina.ai')).toBe(false)
  })

  it('内网 / 本机地址两级都不读（跳转去内网也拦），也不转给第三方', async () => {
    const before = site.seen.length
    for (const url of [
      'http://127.0.0.1:1/x',
      'http://localhost/x',
      'http://10.1.2.3/',
      'file:///etc/passwd',
    ]) {
      const r = await readWebpage({ ...net(), thirdParty: () => true }, { url })
      expect(r.ok).toBe(false)
    }
    expect(site.seen.length).toBe(before)
    const hop = await readWebpage(
      { ...net(), thirdParty: () => true },
      { url: 'https://blog.example.com/to-internal' },
    )
    expect(hop.ok).toBe(false)
    expect(site.seen.slice(before).some((s) => s.host === 'r.jina.ai')).toBe(false)
  })
})

describe('两个工具的执行器', () => {
  it('结果带来源；没取到是 ok + missing；每次记进体检小账；没装出网就照实说', async () => {
    const store = createReadRoutesStore()
    const exec = createReadToolExecutor({
      store,
      nowMs: () => Date.parse('2026-10-07T10:00:00Z'),
      youtube: net(),
      web: { ...net(), thirdParty: () => false },
    })
    const req = {} as never
    const ok = await exec({
      name: 'read_youtube_transcript',
      input: { video: 'okvideo0001' },
      request: req,
    })
    expect(ok.status).toBe('ok')
    expect(ok.data).toMatchObject({
      ok: true,
      source: { platform: 'youtube', level: 'page_captions', third_party: false },
    })
    const miss = await exec({
      name: 'read_youtube_transcript',
      input: { video: 'nocaptions1' },
      request: req,
    })
    expect(miss.data).toMatchObject({ ok: false, missing: expect.stringContaining('没有字幕轨') })
    expect(store.last('youtube', 'page_captions')).toMatchObject({ ok: false })
    const page = await exec({
      name: 'read_webpage',
      input: { url: 'https://app.example.com/spa' },
      request: req,
    })
    expect(page.data).toMatchObject({
      ok: false,
      missing: expect.stringContaining('第三方转文字没开'),
    })
    // 第三方没开：不记那一级（体检里它显示「默认关」，不显示「上次没成」）
    expect(store.last('web', 'third_party_reader')).toBeUndefined()
    expect(await exec({ name: 'read_webpage', input: {}, request: req })).toMatchObject({
      status: 'error',
    })
    const bare = createReadToolExecutor({ store, nowMs: () => 0 })
    const off = await bare({
      name: 'read_youtube_transcript',
      input: { video: 'okvideo0001' },
      request: req,
    })
    expect(off.data).toMatchObject({ ok: false, missing: expect.stringContaining('没装出网读取') })
  })
})
