/**
 * WP227（Luoye 10-05 #9）：邮件正文里的链接点了用系统浏览器 / 新窗口打开。
 * 沙箱只多开 `allow-popups allow-popups-to-escape-sandbox`；只放行 http / https / mailto。
 */
import type { MessageRecord } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  BODY_SANDBOX,
  guardLinks,
  LINK_PROTOCOLS,
  MessageBody,
} from '@/components/messages/message-body'
import { renderWithProviders } from './helpers'

function anchors(html: string): HTMLAnchorElement[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('a'))
}

describe('正文链接（WP227）', () => {
  it('沙箱只开「新开窗口」这一个口子：仍然无脚本、无同源、无表单、不许动顶层窗口', () => {
    const tokens = BODY_SANDBOX.split(/\s+/u).sort()
    expect(tokens).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox'])
    for (const banned of [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-top-navigation',
      'allow-top-navigation-by-user-activation',
      'allow-modals',
    ])
      expect(tokens).not.toContain(banned)
    expect([...LINK_PROTOCOLS].sort()).toEqual(['http:', 'https:', 'mailto:'])
  })

  it('http / https / mailto：新窗口，断 opener 与 referrer', () => {
    const out = anchors(
      guardLinks(
        '<p><a href="https://shop.example/a?b=1">A</a> <a href="http://x.example">B</a> <a href="mailto:hi@x.example">C</a></p>',
      ),
    )
    expect(out).toHaveLength(3)
    for (const a of out) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(out.map((a) => a.getAttribute('href'))).toEqual([
      'https://shop.example/a?b=1',
      'http://x.example',
      'mailto:hi@x.example',
    ])
  })

  it('其它协议一律不开：拿掉 href，字还在', () => {
    const bad = [
      'tel:+123',
      'javascript:alert(1)',
      ' JAVASCRIPT:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'vbscript:x',
      'ms-msdt:/id',
      'smb://host/share',
      '/relative/path',
      '//proto-relative.example',
      'not a url',
    ]
    const html = bad.map((h, i) => `<a href="${h}" target="_top">L${i}</a>`).join('')
    const out = anchors(guardLinks(html))
    expect(out).toHaveLength(bad.length)
    for (const [i, a] of out.entries()) {
      expect(a.hasAttribute('href')).toBe(false)
      expect(a.hasAttribute('target')).toBe(false)
      expect(a.textContent).toBe(`L${i}`)
    }
  })

  it('页内锚点留着、只在框里跳（不新开窗口）', () => {
    const [a] = anchors(guardLinks('<a href="#top" target="_blank">回顶部</a>'))
    expect(a?.getAttribute('href')).toBe('#top')
    expect(a?.hasAttribute('target')).toBe(false)
  })

  it('渲染出来的 iframe 用这份沙箱，srcdoc 里的链接已经筛过', () => {
    const message = {
      id: 'msg_x',
      subject: 'hi',
      text: '',
      html: '<p><a href="https://shop.example" target="_blank" rel="noopener noreferrer">店</a><a href="tel:1">电话</a></p>',
    } as unknown as MessageRecord
    renderWithProviders(<MessageBody message={message} />)
    const frame = screen.getByTestId('message-html')
    expect(frame.getAttribute('sandbox')).toBe(BODY_SANDBOX)
    const srcdoc = frame.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain(
      '<a href="https://shop.example" target="_blank" rel="noopener noreferrer">店</a>',
    )
    expect(srcdoc).toContain('<a>电话</a>')
  })
})
