/** WP409（内测真机 10-18 #4）：配上了工具栏图标挂绿勾，没配上不挂、标题说「点一下去配对」。 */
import { describe, expect, it } from 'vitest'
import {
  type ActionBadgePort,
  PAIRED_BADGE_COLOR,
  syncPairedBadge,
  TITLE_PAIRED,
  TITLE_UNPAIRED,
} from '@/lib/badge'

function fakeAction(): ActionBadgePort & {
  text: string
  color: string | undefined
  title: string | undefined
} {
  const a = {
    text: 'x',
    color: undefined as string | undefined,
    title: undefined as string | undefined,
    setBadgeText: ({ text }: { text: string }) => {
      a.text = text
    },
    setBadgeBackgroundColor: ({ color }: { color: string }) => {
      a.color = color
    },
    setTitle: ({ title }: { title: string }) => {
      a.title = title
    },
  }
  return a
}

describe('syncPairedBadge', () => {
  it('配上了：绿勾 + 标题说连上了', async () => {
    const a = fakeAction()
    await syncPairedBadge(a, true)
    expect(a.text).toBe('✓')
    expect(a.color).toBe(PAIRED_BADGE_COLOR)
    expect(a.title).toBe(TITLE_PAIRED)
  })

  it('没配上 / 解除了：角标清掉，标题说点一下去配对', async () => {
    const a = fakeAction()
    await syncPairedBadge(a, true)
    await syncPairedBadge(a, false)
    expect(a.text).toBe('')
    expect(a.title).toBe(TITLE_UNPAIRED)
  })
})
