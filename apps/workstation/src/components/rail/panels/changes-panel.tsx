/**
 * WP95（`docs/upstream/sidebar-compare.md` #11）：**变更审阅——逐文件看改了哪几行**。
 *
 * 这是那份 18 条对照里唯一一条"现在就缺、而且缺得明显"的：建站职责跑完一轮，
 * 人看得见"要不要发布"（`publish_theme` 那张卡），看不见"这一轮到底改了哪几个
 * liquid 的哪几行"。点开这一栏就看得见了。
 *
 * **形借官方，体是我们自己的**（不借的三条实测理由在 `sidebar-compare.md` §4）：
 * 来源是 WP89 的主题工作副本目录——那是个 git 仓，`git diff` 一跑就有，
 * 而且它活得比一次运行长（官方那一侧摘要活到 Session 销毁为止）。
 *
 * **这一栏不改文件**（官方那一侧也只是审阅）。第三栏是"看着什么决定"，
 * 决定本身在卡片上：批 / 驳走审批项，撤回 / 反向走 15 §7 那两条。
 * 在一个 380 宽的抽屉里放一个能改线上主题的编辑器，是把审批整条绕开。
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { PanelError } from '@/components/rail/panel-error'
import { parseMatterPath } from '@/components/rail/rail-layout'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Skeleton } from '@/components/ui/skeleton'
import { getChangeFiles, getMatter, listChanges } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 这一栏认得的变更种类：改主题的那些（别的变更没有"逐文件"这回事）。 */
const FILE_KINDS = new Set(['publish_theme', 'deploy', 'merge_pr'])

/** 一条 diff 正文按行上色：`+` 绿、`-` 红、`@@` 灰。 */
function DiffBody({ diff }: { diff: string }): ReactNode {
  return (
    <pre className="max-h-80 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-4">
      {diff.split('\n').map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 的行没有 id——行号**就是**它在这一段里的身份，而且这一段只读、不排序、不增删
          key={`${i}-${line.slice(0, 12)}`}
          className={cn(
            line.startsWith('+') && !line.startsWith('+++') && 'text-emerald-600',
            line.startsWith('-') && !line.startsWith('---') && 'text-red-600',
            line.startsWith('@@') && 'text-muted-foreground',
          )}
        >
          {line === '' ? ' ' : line}
        </div>
      ))}
    </pre>
  )
}

function ChangeFiles({ change_id }: { change_id: string }): ReactNode {
  const { t } = useApp()
  const [openPath, setOpenPath] = useState<string | null>(null)
  const files = useQuery({
    queryKey: ['change-files', change_id],
    queryFn: () => getChangeFiles(change_id),
  })
  if (files.isPending) return <Skeleton className="h-20 w-full" />
  if (files.error !== null) return <PanelError error={files.error} />
  const view = files.data
  if (!view.available)
    return (
      <p className="text-xs text-muted-foreground" data-testid="rail-changes-unavailable">
        {view.detail ?? t('rail.changes.unavailable')}
      </p>
    )
  if (view.files.length === 0)
    return (
      <p className="text-xs text-muted-foreground" data-testid="rail-changes-empty-files">
        {t('rail.changes.no_files')}
      </p>
    )
  return (
    <ul className="space-y-1" data-testid={`rail-changes-files-${change_id}`}>
      {view.files.map((f) => {
        const open = openPath === f.path
        return (
          <li key={f.path}>
            <button
              type="button"
              aria-expanded={open}
              data-testid={`rail-changes-file-${f.path}`}
              className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
              onClick={() => {
                setOpenPath(open ? null : f.path)
              }}
            >
              {open ? (
                <ChevronDown aria-hidden className="size-3 shrink-0" />
              ) : (
                <ChevronRight aria-hidden className="size-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              <span className="shrink-0 text-emerald-600">+{f.additions}</span>
              <span className="shrink-0 text-red-600">-{f.deletions}</span>
            </button>
            {open ? (
              <div className="pl-4">
                {/*
                  行对比超时降级成"整文件替换"时**要说出来**——不说的话
                  人会以为这个文件真的被整个重写了（官方那条 `coarse` 同理）
                */}
                {f.coarse ? (
                  <p className="text-xs text-muted-foreground" data-testid="rail-changes-coarse">
                    {t('rail.changes.coarse')}
                  </p>
                ) : f.binary ? (
                  <p className="text-xs text-muted-foreground">{t('rail.changes.binary')}</p>
                ) : (
                  <>
                    <DiffBody diff={f.diff} />
                    {f.truncated ? (
                      <p className="text-xs text-muted-foreground">{t('rail.changes.truncated')}</p>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </li>
        )
      })}
      {view.truncated ? (
        <li className="text-xs text-muted-foreground">{t('rail.changes.too_many')}</li>
      ) : null}
    </ul>
  )
}

export function ChangesPanel({ pathname }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const [openChange, setOpenChange] = useState<string | null>(null)
  const matter_id = parseMatterPath(pathname)

  // 事项 → 最近一次运行 → 那次运行落下的变更。与「运行中的浏览器」同一条路：
  // 时间线本来就带 `run_id`，不为第三栏在服务端新开一条路由。
  const matter = useQuery({
    queryKey: ['matter', matter_id],
    queryFn: () => getMatter(matter_id as string),
    enabled: matter_id !== undefined,
  })
  const run_id = matter.data?.timeline.filter((e) => e.run_id !== undefined).at(-1)?.run_id
  const changes = useQuery({
    queryKey: ['changes', run_id],
    queryFn: () => listChanges({ run: run_id as string }),
    enabled: run_id !== undefined,
  })

  if (matter_id === undefined)
    return (
      <p className="text-muted-foreground" data-testid="rail-changes-no-matter">
        {t('rail.changes.no_matter')}
      </p>
    )
  if (matter.isPending) return <Skeleton className="h-24 w-full" />
  if (matter.error !== null) return <PanelError error={matter.error} />
  if (run_id === undefined)
    return (
      <p className="text-muted-foreground" data-testid="rail-changes-no-run">
        {t('rail.changes.no_run')}
      </p>
    )
  if (changes.isPending) return <Skeleton className="h-24 w-full" />
  if (changes.error !== null) return <PanelError error={changes.error} />

  const rows = changes.data.filter((c) => FILE_KINDS.has(c.kind))
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground" data-testid="rail-changes-empty">
        {t('rail.changes.empty')}
      </p>
    )

  return (
    <div className="space-y-2" data-testid="rail-changes">
      <p className="text-xs text-muted-foreground">{t('rail.changes.hint')}</p>
      <ul className="space-y-2">
        {rows.map((c) => {
          const open = openChange === c.id
          return (
            <li key={c.id} className="rounded-md border p-2">
              <button
                type="button"
                aria-expanded={open}
                data-testid={`rail-changes-item-${c.id}`}
                className="flex w-full items-center gap-1 text-left"
                onClick={() => {
                  setOpenChange(open ? null : c.id)
                }}
              >
                {open ? (
                  <ChevronDown aria-hidden className="size-3 shrink-0" />
                ) : (
                  <ChevronRight aria-hidden className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {t(`rail.changes.kind.${c.kind}`)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(`rail.changes.status.${c.status}`)}
                </span>
              </button>
              {open ? (
                <div className="mt-2">
                  <ChangeFiles change_id={c.id} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
