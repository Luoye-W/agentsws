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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CompanyModeEntry } from '@/components/company/company-mode'
import { BrandMark } from '@/components/design'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { AssignWizard } from '@/components/org/assign-wizard'
import { BrandAssetsCard } from '@/components/org/brand-assets-card'
import { BrandDesignCard } from '@/components/org/brand-design-card'
import { BrandsTab } from '@/components/org/brands-tab'
import { ColleaguesTab, inviteLinkOf } from '@/components/org/colleagues-tab'
import { GrossMarginCard } from '@/components/org/gross-margin-card'
import { InprogressTab } from '@/components/org/inprogress-tab'
import { type JoinChoice, JoinTab } from '@/components/org/join-tab'
import { MembersTab } from '@/components/org/members-tab'
import { OwnerCard } from '@/components/org/owner-card'
import { OWNER_POSITION, type PositionDraft, PositionsTab } from '@/components/org/positions-tab'
import { type ProductLineDraft, type RangeGroupDraft, RangesTab } from '@/components/org/ranges-tab'
import { ToolboxTab } from '@/components/org/toolbox-tab'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
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
  mergeOrgPosition,
  moveOrgPositionDuty,
  type PositionReshapeView,
  proposeRangeChange,
  proposeRoleChange,
  removeMember,
  requestMembership,
  revokeAssignment,
  setOrgPositionSupervisor,
  splitOrgPosition,
  transferOwner,
  updateOrgPosition,
  updateRangeGroup,
} from '@/lib/api'
import {
  exportMyWork,
  leaveWorkspace,
  listPeerOffers,
  offerInitiator,
  offerPosition,
  PEER_OFFERS_KEY,
  type PeerOfferView,
  turnOnDiscovery,
  withdrawPeerOffer,
} from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'

/** WP202：预填的红人营销岗位勾哪两条（与 WP201b 在真线上建的那一个一样）。 */
const KOL_PRESET_ROLES = ['kol.youtube', 'kol.instagram']

/** WP271：① 个人里公司页（「岗位与品牌」）只留这三个 tab（docs/95 §2.2）。 */
const SOLO_TABS = new Set(['brands', 'positions', 'toolbox'])
/** WP276：② 同事互联的「团队」页——同事、品牌、岗位、进行中、工具箱（没有成员 / 范围 / 加入公司 / 并进来）。 */
const PEER_TABS = new Set(['brands', 'positions', 'colleagues', 'toolbox', 'inprogress'])

