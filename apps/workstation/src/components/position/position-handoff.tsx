/**
 * 岗位页的输入框（WP241「交给它」→ WP287 Luoye 10-09 真机后重做）。
 *
 * - **和事项页 / 随便聊同一个输入框**（`MatterComposer`：发送是框内的箭头，不写「交给它」；
 *   有合适的建议时浅灰字 + Tab 收下；「+」「@」同一套）。这里发出去就是开一段会话。
 * - WP291（决策 356）：发出去服务端三分——**当场问答**就在框下面答（`QuickAnswer`：一句话 + 组件）；
 *   **会话 / 任务**马上进它的线程。框里的字发出去就清，等回答时框下出「…」。
 * - 不让人选职责（WP287 第 2 条）：原来那个「职责：自动」下拉去掉了，岗位自己按分 / 先后取，线程里能「换一条」。
 * - 下面一排快捷按钮（WP372 决策 1019：按状态现出、最多 6 个、点了直接打开对应卡或直接发出去，开始对话后收起）。
 *
 * WP357（Luoye 10-16 真机：Excel 拖进来没反应）：这个框也能附资料（.txt / .md / .docx / .pdf / .xlsx / .csv，
 * 拖进来、点「+」、粘贴文件都行，与助理同一套）；附件跟着这句话交出去，开出来的事项第一句话上带着它，
 * 运行拿到「话 + 附件」。只附不说话时用「看一下附上的资料：…」当这句话。
 *
 * `hero`：新岗位、什么都还没有时（`position-v2-empty.html`），它放大当主角。
 *
 * **WP412（真机 10-18 #12）**：职责页也用这一个对话框（给 `role_id`）——发出去钉到这条职责
 * （服务端照样三分），快捷按钮只取这条职责的提示，当场回答只出在这条职责上问的。
 *
 * **WP437（Luoye 10-21）**：挪到中栏底部居中、悬浮在内容之上——页面把它放在内容最后（根加 `DOCK_PAGE`）。
 */
import { useCallback, useRef, useState } from 'react'
import { AskSuggestions, useComposerRefs } from '@/components/ask-ai/composer-refs'
import { ComposerModelPicker } from '@/components/free-chat/model-picker'
import { MatterComposer } from '@/components/matter/matter-composer'
import { useAttachedDocs } from '@/components/matter/use-attached-docs'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { ComposerDock } from '@/components/shell/composer-dock'
import { Button } from '@/components/ui/button'
import { HandoffError } from '@/components/work/handoff-error'
import { usePositionOpen } from '@/components/work/use-position-open'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useComposerPrefill } from '@/lib/composer-prefill'
import type { ReasoningEffort } from '@/lib/free-chat'
import { TASK_TEXT_MAX } from '@/lib/handoff'
import { LandingActions, useLandingActions } from './landing-actions'
import { QuickAnswer } from './quick-answer'

const MAX_SUGGESTIONS = 4

