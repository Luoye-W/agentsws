/**
 * WP504：红人库的**轻的那一半**——卡片列判「这个岗位有没有红人库卡」、卡头那个数、本人名下的红人职责。
 * 注册表在启动时就要读它，所以不能把整个面板（`kol-library-panel.tsx`）拉进来。
 */
import { useQuery } from '@tanstack/react-query'
import type { CardStatus, RailPanelBodyProps } from '@/components/rail/registry'
import { getKolCreators, getPositions, type KolChannelId, type PositionsData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { ALL_CHANNELS } from './kol-channel'

/** 面板 id。 */
export const KOL_LIBRARY = 'kol-library'
/** 红人营销岗位的模板 id。 */
export const KOL_POSITION = 'kol-marketing'

/** 职责 id → 渠道（`kol.youtube` → `youtube`），同 `kol-panel.tsx` 的 `channelOfRole`。 */
function channelOf(role_id: string | undefined): KolChannelId | undefined {
  if (role_id === undefined || !role_id.startsWith('kol.')) return undefined
  const id = role_id.slice('kol.'.length)
  return ALL_CHANNELS.find((c) => c === id)
}

/** 本人名下的红人职责（一条渠道一条分配）。 */
export interface KolHome {
  /** 岗位名（「红人营销」）。 */
  name?: string
  channels: { channel: KolChannelId; assignment: string }[]
}

export function kolHomeOf(data: PositionsData | undefined, lang: 'zh' | 'en'): KolHome {
  const channels = (data?.positions ?? []).flatMap((p) => {
    const channel = channelOf(p.role_id)
    return channel === undefined ? [] : [{ channel, assignment: p.position_id }]
  })
  const inst = data?.instances?.find((i) => i.position_id === KOL_POSITION)
  return {
    ...(inst === undefined ? {} : { name: lang === 'en' ? inst.name.en : inst.name.zh }),
    channels,
  }
}

/** 这一页的岗位里有没有红人职责（卡片列的「红人库」卡只在这种岗位出）。 */
export function hasKolRole(props: Pick<RailPanelBodyProps, 'scope'>): boolean {
  return (props.scope?.roles ?? []).some((r) => channelOf(r.role_id) !== undefined)
}

/** 卡片列那张卡用哪条分配取数（本页岗位里的那条优先）。 */
export function useKolCardHome(props: Pick<RailPanelBodyProps, 'scope'>): string | undefined {
  const { lang } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const home = kolHomeOf(positions.data, lang)
  const here = new Set((props.scope?.roles ?? []).map((r) => r.assignment))
  return (home.channels.find((c) => here.has(c.assignment)) ?? home.channels[0])?.assignment
}

/** 卡头那个灰色计数（库里一共几个人）。 */
export function useKolLibraryStatus(props: RailPanelBodyProps): CardStatus | undefined {
  const assignment = useKolCardHome(props)
  const rows = useQuery({
    queryKey: ['kol-creators', assignment ?? '', 'all-channels'],
    queryFn: () => getKolCreators({}, assignment),
    enabled: assignment !== undefined,
  })
  const n = rows.data?.rows.length
  return n === undefined ? undefined : { count: n }
}
