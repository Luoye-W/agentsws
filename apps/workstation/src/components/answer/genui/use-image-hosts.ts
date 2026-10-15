/**
 * WP341 追加（849）：外部图片的域名白名单（品牌级）——对话里「以后这个网站的图都直接显示」与设置页同一份。
 * 老服务进程没有这条路就当空名单（照旧都要点开看）。
 */
import type { GenuiImageHostsView } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addImageHost, getImageHosts, removeImageHost } from '@/lib/api'

export const IMAGE_HOSTS_KEY = ['settings', 'image-hosts'] as const

export function useImageHosts(): {
  view: GenuiImageHostsView | undefined
  /** 人加的 + 已连店铺的，合在一起（判断用）。 */
  allowed: string[]
  add: (host: string) => void
  remove: (host: string) => void
  busy: boolean
  error: string | undefined
} {
  const client = useQueryClient()
  const query = useQuery({ queryKey: IMAGE_HOSTS_KEY, queryFn: getImageHosts, retry: false })
  const onSuccess = (next: GenuiImageHostsView): void => {
    client.setQueryData(IMAGE_HOSTS_KEY, next)
  }
  const add = useMutation({ mutationFn: addImageHost, onSuccess })
  const remove = useMutation({ mutationFn: removeImageHost, onSuccess })
  const view = query.data
  const failed = add.error ?? remove.error
  return {
    view,
    allowed: view === undefined ? [] : [...view.shop_hosts, ...view.hosts.map((h) => h.host)],
    add: (host) => {
      add.mutate(host)
    },
    remove: (host) => {
      remove.mutate(host)
    },
    busy: add.isPending || remove.isPending,
    error: failed === null ? undefined : failed.message,
  }
}