export function OrgPage(): React.ReactNode {
  const { t } = useApp()
  /*
   * WP271（docs/95 §2.2）：① 个人——左栏叫「岗位与品牌」，页里只留品牌 / 岗位 / 工具箱；
   * 负责人卡、成员、品牌与产品线、加入一家公司、并进来、进行中一律收起（数据都在）。
   */
  const { t: tm, solo, mode } = useMode()
  /** WP276：② 同事互联（平级，团队页人人能进）。 */
  const peers = mode === 'peers'
  /** WP276：① 里「和同事一起用」那一块开着没有（开的那一下打开局域网发现，决策 234）。 */
  const [together, setTogether] = useState(false)
  const client = useQueryClient()
  // ⌘K 的"工具箱"结果跳到这里：`/org?tab=toolbox&q=…`
  const [params] = useSearchParams()
  // ⌘K 与顶栏切换器的"管理品牌"跳这里：`/org?tab=brands`
  const initialTab = params.get('tab')
  // WP206：「积分」tab 拿掉了（额度分配只在网页版账号页做）；老链接 `?tab=credits` 落到岗位
  const [chosenTab, setTab] = useState(
    initialTab === 'toolbox' || initialTab === 'brands' ? initialTab : 'positions',
  )
  // WP271：① 里收起的 tab 落回「岗位」（老链接、或从 ③ 降回来时停在那几个 tab 上）
  const tab =
    (solo && !SOLO_TABS.has(chosenTab)) || (peers && !PEER_TABS.has(chosenTab))
      ? 'positions'
      : chosenTab
  const query = params.get('q')
  /**
   * WP202：`/org?new=kol`——从「连接 → 浏览器插件」那句「你还没有红人营销岗位」跳来。
   * 已经有含红人职责的岗位（只是没人拿着）就在那张卡下面打开「分给同事」；
   * 没有就打开「新建岗位」，预填「红人营销」+ YouTube / Instagram 红人两条。
   */
  const wantKol = params.get('new') === 'kol'
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
  const [receipt, setReceipt] = useState<{
    person: string
    position: string
    /** WP202：回执长在哪张岗位卡下面（就地展开，和向导同一个位置）。 */
    position_id: string
  } | null>(null)

  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  // 52 O1：这个品牌挂在哪家公司下（品牌一览要它）
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const orgId = orgs.data?.[0]?.id
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  // 05：制度这一层是所有者的事；这一页不跟着左栏当前岗位走
  const owner = mine.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  /**
   * WP276（docs/95 §6.2 第 2 条）：② 平级的同事没有所有者那条分配——团队页用他自己任意一条
   * （服务端在 ② 里把团队页那几条放开）；改规矩、发邀请码、同意新人也用它。家务（请人离开、
   * 删岗位、分岗位）仍然只用所有者那条，不是发起人就不出那几个按钮。
   */
  const as = owner ?? (peers ? mine.data?.positions[0]?.position_id : undefined)
  const myId = session.data?.person.id
  const initiator = orgs.data?.[0]?.owner_id
  const company = mode === 'company'
  // WP215（Fable 10-05）：品牌急停公司管理员也能按——没有所有者岗位的管理员拿自己任意一条岗位去按
  const orgRole = orgs.data?.[0]?.role
  const haltAs =
    owner ??
    (orgRole === 'owner' || orgRole === 'admin' ? mine.data?.positions[0]?.position_id : undefined)
  const workspace = session.data?.workspace.id

  const enabled = as !== undefined && workspace !== undefined
  const positions = useQuery({
    queryKey: ['org', 'positions'],
    enabled,
    queryFn: () => listOrgPositions(as),
  })
  const roles = useQuery({
    queryKey: ['org', 'roles'],
    enabled,
    queryFn: () => listRoleDefinitions(as),
  })
  const members = useQuery({
    queryKey: ['org', 'members'],
    enabled,
    queryFn: () => listMembers(workspace ?? '', as),
  })
  const invitations = useQuery({
    queryKey: ['org', 'invitations'],
    // WP276：邮件邀请链接只在 ③（① ② 只有邀请码 + 它的链接，两套合一）
    enabled: enabled && company,
    queryFn: () => listInvitations(workspace ?? '', owner),
  })
  const ranges = useQuery({
    queryKey: ['org', 'ranges'],
    // WP276：范围只在 ③ 有
    enabled: enabled && company,
    queryFn: () => listRangeOptions(owner),
  })
  // 45：等着并进来的个人工作区（对照表）
  const joins = useQuery({
    queryKey: ['org', 'joins'],
    // WP271 / WP276：「并进来」只在 ③
    enabled: enabled && company,
    queryFn: () => listJoins(owner),
  })
  // 44：品牌（范围组）与产品线
  const brands = useQuery({
    queryKey: ['org', 'range-groups'],
    enabled: enabled && company,
    queryFn: () => listRangeGroups(owner),
  })
  const lines = useQuery({
    queryKey: ['org', 'product-lines'],
    enabled: enabled && company,
    queryFn: () => listProductLines(owner),
  })

  /**
   * 46 §2：加入 / 邀请。公司页是"这家公司都有谁"的地方，所以"还没进来的人"
   * 也该在这里——邀请码在这儿发，别人的申请在这儿定（同一条也在首页队列里）。
   */
  const me = useQuery({
    queryKey: ['onboarding', 'state'],
    enabled,
    queryFn: () => getOnboardingState(as),
    retry: false,
  })
  const lan = useQuery({
    queryKey: ['onboarding', 'peers'],
    // WP271：① 个人收起了「加入一家公司」；WP276：点开「和同事一起用」才问
    enabled: enabled && (!solo || together),
    queryFn: () => listDiscoveryPeers(as),
    retry: false,
  })
  const invites = useQuery({
    queryKey: ['onboarding', 'invites'],
    // WP271：① 个人收起了「加入一家公司」；WP276：点开「和同事一起用」才问
    enabled: enabled && (!solo || together),
    queryFn: () => listInvites(as),
    retry: false,
  })
  const requests = useQuery({
    queryKey: ['onboarding', 'requests'],
    // WP271：① 个人收起了「加入一家公司」；WP276：点开「和同事一起用」才问
    enabled: enabled && (!solo || together),
    queryFn: () => listMembershipRequests(as),
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
      setReceipt(
        person === undefined || position === undefined
          ? null
          : { person, position, position_id: input.position_id },
      )
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
      body: { name: string; name_en?: string; roles: { role_id: string; default: boolean }[] }
    }) => updateOrgPosition(input.id, input.body, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  // WP174：岗位上级（下拉一改就存，写事件在服务端）
  const supervise = useMutation({
    mutationFn: (input: { id: string; person_id: string | null }) =>
      setOrgPositionSupervisor(input.id, input.person_id, owner),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  /**
   * WP234（docs/54 §6.4）：合并 / 移动职责 / 拆出。服务端回动了几条分配、几件事、并了几条
   * 岗位记忆——照实说一句，人知道「我的东西跟过去了」。
   */
  const [reshaped, setReshaped] = useState<string | undefined>(undefined)
  const sayReshaped = async (out: PositionReshapeView): Promise<void> => {
    setFailure(undefined)
    setReshaped(
      t('org.positions.reshaped', {
        n: String(out.moved_assignments),
        m: String(out.moved_matters),
      }) +
        (out.memory === undefined || out.memory.moved + out.memory.kept_both === 0
          ? ''
          : t('org.positions.reshaped.memory', {
              k: String(out.memory.moved + out.memory.kept_both),
              b: String(out.memory.kept_both),
            })) +
        (out.memory_copied === undefined || out.memory_copied === 0
          ? ''
          : t('org.positions.reshaped.copied', { k: String(out.memory_copied) })) +
        // WP235：目标是模板时另建了一个自建岗位，模板没动
        (() => {
          const made = out.positions.find((p) => p.id === out.created)
          return made === undefined ? '' : t('org.positions.reshaped.created', { name: made.name })
        })(),
    )
    await refresh()
  }
  const merge = useMutation({
    mutationFn: (input: { id: string; into: string; name: string }) =>
      mergeOrgPosition(input.id, input.into, owner, input.name),
    onSuccess: sayReshaped,
    onError: say,
  })
  const moveDuty = useMutation({
    mutationFn: (input: { id: string; role_id: string; to: string }) =>
      moveOrgPositionDuty(input.id, { role_id: input.role_id, to: input.to }, owner),
    onSuccess: sayReshaped,
    onError: say,
  })
  const split = useMutation({
    mutationFn: (input: { id: string; name: string; role_ids: string[] }) =>
      splitOrgPosition(input.id, { name: input.name, role_ids: input.role_ids }, owner),
    onSuccess: sayReshaped,
    onError: say,
  })
  /** WP234（docs/54 §6.5）：负责人转交（自己那条不收回）。 */
  const [handedTo, setHandedTo] = useState<string | undefined>(undefined)
  const handOver = useMutation({
    mutationFn: (person_id: string) => transferOwner(person_id, owner),
    onSuccess: async (out) => {
      setFailure(undefined)
      setHandedTo(out.person_name)
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
    mutationFn: (id: string) => copyRoleDefinition(id, undefined, as),
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
    }) => proposeRoleChange(input.id, input.patch, as),
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
    mutationFn: () => createInvite(undefined, as),
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
      decideMembershipRequest(input.id, { approve: input.approve }, as),
    onSuccess: async () => {
      setFailure(undefined)
      await refresh()
    },
    onError: say,
  })

  /** WP276：② 自己退出（发起人不行）——退完回到登录页。 */
  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspace ?? ''),
    onSuccess: () => {
      globalThis.location?.assign('/login')
    },
    onError: say,
  })
  /** WP276：导出我的副本（参与过的事、名下的待办）——存成一个 JSON 文件。 */
  const exportMine = useMutation({
    mutationFn: exportMyWork,
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'my-work.json'
      a.click()
      URL.revokeObjectURL(url)
    },
    onError: say,
  })
  /** WP276：① 点「和同事一起用」——打开局域网发现（决策 234），再展开邀请那一块。 */
  const startTogether = useMutation({
    mutationFn: async () => {
      if (orgId !== undefined) await turnOnDiscovery(orgId, owner)
    },
    onSettled: async () => {
      setTogether(true)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      await client.invalidateQueries({ queryKey: ['orgs'] })
    },
  })
  /*
   * WP278（决策 276 / 277）：② 里「请同事一起做」「把发起人交给…」都要对方接下才算——发出去的是一张
   * 「交给你」的卡；这里只记着我发出去的（还在等的那一行「等 X 接 · 撤回」）。
   */
  const peerOffers = useQuery({
    queryKey: [...PEER_OFFERS_KEY, as],
    queryFn: () => listPeerOffers(as),
    enabled: enabled && peers,
    retry: false,
  })
  const offers: PeerOfferView[] = peerOffers.data?.offers ?? []
  const refreshOffers = async (): Promise<void> => {
    setFailure(undefined)
    await client.invalidateQueries({ queryKey: PEER_OFFERS_KEY })
  }
  const offerPos = useMutation({
    mutationFn: (input: { position_id: string; person_id: string }) =>
      offerPosition(input.position_id, input.person_id, owner),
    onSuccess: async () => {
      setWizard(null)
      await refreshOffers()
    },
    onError: say,
  })
  const offerInit = useMutation({
    mutationFn: (person_id: string) => offerInitiator(person_id, owner),
    onSuccess: refreshOffers,
    onError: say,
  })
  const withdrawOffer = useMutation({
    mutationFn: (id: string) => withdrawPeerOffer(id, as),
    onSuccess: refreshOffers,
    onError: say,
  })
  /** WP276 → WP278：② 发起人「请同事一起做」——对方接下才分（不挑范围，② 里就是整个品牌）。 */
  const peerAssign = (position_id: string, person_id: string): void => {
    offerPos.mutate({ position_id, person_id })
  }

  // WP202：`?new=kol` 只在拿到岗位与职责清单后判一次
  const kolHandled = useRef(false)
  const [kolDraft, setKolDraft] = useState<PositionDraft | undefined>(undefined)
  useEffect(() => {
    if (!wantKol || kolHandled.current) return
    if (positions.data === undefined || roles.data === undefined) return
    kolHandled.current = true
    setTab('positions')
    const existing = positions.data.find(
      (p) => p.holders.length === 0 && p.roles.some((r) => r.role_id.startsWith('kol.')),
    )
    if (existing !== undefined) {
      setWizard(existing.id)
      return
    }
    const known = new Set(roles.data.map((r) => r.id))
    setKolDraft({
      name: t('org.positions.kol_preset'),
      roles: KOL_PRESET_ROLES.filter((id) => known.has(id)),
    })
  }, [wantKol, positions.data, roles.data, t])

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
    propose.isPending ||
    merge.isPending ||
    moveDuty.isPending ||
    split.isPending ||
    handOver.isPending ||
    leave.isPending ||
    exportMine.isPending ||
    startTogether.isPending ||
    offerPos.isPending ||
    offerInit.isPending ||
    withdrawOffer.isPending

  /** WP202：某张岗位卡下面就地展开的那一块——正在分的向导，或刚分完的回执。 */
  const below = (position_id: string): React.ReactNode => {
    // WP278：② 里请出去的——还在等的「等 X 接 · 撤回」，最近没接 / 退回的一行结果
    const sent = peers
      ? offers.filter((o) => o.kind === 'position' && o.position_id === position_id)
      : []
    const waitingFor = new Set(sent.filter((o) => o.state === 'offered').map((o) => o.to))
    // WP276：② 里「请同事一起做」只是挑一个同事（不挑范围，整个品牌）；WP278：对方接下才分
    if (wizard === position_id && peers) {
      const holders = new Set(
        (positions.data ?? []).find((x) => x.id === position_id)?.holders.map((h) => h.person_id),
      )
      const candidates = (members.data ?? []).filter(
        (m) => m.left_at === undefined && !holders.has(m.person_id) && !waitingFor.has(m.person_id),
      )
      return (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border p-3"
          data-testid="peer-assign"
        >
          {candidates.map((m) => (
            <Button
              key={m.person_id}
              size="sm"
              variant="outline"
              disabled={assign.isPending}
              onClick={() => {
                peerAssign(position_id, m.person_id)
              }}
            >
              {m.name}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setWizard(null)
            }}
          >
            {t('action.cancel')}
          </Button>
        </div>
      )
    }
    if (sent.length > 0)
      return (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="peer-offers">
          {sent.map((o) => (
            <li key={o.id} className="flex items-center gap-1" data-state={o.state}>
              {o.state === 'offered'
                ? t('team.offer.waiting', { name: o.to_name })
                : o.state === 'returned'
                  ? t('team.offer.returned', { name: o.to_name })
                  : o.reason === undefined
                    ? t('team.offer.declined', { name: o.to_name })
                    : t('team.offer.declined.reason', { name: o.to_name, reason: o.reason })}
              {o.state === 'offered' ? (
                <>
                  <span aria-hidden>·</span>
                  <Button
                    size="xs"
                    variant="link"
                    className="h-auto px-0"
                    disabled={withdrawOffer.isPending}
                    data-testid="peer-offer-withdraw"
                    onClick={() => {
                      withdrawOffer.mutate(o.id)
                    }}
                  >
                    {t('team.offer.withdraw')}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )
    if (wizard === position_id)
      return (
        <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="assign-inline">
          <p className="font-medium">{t('org.assign.title')}</p>
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
        </div>
      )
    if (receipt?.position_id === position_id)
      return (
        <div className="flex items-center gap-4 rounded-md border p-3" data-testid="assign-receipt">
          <BrandMark size={44} motion="split" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="ws-display text-[15px]">
              {tm('org.assign.receipt', { person: receipt.person, position: receipt.position })}
            </p>
            <p className="text-[12.5px] text-ws-muted-fg">{tm('org.assign.receipt.hint')}</p>
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
        </div>
      )
    return null
  }

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
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">{tm('org.title')}</h1>
          <p className="text-xs text-muted-foreground">{tm('org.subtitle')}</p>
        </div>
        {/* WP276（docs/95 §3.3，决策 234）：① 一行小入口——点了才打开局域网发现、出邀请那一块 */}
        {solo ? (
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid="together-entry"
              aria-expanded={together}
              disabled={startTogether.isPending}
              onClick={() => {
                if (together) setTogether(false)
                else startTogether.mutate()
              }}
            >
              {t('together.entry')}
            </Button>
            <Hint text={t('together.entry.hint')} />
          </span>
        ) : null}
      </div>
      {solo && together && myId !== undefined ? (
        <Card data-testid="together-panel">
          <CardContent className="pt-4">
            <JoinPanel
              collapsed
              {...(lan.data === undefined ? {} : { discovery: lan.data })}
              invites={invites.data ?? []}
              requests={requests.data ?? []}
              busy={busy}
              sent={joinSent}
              inviteLink={inviteLinkOf}
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
          </CardContent>
        </Card>
      ) : null}

      {/* WP234（docs/54 §6.5）：负责人是身份——在公司页顶上，不在左栏「岗位」里。
          WP271：① 个人收起（这里只有你一个人）；WP276：② 也收起（发起人只在「同事」里标一个小字） */}
      {!company
        ? null
        : (() => {
            const ownerRow = positions.data?.find((p) => p.id === OWNER_POSITION)
            const holders = ownerRow?.holders ?? []
            const live = (members.data ?? []).filter((m) => m.left_at === undefined)
            return (
              <OwnerCard
                title={ownerRow?.name ?? t('org.owner.title')}
                holders={holders.map((h) => ({ person_id: h.person_id, name: h.name }))}
                candidates={live
                  .filter((m) => !holders.some((h) => h.person_id === m.person_id))
                  .map((m) => ({ person_id: m.person_id, name: m.name }))}
                {...(owner === undefined ? {} : { settingsHref: `/positions/${owner}` })}
                busy={busy}
                {...(handedTo === undefined ? {} : { transferred: handedTo })}
                onTransfer={(person_id) => {
                  handOver.mutate(person_id)
                }}
              />
            )
          })()}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {/* 52 O2：品牌一览排在最前——公司页问的第一件事就是"这家公司有哪几个品牌" */}
          <TabsTrigger value="brands">{t('org.tab.brands')}</TabsTrigger>
          <TabsTrigger value="positions">{t('org.tab.positions')}</TabsTrigger>
          {/* WP276：② 团队页——「同事」代替成员 / 加入公司；范围、并进来不出 */}
          {peers ? <TabsTrigger value="colleagues">{t('team.tab.colleagues')}</TabsTrigger> : null}
          {!company ? null : (
            <>
              <TabsTrigger value="members">{t('org.tab.members')}</TabsTrigger>
              <TabsTrigger value="ranges">{t('org.tab.ranges')}</TabsTrigger>
              <TabsTrigger value="invite">{t('onboarding.join.title')}</TabsTrigger>
              <TabsTrigger value="join">{t('org.tab.join')}</TabsTrigger>
            </>
          )}
          <TabsTrigger value="toolbox">{t('org.tab.toolbox')}</TabsTrigger>
          {solo ? null : <TabsTrigger value="inprogress">{t('org.tab.inprogress')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="brands" className="pt-3">
          <BrandsTab
            {...(orgId === undefined ? {} : { org_id: orgId })}
            {...(owner === undefined ? {} : { assignment: owner })}
            {...(haltAs === undefined ? {} : { haltAssignment: haltAs })}
          />
          {/* WP208：设计规范从第三栏搬来——每个品牌一份，看的是当前品牌那一份 */}
          <div className="pt-4">
            <BrandDesignCard />
          </div>
          {/* WP268：品牌素材库（AI 出的图、传进来的图、店里商品图） */}
          <div className="pt-4">
            <BrandAssetsCard />
          </div>
          {/* WP224：毛利率（品牌事实里的一格）——投放面板的盈亏线从这里算 */}
          <div className="pt-4">
            <GrossMarginCard {...(owner === undefined ? {} : { assignment: owner })} />
          </div>
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
              {...(wizard === null ? {} : { assigning: wizard })}
              below={below}
              {...(kolDraft === undefined ? {} : { draft: kolDraft })}
              {...(solo || owner !== undefined
                ? {
                    onAssign: (id: string) => {
                      setFailure(undefined)
                      setReceipt(null)
                      /*
                       * WP271：① 个人没有「分给同事」——按钮叫「我来做」，点了直接分给自己，
                       * 不挑范围（服务端在 ① 里落成整个品牌）
                       */
                      if (solo) {
                        if (myId !== undefined)
                          assign.mutate({
                            person_id: myId,
                            position_id: id,
                            ranges: [],
                            range_groups: [],
                          })
                        return
                      }
                      // 再点一次同一张卡的「分给同事」= 收起
                      setWizard((current) => (current === id ? null : id))
                    },
                  }
                : {})}
              onCreate={(input) => {
                create.mutate(input)
              }}
              onSaveRoles={(id, body) => {
                update.mutate({ id, body })
              }}
              people={(members.data ?? [])
                .filter((m) => m.left_at === undefined)
                .map((m) => ({ person_id: m.person_id, name: m.name }))}
              // WP271：「上级：不设（转老板）」只在 ③ 公司集体（① ② 没有上下级）
              {...(!company
                ? {}
                : {
                    onSupervisor: (id: string, person_id: string | null) => {
                      supervise.mutate({ id, person_id })
                    },
                  })}
              onRename={(id, input) => {
                // WP196：只改名——职责原样带回去（连「可选」那几条的勾选也不动），服务端就不当改模板
                const current = positions.data?.find((p) => p.id === id)
                if (current === undefined) return
                update.mutate({
                  id,
                  body: {
                    ...input,
                    roles: current.roles.map((r) => ({ role_id: r.role_id, default: r.default })),
                  },
                })
              }}
              // WP276（决策 274 第 3 条）：② 里同事能改规矩、不能删岗位（删是发起人的家务）
              {...(owner === undefined
                ? {}
                : {
                    onDelete: (id: string) => {
                      drop.mutate(id)
                    },
                  })}
              onCopyRole={(id) => {
                copy.mutate(id)
              }}
              onProposeRole={(id, patch) => {
                propose.mutate({ id, patch })
              }}
              // WP234（docs/54 §6.4）：合并到… / 移动职责 / 拆出…
              onMerge={(id, into, name) => {
                merge.mutate({ id, into, name })
              }}
              onMoveDuty={(id, role_id, to) => {
                moveDuty.mutate({ id, role_id, to })
              }}
              onSplit={(id, input) => {
                split.mutate({ id, ...input })
              }}
              {...(reshaped === undefined ? {} : { notice: reshaped })}
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
              {...(lan.data === undefined ? {} : { discovery: lan.data })}
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
          <ToolboxTab assignment={as} {...(query === null ? {} : { initialQuery: query })} />
        </TabsContent>

        {/* WP276：② 团队页「同事」——名单带忙闲、请同事一起用、想一起用的人、数据放哪、退出 */}
        {peers ? (
          <TabsContent value="colleagues" className="pt-3">
            <ColleaguesTab
              me={myId}
              initiator={initiator}
              members={members.data ?? []}
              invites={invites.data ?? []}
              requests={requests.data ?? []}
              busy={busy}
              {...(failure === undefined || wizard !== null ? {} : { error: failure })}
              onCreateInvite={() => {
                newInvite.mutate()
              }}
              onDecide={(id, approve) => {
                decide.mutate({ id, approve })
              }}
              onRemove={(person_id, name) => {
                if (globalThis.confirm?.(t('team.remove.confirm', { name })) === false) return
                remove.mutate(person_id)
              }}
              // WP278：退出先问一句（框在同事 tab 里：列出会断开的个人连接），这里只管真的退
              onLeave={() => {
                leave.mutate()
              }}
              workspaceId={workspace}
              offers={offers}
              onOfferInitiator={(person_id) => {
                offerInit.mutate(person_id)
              }}
              onWithdrawOffer={(id) => {
                withdrawOffer.mutate(id)
              }}
              onExport={() => {
                exportMine.mutate()
              }}
            />
          </TabsContent>
        ) : null}

        {/* 40 §3.3 进行中看板：自己取数，页面这边只多这一行 */}
        <TabsContent value="inprogress" className="pt-3">
          <InprogressTab />
        </TabsContent>
      </Tabs>
      {/* WP277：团队页底部一行小字——发起人「开公司模式…」/ ③ 里老板「回到同事互联…」 */}
      {solo ? null : <CompanyModeEntry className="justify-end pt-2" />}
    </div>
  )
}
