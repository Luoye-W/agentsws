/**
 * 公司页（WP28 交付 C）：左栏「公司」指向这里。
 *
 * WP70（54 §4，Luoye 09-16）：顶层**没有「职责」tab 了**——职责一律归在岗位下面，
 * 默认折叠收纳。原「职责」tab 那张说明卡（复制一份 / 改名与额度 / 已提交审批）
 * 现在长在「岗位」tab 里每个岗位的折叠层下面（`RoleDetail`，组件本身没动）。
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
import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BrandMark } from '@/components/design'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { AssignWizard } from '@/components/org/assign-wizard'
import { BrandsTab } from '@/components/org/brands-tab'
import { InprogressTab } from '@/components/org/inprogress-tab'
import { type JoinChoice, JoinTab } from '@/components/org/join-tab'
import { MembersTab } from '@/components/org/members-tab'
import { PositionsTab } from '@/components/org/positions-tab'
import { type ProductLineDraft, type RangeGroupDraft, RangesTab } from '@/components/org/ranges-tab'
import { ToolboxTab } from '@/components/org/toolbox-tab'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { OrgInvitationView } from '@/lib/api'
import {
  ApiClientError,
  checkOrgDuplicate,
  completeJoin,
  copyRoleDefinition,
  createAssignments,
  createInvite,
  createOrgPosition,
  createProductLine,
  createRangeGroup,
  decideMembershipRequest,
  deleteOrgPosition,
  deleteProductLine,
  deleteRangeGroup,
  ensureSession,
  getOnboardingState,
  getPositions,
  inviteMember,
  listDiscoveryPeers,
  listInvitations,
  listInvites,
  listJoins,
  listMembers,
  listMembershipRequests,
  listOrganizations,
  listOrgPositions,
  listProductLines,
  listRangeGroups,
  listRangeOptions,
  listRoleDefinitions,
  proposeRangeChange,
  proposeRoleChange,
  removeMember,
  requestMembership,
  revokeAssignment,
  updateOrgPosition,
  updateRangeGroup,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function OrgPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  // ⌘K 的"工具箱"结果跳到这里：`/org?tab=toolbox&q=…`
  const [params] = useSearchParams()
  // ⌘K 与顶栏切换器的"管理品牌"跳这里：`/org?tab=brands`
  const initialTab = params.get('tab')
  const [tab, setTab] = useState(
    initialTab === 'toolbox' || initialTab === 'brands' ? initialTab : 'positions',
  )
  const query = params.get('q')
  const [wizard, setWizard] = useState<string | null>(null)
  const [fresh, setFresh] = useState<OrgInvitationView | undefined>(undefined)
  const [submitted, setSubmitted] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /**
   * WP112：**新岗位上岗成功的回执**。
   *
   * 分配做完以前这里什么都不说——向导自己收起来，人盯着一张没变化的表猜"成了没有"。
   * 现在给一屏回执，配上母品牌那段「一变一队」：领头块先出现，其余五块从它的位置
   * 分出去。这正是这一刻的意思——**一个活做通了，复制成一队**。只播一次。
   *
   * 名字认不出来就是 `null`（不出回执）：宁可没有，也不在界面上印一串 id。
   */
  const [receipt, setReceipt] = useState<{ person: string; position: string } | null>(null)

  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  // 52 O1：这个品牌挂在哪家公司下（品牌一览要它）
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const orgId = orgs.data?.[0]?.id
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
  // 45：等着并进来的个人工作区（对照表）
  const joins = useQuery({
    queryKey: ['org', 'joins'],
    enabled,
    queryFn: () => listJoins(owner),
  })
  // 44：品牌（范围组）与产品线
  const brands = useQuery({
    queryKey: ['org', 'range-groups'],
    enabled,
    queryFn: () => listRangeGroups(owner),
  })
  const lines = useQuery({
    queryKey: ['org', 'product-lines'],
    enabled,
    queryFn: () => listProductLines(owner),
  })

  /**
   * 46 §2：加入 / 邀请。公司页是"这家公司都有谁"的地方，所以"还没进来的人"
   * 也该在这里——邀请码在这儿发，别人的申请在这儿定（同一条也在首页队列里）。
   */
  const me = useQuery({
    queryKey: ['onboarding', 'state'],
    enabled,
    queryFn: () => getOnboardingState(owner),
    retry: false,
  })
  const peers = useQuery({
    queryKey: ['onboarding', 'peers'],
    enabled,
    queryFn: () => listDiscoveryPeers(owner),
    retry: false,
  })
  const invites = useQuery({
    queryKey: ['onboarding', 'invites'],
    enabled,
    queryFn: () => listInvites(owner),
    retry: false,
  })
  const requests = useQuery({
    queryKey: ['onboarding', 'requests'],
    enabled,
    queryFn: () => listMembershipRequests(owner),
    retry: false,
  })
  // 45 H4：建之前先查。身份稳定（`useCallback`），不然表单每渲染一次就重排一次查询
  const checkDuplicate = useCallback(
    (query: Parameters<typeof checkOrgDuplicate>[0]) => checkOrgDuplicate(query, owner),
    [owner],
  )

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['org'] })
    // 分配 / 撤销会改左栏（本人持有的岗位）
    await client.invalidateQueries({ queryKey: ['positions'] })
    await client.invalidateQueries({ queryKey: ['onboarding'] })
  }

  const say = (err: unknown): void => {
    setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  const assign = useMutation({
    mutationFn: (input: {
      person_id: string
      position_id: string
      ranges: { kind: string; id: string }[]
      range_groups: string[]
    }) => createAssignments(input, owner),
    onSuccess: async (_data, input) => {
      setFailure(undefined)
      setWizard(null)
      // WP112：上岗成功给一张回执（见 `receipt` 那一段）。名字从界面上已经有的
      // 两张清单里认，认不出来就不出回执——宁可没有，也不印一串 id
      const person = (members.data ?? []).find((m) => m.person_id === input.person_id)?.name
      const position = (positions.data ?? []).find((x) => x.id === input.position_id)?.name
      setReceipt(person === undefined || position === undefined ? null : { person, position })
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

  // 44 G1 / G2：品牌与产品线的增删改
  const brandCreate = useMutation({
    mutationFn: (input: RangeGroupDraft) => createRangeGroup(input, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  const brandUpdate = useMutation({
    mutationFn: (input: { id: string; body: RangeGroupDraft }) =>
      updateRangeGroup(input.id, input.body, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  const brandDelete = useMutation({
    mutationFn: (id: string) => deleteRangeGroup(id, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  const lineCreate = useMutation({
    mutationFn: (input: ProductLineDraft) => createProductLine(input, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  const joinComplete = useMutation({
    mutationFn: (input: { id: string; choice: JoinChoice }) =>
      completeJoin(input.id, input.choice, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  // 45 H5：只读的那一条（并进公司之后的个人副本、非 owner 看到的组织结构）改动走提议卡
  const rangePropose = useMutation({
    mutationFn: (input: { target: 'range_group' | 'product_line'; id: string; reason: string }) =>
      proposeRangeChange(input.target, input.id, { reason: input.reason }, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  const lineDelete = useMutation({
    mutationFn: (id: string) => deleteProductLine(id, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const [joinSent, setJoinSent] = useState(false)
  const newInvite = useMutation({
    mutationFn: () => createInvite(undefined, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })
  const join = useMutation({
    mutationFn: (input: { code?: string; peer_id?: string }) =>
      requestMembership({
        ...input,
        name: me.data?.person.name ?? '',
        email: me.data?.person.email ?? '',
      }),
    onSuccess: () => {
      setFailure(undefined)
      setJoinSent(true)
    },
    onError: say,
  })
  const decide = useMutation({
    mutationFn: (input: { id: string; approve: boolean }) =>
      decideMembershipRequest(input.id, { approve: input.approve }, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  const busy =
    assign.isPending ||
    newInvite.isPending ||
    join.isPending ||
    decide.isPending ||
    brandCreate.isPending ||
    brandUpdate.isPending ||
    brandDelete.isPending ||
    lineCreate.isPending ||
    joinComplete.isPending ||
    rangePropose.isPending ||
    lineDelete.isPending ||
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

      {receipt === null ? null : (
        <Card data-testid="assign-receipt">
          <CardContent className="flex items-center gap-4 pt-6">
            <BrandMark size={44} motion="split" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="ws-display text-[15px]">
                {t('org.assign.receipt', { person: receipt.person, position: receipt.position })}
              </p>
              <p className="text-[12.5px] text-ws-muted-fg">{t('org.assign.receipt.hint')}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="assign-receipt-close"
              onClick={() => {
                setReceipt(null)
              }}
            >
              {t('org.assign.receipt.close')}
            </Button>
          </CardContent>
        </Card>
      )}

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
              rangeGroups={brands.data ?? []}
              productLines={lines.data ?? []}
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
          {/* 52 O2：品牌一览排在最前——公司页问的第一件事就是"这家公司有哪几个品牌" */}
          <TabsTrigger value="brands">{t('org.tab.brands')}</TabsTrigger>
          <TabsTrigger value="positions">{t('org.tab.positions')}</TabsTrigger>
          <TabsTrigger value="members">{t('org.tab.members')}</TabsTrigger>
          <TabsTrigger value="ranges">{t('org.tab.ranges')}</TabsTrigger>
          <TabsTrigger value="invite">{t('onboarding.join.title')}</TabsTrigger>
          <TabsTrigger value="join">{t('org.tab.join')}</TabsTrigger>
          <TabsTrigger value="toolbox">{t('org.tab.toolbox')}</TabsTrigger>
          <TabsTrigger value="inprogress">{t('org.tab.inprogress')}</TabsTrigger>
        </TabsList>

        <TabsContent value="brands" className="pt-3">
          <BrandsTab
            {...(orgId === undefined ? {} : { org_id: orgId })}
            {...(owner === undefined ? {} : { assignment: owner })}
          />
        </TabsContent>

        <TabsContent value="positions" className="pt-3">
          {positions.data === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <PositionsTab
              positions={positions.data}
              roles={roles.data ?? []}
              busy={busy}
              {...(submitted === undefined ? {} : { submitted })}
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
              onCopyRole={(id) => {
                copy.mutate(id)
              }}
              onProposeRole={(id, patch) => {
                propose.mutate({ id, patch })
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

        {/* 44：品牌与产品线（G1 / G2） */}
        <TabsContent value="ranges" className="pt-3">
          {brands.data === undefined || lines.data === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RangesTab
              groups={brands.data}
              lines={lines.data}
              rangeOptions={ranges.data ?? []}
              busy={busy}
              {...(failure === undefined || wizard !== null ? {} : { error: failure })}
              onCreateGroup={(input) => {
                brandCreate.mutate(input)
              }}
              onUpdateGroup={(id, body) => {
                brandUpdate.mutate({ id, body })
              }}
              onDeleteGroup={(id) => {
                brandDelete.mutate(id)
              }}
              onCreateLine={(input) => {
                lineCreate.mutate(input)
              }}
              onDeleteLine={(id) => {
                lineDelete.mutate(id)
              }}
              onPropose={(target, id, reason) => {
                rangePropose.mutate({ target, id, reason })
              }}
              onCheckDuplicate={checkDuplicate}
            />
          )}
        </TabsContent>

        {/* 46 §2 I2 I3：加入一家公司 / 邀请同事 / 谁申请过加入 */}
        <TabsContent value="invite" className="pt-3">
          {me.data === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <JoinPanel
              {...(peers.data === undefined ? {} : { discovery: peers.data })}
              configured={me.data.profile !== undefined}
              invites={invites.data ?? []}
              requests={requests.data ?? []}
              busy={busy}
              sent={joinSent}
              {...(failure === undefined || wizard !== null ? {} : { error: failure })}
              onJoin={(input) => {
                join.mutate(input)
              }}
              onCreateInvite={() => {
                newInvite.mutate()
              }}
              onDecide={(id, approve) => {
                decide.mutate({ id, approve })
              }}
            />
          )}
        </TabsContent>

        {/* 45 H2：个人工作区并进公司的对照页（三类分组、每类全部采纳） */}
        <TabsContent value="join" className="pt-3">
          <JoinTab
            {...(joins.data?.[0] === undefined ? {} : { mapping: joins.data[0] })}
            busy={busy}
            {...(failure === undefined || wizard !== null ? {} : { error: failure })}
            onComplete={(choice) => {
              const first = joins.data?.[0]
              if (first !== undefined) joinComplete.mutate({ id: first.join_id, choice })
            }}
          />
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
