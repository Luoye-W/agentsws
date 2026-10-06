/**
 * 「交给这个岗位一件事」的三条提交路（54 §2 / WP84 / WP237），岗位页新旧两个入口共用一份：
 *
 * - `open`：一句话 → 岗位入口开事项 → 岗位内路由；判准了进事项页，拿不准停下来摆候选；
 * - `withRole`：「用这条职责开」——跳过路由，用本人那条分配开；
 * - `pick`：选择卡上点了一条 → 钉到那条并立刻开跑（WP237）。
 *
 * WP241 从 `position-entry.tsx` 原样抽出来（行为一个字没改），给岗位页 v2 的一行入口用。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createMatterWithRole,
  type OpenAtPositionData,
  openMatterAtPosition,
  rerouteMatter,
} from '@/lib/api'

export function usePositionOpen(id: string, onSubmitted: () => void) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [choice, setChoice] = useState<OpenAtPositionData | undefined>(undefined)

  const open = useMutation({
    mutationFn: (input: { title: string }) => openMatterAtPosition(id, input),
    onSuccess: (out) => {
      onSubmitted()
      void client.invalidateQueries({ queryKey: ['position-instance', id] })
      void client.invalidateQueries({ queryKey: ['position-work'] })
      // 判准了就直接进事项页；拿不准就停在这儿，把候选摆出来让人点一下
      // WP237：只有出了选择卡才停在这儿；「你好」这类（没出卡、事项里回了一句问要做什么）进事项页
      if (out.ambiguous && out.approval_item_id !== undefined) setChoice(out)
      else navigate(`/matters/${out.matter.id}`)
    },
  })

  /**
   * 54 §2 次入口：**用这条职责开**——跳过路由，指定用它的规矩做。
   * 用的就是那条职责的分配，所以权限、额度、动作面一个不多一个不少。
   */
  const withRole = useMutation({
    mutationFn: (input: { assignment: string; title: string }) =>
      createMatterWithRole(input.assignment, { title: input.title }),
    onSuccess: (out) => {
      onSubmitted()
      navigate(`/matters/${out.matter.id}`)
    },
  })

  /** 选择卡上点了一条：把这件事定给那条职责，然后进事项页（新的 Run 走它）。 */
  const pick = useMutation({
    mutationFn: (input: { matter_id: string; role_id: string }) =>
      // WP237：选了就钉到那条并立刻开跑（原来只钉不跑，事项停在那儿）
      rerouteMatter(input.matter_id, input.role_id, { run: true }),
    onSuccess: (_out, input) => {
      setChoice(undefined)
      navigate(`/matters/${input.matter_id}`)
    },
  })

  return { open, withRole, pick, choice }
}
