/**
 * 公司页（WP28 交付 C）：左栏「公司」指向这里，三个 Tab——岗位 / 成员 / 职责。
 *
 * 这一页做的就是 38 §1 里缺的那一块："真实模式只有工作区所有者，建不了岗位、
 * 分不了人、邀请不了同事"。现在非技术用户可以在界面上把「独立站售后客服」分给一个同事。
 *
 * 两处与别的页面不同：
 * 1. **一律用所有者那条 Assignment**（05 §3 策略层只有 owner 可改；31 §3.1 一次请求一个）。
 *    没有所有者岗位的人打开这一页，看到的是一句人话，不是一片 403。
 * 2. **改职责模板不会立刻生效**：提交之后只显示「已提交审批」，卡片回到首页队列里等你定。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AssignWizard } from '@/components/org/assign-wizard'
import { InprogressTab } from '@/components/org/inprogress-tab'
import { MembersTab } from '@/components/org/members-tab'
import { PositionsTab } from '@/components/org/positions-tab'
import { RolesTab } from '@/components/org/roles-tab'
import { ToolboxTab } from '@/components/org/toolbox-tab'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { OrgInvitationView } from '@/lib/api'
import {
  ApiClientError,
  copyRoleDefinition,
  createAssignments,
  createOrgPosition,
  deleteOrgPosition,
  ensureSession,
  getPositions,
  inviteMember,
  listInvitations,
  listMembers,
  listOrgPositions,
  listRangeOptions,
  listRoleDefinitions,
  proposeRoleChange,
  removeMember,
  revokeAssignment,
  updateOrgPosition,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function OrgPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  // ⌘K 的"工具箱"结果跳到这里：`/org?tab=toolbox&q=…`
  const [params] = useSearchParams()
  const [tab, setTab] = useState(params.get('tab') === 'toolbox' ? 'toolbox' : 'positions')
  const query = params.get('q')
  const [wizard, setWizard] = useState<string | null>(null)
  const [fresh, setFresh] = useState<OrgInvitationView | undefined>(undefined)
  const [submitted, setSubmitted] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  // 05：制度这一层是所有者的事；这一页不跟着左栏当前岗位走
  const owner = mine.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const workspace = session.data?.workspace.id

  const enabled = owner !== undefined && workspace !== undefined
  const positions = useQuery({
    queryKey: ['org', 'positions'],
    enabled,
    queryFn: () => listOrgPositions(owner),
  })
  const roles = useQuery({
    queryKey: ['org', 'roles'],
    enabled,
    queryFn: () => listRoleDefinitions(owner),
  })
  const members = useQuery({
    queryKey: ['org', 'members'],
    enabled,
    queryFn: () => listMembers(workspace ?? '', owner),
  })
  const invitations = useQuery({
    queryKey: ['org', 'invitations'],
    enabled,
    queryFn: () => listInvitations(workspace ?? '', owner),
  })
  const ranges = useQuery({
    queryKey: ['org', 'ranges'],
    enabled,
    queryFn: () => listRangeOptions(owner),
  })

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['org'] })
    // 分配 / 撤销会改左栏（本人持有的岗位）
    await client.invalidateQueries({ queryKey: ['positions'] })
  }

  const say = (err: unknown): void => {
    setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  const assign = useMutation({
    mutationFn: (input: {
      person_id: string
      position_id: string
      ranges: { kind: string; id: string }[]
    }) => createAssignments(input, owner),
    onSuccess: async () => {
      setFailure(undefined)
      setWizard(null)
      await refresh()
    },
    onError: say,
  })

  const create = useMutation({
    mutationFn: (input: { name: string; roles: { role_id: string; default: boolean }[] }) =>
      createOrgPosition(input, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const update = useMutation({
    mutationFn: (input: {
      id: string
      body: { name: string; roles: { role_id: string; default: boolean }[] }
    }) => updateOrgPosition(input.id, input.body, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const drop = useMutation({
    mutationFn: (id: string) => deleteOrgPosition(id, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const invite = useMutation({
    mutationFn: (input: { email: string; name?: string; position_id?: string }) =>
      inviteMember(workspace ?? '', input, owner),
    onSuccess: async (created) => {
      setFailure(undefined)
      setFresh(created)
      await refresh()
    },
    onError: say,
  })

  const revoke = useMutation({
    mutationFn: (id: string) => revokeAssignment(id, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const remove = useMutation({
    mutationFn: (person_id: string) => removeMember(workspace ?? '', person_id, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const copy = useMutation({
    mutationFn: (id: string) => copyRoleDefinition(id, undefined, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const propose = useMutation({
    mutationFn: (input: {
      id: string
      patch: { name?: string; actions?: { id: string; caps?: Record<string, number> }[] }
    }) => proposeRoleChange(input.id, input.patch, owner),
    onSuccess: async (_receipt, input) => {
      setFailure(undefined)
      setSubmitted(input.id)
      await refresh()
    },
    onError: say,
  })

  const busy =
    assign.isPending ||
    create.isPending ||
    update.isPending ||
    drop.isPending ||
    invite.isPending ||
    revoke.isPending ||
    remove.isPending ||
    copy.isPending ||
    propose.isPending

  if (mine.data === undefined || session.data === undefined) {
    return <Skeleton className="h-64 w-full" />
  }

  if (!enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('org.title')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground" data-testid="org-not-owner">
          {t('org.not_owner')}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-sm font-semibold">{t('org.title')}</h1>
        <p className="text-xs text-muted-foreground">{t('org.subtitle')}</p>
      </div>

      {wizard === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('org.assign.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <AssignWizard
              members={members.data ?? []}
              positions={positions.data ?? []}
              rangeOptions={ranges.data ?? []}
              presetPosition={wizard}
              busy={assign.isPending}
              {...(failure === undefined ? {} : { error: failure })}
              onCancel={() => {
                setWizard(null)
              }}
              onConfirm={(choice) => {
                assign.mutate(choice)
              }}
            />
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="positions">{t('org.tab.positions')}</TabsTrigger>
          <TabsTrigger value="members">{t('org.tab.members')}</TabsTrigger>
          <TabsTrigger value="roles">{t('org.tab.roles')}</TabsTrigger>
          <TabsTrigger value="toolbox">{t('org.tab.toolbox')}</TabsTrigger>
          <TabsTrigger value="inprogress">{t('org.tab.inprogress')}</TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="pt-3">
          {positions.data === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <PositionsTab
              positions={positions.data}
              roles={roles.data ?? []}
              busy={busy}
              {...(failure === undefined || wizard !== null ? {} : { error: failure })}
              onAssign={(id) => {
                setFailure(undefined)
                setWizard(id)
              }}
              onCreate={(input) => {
                create.mutate(input)
              }}
              onSaveRoles={(id, body) => {
                update.mutate({ id, body })
              }}
              onDelete={(id) => {
                drop.mutate(id)
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="members" className="pt-3">
          {members.data === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <MembersTab
              members={members.data}
              invitations={invitations.data ?? []}
              positions={positions.data ?? []}
              busy={busy}
              {...(fresh === undefined ? {} : { freshInvite: fresh })}
              {...(failure === undefined || wizard !== null ? {} : { error: failure })}
              onInvite={(input) => {
                invite.mutate(input)
              }}
              onRevoke={(id) => {
                revoke.mutate(id)
              }}
              onRemove={(person_id) => {
                remove.mutate(person_id)
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="roles" className="pt-3">
          {roles.data === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RolesTab
              roles={roles.data}
              busy={busy}
              {...(submitted === undefined ? {} : { submitted })}
              {...(failure === undefined || wizard !== null ? {} : { error: failure })}
              onCopy={(id) => {
                copy.mutate(id)
              }}
              onPropose={(id, patch) => {
                propose.mutate({ id, patch })
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="toolbox" className="pt-3">
          <ToolboxTab assignment={owner} {...(query === null ? {} : { initialQuery: query })} />
        </TabsContent>

        {/* 40 §3.3 进行中看板：自己取数，页面这边只多这一行 */}
        <TabsContent value="inprogress" className="pt-3">
          <InprogressTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