export function PositionHandoff({
  id,
  view,
  hero = false,
  role_id,
}: {
  id: string
  view: PositionInstanceData
  hero?: boolean
  /** WP412：职责页上用——钉到这条职责。 */
  role_id?: string
}): React.ReactNode {
  const { t, lang } = useApp()
  const [text, setText] = useState('')
  /** WP342：这次交出去用哪个 AI（不选 = 品牌默认）；开出来的事项记着它，之后接着跑仍用它。 */
  const [model, setModel] = useState<string | undefined>(undefined)
  /** WP370：连同模型一起选的思考程度（换模型就清掉）。 */
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(undefined)
  const attached = useAttachedDocs()
  const { open, pick, choice, error, clearError } = usePositionOpen(id, () => {
    setText('')
  })
  /*
   * WP504（决策 1775 A）：第三栏点 ✦「问 AI」的卡落在这个框里（引用小卡 + 建议问题 + `@` 搜 + 拖进来）；
   * 发出去时引用按结构化摘要随这句话交给服务端，发完清掉。
   */
  const area = useRef<HTMLTextAreaElement>(null)
  const asked = useComposerRefs({
    area,
    onChange: (v) => {
      setText(v.slice(0, TASK_TEXT_MAX))
      clearError()
    },
  })

  /*
   * WP509：深链 `?ask=…`（插件「数据同步」→ 红人营销岗位，预填「把红人同步到我的飞书表」）与页面里的「去设同步」
   * 都把一句话填进这个框（不发出去），光标放进框里等人贴链接。
   */
  useComposerPrefill(
    useCallback((prefill: string) => {
      setText(prefill.slice(0, TASK_TEXT_MAX))
      requestAnimationFrame(() => {
        const el = area.current
        if (el === null) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    }, []),
  )

  const mine = view.roles.filter(
    (r) => r.my_assignment_id !== undefined && (role_id === undefined || r.role_id === role_id),
  )
  const pin = role_id === undefined ? {} : { role_id }
  // 建议只从本人那几条职责来（54 §1：拿别人那条去开就是借岗位扩权）
  const suggestions = mine.flatMap((r) => r.quick_prompts ?? []).slice(0, MAX_SUGGESTIONS)
  /** WP372（决策 1019）：开始对话后快捷按钮收起（这一页还开着就不再出）。 */
  const [started, setStarted] = useState(false)
  /*
   * WP416 / WP419 / WP420（自查 kol U13、社媒 U1、投放）：几条职责的快捷按钮同名（红人五条渠道各一个
   * 「找一批红人」、Google / Meta 都有「今天花了多少」）只留第一个——去重只在一处做：
   * `useLandingActions` 里的 `uniqueByLabel`（landing-actions.tsx）。
   */
  const actions = useLandingActions(
    mine
      .flatMap((r) => r.quick_prompts ?? [])
      .map((q) => ({
        id: q.id,
        label: lang === 'en' ? q.label.en : q.label.zh,
        prompt: q.prompt,
      })),
    (prompt) => {
      clearError()
      setStarted(true)
      // WP421（自查 general 2.5）：快捷按钮开的事项也带上已选的思考档（以前只带模型）
      open.mutate({
        title: prompt.slice(0, TASK_TEXT_MAX),
        model,
        ...(effort === undefined ? {} : { effort }),
        files: [],
        ...pin,
      })
    },
  )

  const submit = (): void => {
    const typed = text.trim().slice(0, TASK_TEXT_MAX)
    // WP357：只附了资料没说话——这句话就是「看一下附上的资料：…」
    const docs = attached.docs
    const title =
      typed !== '' || docs.length === 0
        ? typed
        : t('matter.file.only', { names: docs.map((d) => `「${d.name}」`).join('') })
    // WP291：等回答时不锁框（回答在框下出「…」）
    if (title === '') return
    clearError()
    setStarted(true)
    const files = attached.take().map((d) => ({ name: d.name, data: d.data }))
    const context = asked.payload()
    asked.clear()
    open.mutate(
      {
        title,
        model,
        ...(effort === undefined ? {} : { effort }),
        files,
        ...pin,
        ...(context === undefined ? {} : { context }),
      },
      {
        // WP259：没交出去，字放回框里（框下说一句人话）；WP357：附件也放回去
        onError: () => {
          setText((now) => (now === '' ? typed : now))
          attached.restore(docs)
        },
      },
    )
  }

  const composer = (
    <MatterComposer
      value={text}
      onChange={asked.onChange}
      onSend={submit}
      onStop={() => undefined}
      running={false}
      closed={false}
      // 有合适的建议时浅灰字显示在框里，Tab 收下（与事项页同一个规矩）
      suggestion={suggestions[0]?.prompt}
      sending={false}
      docked={false}
      placeholderText={t(hero ? 'pos2.handoff.first.ask' : 'pos2.handoff.ask')}
      label={t(role_id === undefined ? 'position.entry.title' : 'duty.entry.title')}
      testId="position-entry-input"
      modelSlot={
        <ComposerModelPicker
          value={model}
          onChange={(next) => {
            setModel(next)
            setEffort(undefined)
          }}
          effort={effort}
          onEffortChange={(next, picked) => {
            setModel(picked)
            setEffort(next)
          }}
        />
      }
      // WP357：附资料（拖进来 / 「+」/ 粘贴文件）
      docs={attached.docs}
      onAttachDocs={attached.add}
      onDetachDoc={attached.remove}
      docProblem={attached.problem}
      askTarget
      areaRef={area}
      chips={asked.chips}
      overlay={asked.overlay}
      onKeyDownFirst={asked.onKeyDownFirst}
      onRefDrop={asked.onRefDrop}
      // 有引用时占位词换成「问问这位…」那一类（F4b）
      {...(asked.refs.length === 0 ? {} : { placeholderText: t('ask_ai.placeholder') })}
    />
  )
  /** 点一个建议问题 = 直接问（带着引用）。 */
  const askNow = (q: string): void => {
    const context = asked.payload()
    asked.clear()
    clearError()
    setStarted(true)
    open.mutate({
      title: q.slice(0, TASK_TEXT_MAX),
      model,
      ...(effort === undefined ? {} : { effort }),
      files: [],
      ...pin,
      ...(context === undefined ? {} : { context }),
    })
  }

  /*
   * WP437（Luoye 10-21）：对话框挪到**中栏底部居中**、悬浮在内容之上（`ComposerDock`）；这个组件放在页面内容的最后。
   * 框上面贴着：当场回答（问了一句就在框上面答，能滚、右上角关）、老服务端的「走哪条职责」、
   * 快捷按钮（开始对话后收起）、没发出去那句话。（Luoye 10-22：框上面不再放「交给它第一件事」标题和说明。）
   */
  return (
    <ComposerDock
      testId="position-handoff"
      data={{ 'data-hero': hero ? 'true' : 'false', 'data-role': role_id }}
      above={
        <>
          {/* WP291：当场回答（会话 / 任务这里不画，直接进线程） */}
          <div
            className="max-h-[45vh] overflow-y-auto rounded-2xl ws-composer-glass p-2 empty:hidden"
            data-testid="position-answer-slot"
          >
            <QuickAnswer position={id} {...pin} />
          </div>
          {/* 老服务端还可能回一张「走哪条职责」——那时把候选摆出来（新服务端不再出） */}
          {choice === undefined ? null : (
            <fieldset className="rounded-xl ws-composer-glass p-3" data-testid="route-choice">
              <p className="flex items-center gap-1 text-sm" data-slot="status">
                {choice.reason}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {choice.candidates.map((c) => (
                  <Button
                    key={c.role_id}
                    size="xs"
                    variant="outline"
                    data-testid="route-choice-option"
                    disabled={pick.isPending}
                    onClick={() => {
                      pick.mutate({ matter_id: choice.matter.id, role_id: c.role_id })
                    }}
                  >
                    <DutyIcon role_id={c.role_id} size={14} />
                    {c.role_name}
                  </Button>
                ))}
              </div>
            </fieldset>
          )}
          {/*
            WP372（决策 1019）：快捷按钮按状态现出（看新报表 / 等你的对话 / 去连接 + 这个岗位自己的提示），
            最多 6 个，点了直接打开那张卡或直接发出去；开始对话后收起。
          */}
          {/* WP504：有引用时上面换成按这几张卡出的建议问题（F4b），没有才是这一页的快捷按钮 */}
          {asked.refs.length > 0 ? (
            <AskSuggestions items={asked.suggestions} onPick={askNow} />
          ) : started ? null : (
            <LandingActions actions={actions} />
          )}
          {/* WP259：没发出去就在框上说一句（含服务端那句话），不再静默 */}
          <HandoffError error={error} />
        </>
      }
    >
      {composer}
    </ComposerDock>
  )
}
