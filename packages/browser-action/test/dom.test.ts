// @vitest-environment jsdom
/**
 * 页面里那一半：选择器只认唯一一个、文字完全相等；填值走原生 setter 并发事件；
 * 页面迹象认验证码 / 登录 / 受限。
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  detectPageWall,
  domClick,
  domCount,
  domFill,
  domLook,
  domSetFile,
  resolveAll,
  resolveOne,
} from '../src/index.js'

function doc(body: string, url = 'https://ads.google.com/aw/campaigns'): Document {
  return new JSDOM(
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
    {
      url,
    },
  ).window.document
}

describe('选择器', () => {
  it('`>> text=` 要完全相等（「暂停」不认「暂停所有」）', () => {
    const d = doc('<button>Pause</button><button>Pause all</button><button> Pause </button>')
    expect(resolveAll(d, 'button >> text=Pause')).toHaveLength(2)
    expect(resolveOne(d, 'button >> text=Pause all')?.textContent).toBe('Pause all')
  })
  it('零个或多个都不点', () => {
    const d = doc('<button>A</button><button>A</button>')
    expect(domClick(d, 'button >> text=A').ok).toBe(false)
    expect(domClick(d, 'button >> text=B').ok).toBe(false)
    expect(domCount(d, ':::bad')).toBe(0)
  })
  it('灰的 / 藏着的不点', () => {
    const d = doc('<button disabled>X</button><div hidden><button>Y</button></div>')
    expect(domClick(d, 'button >> text=X').ok).toBe(false)
    expect(domClick(d, 'button >> text=Y').ok).toBe(false)
  })
})

describe('填值与放文件', () => {
  it('填值发 input / change 事件', () => {
    const d = doc('<input id="n">')
    const seen: string[] = []
    d.querySelector('#n')?.addEventListener('input', () => seen.push('input'))
    d.querySelector('#n')?.addEventListener('change', () => seen.push('change'))
    expect(domFill(d, '#n', '230').ok).toBe(true)
    expect((d.querySelector('#n') as HTMLInputElement).value).toBe('230')
    expect(seen).toEqual(['input', 'change'])
  })
  it('文件只放进 type=file 的框', () => {
    const d = doc('<input id="f" type="file"><input id="t">')
    const file = { name: 'a.csv', mime: 'text/csv', bytes: new Uint8Array([97]) }
    expect(domSetFile(d, '#t', file).ok).toBe(false)
    expect(domSetFile(d, '#f', file).ok).toBe(true)
    expect((d.querySelector('#f') as HTMLInputElement).files?.[0]?.name).toBe('a.csv')
  })
})

describe('被拦了没有', () => {
  it('验证码 / 登录 / 受限 / 正常', () => {
    const cap = domLook(
      doc('<iframe src="https://www.google.com/recaptcha/api2/x"></iframe>'),
      'https://ads.google.com/',
    )
    expect(detectPageWall(cap)?.kind).toBe('captcha')
    const login = domLook(doc('<input type="password">'), 'https://accounts.google.com/signin')
    expect(detectPageWall(login)?.kind).toBe('login')
    const blocked = domLook(doc('<p>We detected unusual activity</p>'), 'https://ads.google.com/')
    expect(detectPageWall(blocked)?.kind).toBe('blocked')
    expect(
      detectPageWall(domLook(doc('<p>Campaigns</p>'), 'https://ads.google.com/')),
    ).toBeUndefined()
  })
})
