/**
 * 会议页（37 §4）：信息 + 记录（六种来源）+ 一键录音 / 粘贴 / 上传 + 处理进度 + 产出四栏。
 *
 * 三条纪律：
 * - **一键录音用浏览器的 MediaRecorder**：Electron 壳与浏览器走同一条路，不依赖原生桥。
 *   拿不到 `mediaDevices` 的环境（无痕、没授权、jsdom）就把按钮禁掉并说明，不报错。
 * - **音频只上行**：录完的字节 POST 到 `/v1/meetings/:id/records`，页面不留、也不回读。
 * - **产出每条都能一键发卡**：待办 → 认领卡（本人确认前不形成责任），边界 → 策略确认，
 *   知识 → 知识确认。卡片本身由服务端建，前端只发请求。
 */
import type { Meeting, MeetingOutputs, MeetingRecord } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Mic, Square, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  addMeetingRecord,
  exportMeeting,
  getMeeting,
  getMeetingOutputs,
  type MeetingSystemCard,
  processMeetingRecord,
  type SendCardInput,
  sendMeetingCard,
  toBase64,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 浏览器有没有录音能力（Electron 壳里同样走这条判断）。 */
export function canRecord(): boolean {
  return (
    typeof globalThis.MediaRecorder !== 'undefined' &&
    globalThis.navigator?.mediaDevices?.getUserMedia !== undefined
  )
}

function SourceBadge({ source }: { source: MeetingRecord['source'] }): React.ReactNode {
  const { t } = useApp()
  return (
    <Badge variant="outline" className="text-[11px]">
      {t(`meeting.source.${source}`)}
    </Badge>
  )
}

function RecordRow({
  record,
  busy,
  onProcess,
}: {
  record: MeetingRecord
  busy: boolean
  onProcess(): void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-2.5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <SourceBadge source={record.source} />
          <Badge variant="secondary" className="text-[11px]">
            {t(`meeting.record.status.${record.status}`)}
          </Badge>
          {record.consent.notice_given ? null : (
            <Badge variant="outline" className="text-[11px]">
              {t('meeting.record.no_notice')}
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {record.transcript === undefined
            ? t('meeting.record.no_transcript')
            : record.transcript.text.slice(0, 90)}
        </p>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={onProcess}>
        {busy ? t('meeting.processing') : t('meeting.process')}
      </Button>
    </div>
  )
}

interface SendFn {
  (input: SendCardInput): void
  sent: Set<string>
  busy: boolean
}

function OutputsColumns({
  outputs,
  send,
}: {
  outputs: MeetingOutputs[]
  send: SendFn
}): React.ReactNode {
  const { t } = useApp()
  const decisions = outputs.flatMap((o) => o.decisions.map((d) => ({ ...d, rid: o.record_id })))
  const todos = outputs.flatMap((o) => o.todos.map((x) => ({ ...x, rid: o.record_id })))
  const boundaries = outputs.flatMap((o) =>
    o.boundary_answers.map((x) => ({ ...x, rid: o.record_id })),
  )
  const knowledge = outputs.flatMap((o) => o.knowledge.map((x) => ({ ...x, rid: o.record_id })))

  /** 每条产出的一键发卡按钮；发过一次就变成"已发出"，避免重复问同一句话。 */
  const sendButton = (
    rid: string,
    kind: SendCardInput['kind'],
    item_id: string,
    label: string,
  ): React.ReactNode =>
    send.sent.has(item_id) ? (
      <span className="text-[11px] text-muted-foreground">{t('meeting.card.sent')}</span>
    ) : (
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={send.busy}
        onClick={() => {
          send({ record_id: rid, kind, item_id })
        }}
      >
        {label}
      </Button>
    )

  const column = (title: string, empty: string, rows: React.ReactNode[]): React.ReactNode => (
    <Card key={title} className="min-w-0 flex-1">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {rows.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : rows}
      </CardContent>
    </Card>
  )

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      {column(
        t('meeting.outputs.decisions'),
        t('meeting.outputs.empty'),
        decisions.map((d) => (
          <div key={d.id} className="rounded-md bg-muted/40 p-2">
            <p>{d.text}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">「{d.provenance.quote}」</p>
          </div>
        )),
      )}
      {column(
        t('meeting.outputs.todos'),
        t('meeting.outputs.empty'),
        todos.map((todo) => (
          <div key={todo.id} className="rounded-md bg-muted/40 p-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[11px]">
                {t(`meeting.speech.${todo.speech_state}`)}
              </Badge>
              <span className="min-w-0 truncate">{todo.text}</span>
            </div>
            {todo.assignee_hint === undefined ? null : (
              <p className="mt-1 text-[11px] text-muted-foreground">→ {todo.assignee_hint}</p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">「{todo.provenance.quote}」</p>
            <div className="mt-1.5">
              {sendButton(todo.rid, 'claim', todo.id, t('meeting.card.claim'))}
            </div>
          </div>
        )),
      )}
      {column(
        t('meeting.outputs.boundaries'),
        t('meeting.outputs.empty'),
        boundaries.map((b) => (
          <div key={b.id} className="rounded-md bg-muted/40 p-2">
            <p>{b.question}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{b.answer}</p>
            <div className="mt-1.5">
              {sendButton(b.rid, 'policy_change', b.id, t('meeting.card.policy'))}
            </div>
          </div>
        )),
      )}
      {column(
        t('meeting.outputs.knowledge'),
        t('meeting.outputs.empty'),
        knowledge.map((k) => (
          <div key={k.id} className="rounded-md bg-muted/40 p-2">
            <p>{k.statement}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {k.hold_reasons.length === 0
                ? t('meeting.knowledge.auto')
                : t('meeting.knowledge.hold')}
            </p>
            <div className="mt-1.5">
              {sendButton(k.rid, 'knowledge_update', k.id, t('meeting.card.knowledge'))}
            </div>
          </div>
        )),
      )}
    </div>
  )
}

export function MeetingPage(): React.ReactNode {
  const { t } = useApp()
  const { id = '' } = useParams()
  const client = useQueryClient()
  const [pasted, setPasted] = useState('')
  const [recording, setRecording] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [card, setCard] = useState<MeetingSystemCard | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  const detail = useQuery({ queryKey: ['meeting', id], queryFn: () => getMeeting(id) })
  const outputs = useQuery({
    queryKey: ['meeting-outputs', id],
    queryFn: () => getMeetingOutputs(id),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['meeting', id] })
    void client.invalidateQueries({ queryKey: ['meeting-outputs', id] })
  }

  const addRecord = useMutation({
    mutationFn: (input: Parameters<typeof addMeetingRecord>[1]) => addMeetingRecord(id, input),
    onSuccess: () => {
      setPasted('')
      refresh()
    },
  })

  const process = useMutation({
    mutationFn: (rid: string) => processMeetingRecord(id, rid),
    onSuccess: (result) => {
      setCard(result.system_card ?? null)
      setNote(
        result.outputs === undefined
          ? null
          : t('meeting.processed.note', {
              d: result.outputs.decisions.length,
              todos: result.outputs.todos.length,
              claims: result.approvals?.claims.length ?? 0,
            }),
      )
      refresh()
    },
  })

  const [sent, setSent] = useState<Set<string>>(new Set())
  const sendCard = useMutation({
    mutationFn: (input: SendCardInput) => sendMeetingCard(id, input),
    onSuccess: (result, input) => {
      setSent((prev) => new Set(prev).add(input.item_id))
      setNote(t('meeting.card.sent.note', { title: result.title }))
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })
  const send = Object.assign(
    (input: SendCardInput) => {
      sendCard.mutate(input)
    },
    { sent, busy: sendCard.isPending },
  )

  const exportMd = useMutation({
    mutationFn: () => exportMeeting(id),
    onSuccess: (file) => {
      setNote(file.content.split('\n').slice(0, 2).join(' '))
    },
  })

  // 页面卸载时一定要把麦克风轨道停掉，否则录音指示灯一直亮
  useEffect(
    () => () => {
      recorder.current?.stream.getTracks().forEach((track) => {
        track.stop()
      })
    },
    [],
  )

  const startRecording = async (): Promise<void> => {
    if (!canRecord()) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream)
    chunks.current = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data)
    }
    rec.onstop = () => {
      for (const track of stream.getTracks()) track.stop()
      void (async () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        addRecord.mutate({
          source: 'in_app_recording',
          audio_base64: toBase64(bytes),
          mime: blob.type,
          name: 'recording.webm',
          notice_given: true,
          final: true,
        })
      })()
    }
    recorder.current = rec
    rec.start()
    setRecording(true)
  }

  const stopRecording = (): void => {
    recorder.current?.stop()
    recorder.current = null
    setRecording(false)
  }

  if (detail.isPending) return <Skeleton className="h-64 w-full" />
  const meeting = detail.data?.meeting as Meeting | undefined
  if (meeting === undefined)
    return <p className="text-sm text-muted-foreground">{t('meeting.missing')}</p>
  const records = detail.data?.records ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-sm font-semibold">{meeting.title}</h1>
          <p className="text-xs text-muted-foreground">
            {meeting.start.replace('T', ' ').slice(0, 16)} ·{' '}
            {meeting.participants
              .map(
                (p) =>
                  `${p.name ?? p.email ?? ''}${p.external === true ? `（${t('meeting.external')}）` : ''}`,
              )
              .join('、')}
            {' · '}
            {t(`sensitivity.${meeting.sensitivity}`)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            exportMd.mutate()
          }}
        >
          <Download aria-hidden />
          {t('meeting.export')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('meeting.add_record')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {recording ? (
              <Button size="sm" variant="destructive" onClick={stopRecording}>
                <Square aria-hidden />
                {t('meeting.record.stop')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canRecord()}
                onClick={() => {
                  void startRecording()
                }}
              >
                <Mic aria-hidden />
                {t('meeting.record.start')}
              </Button>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm">
              <Upload aria-hidden className="size-4" />
              {t('meeting.upload')}
              <input
                type="file"
                className="hidden"
                aria-label={t('meeting.upload')}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file === undefined) return
                  void (async () => {
                    const bytes = new Uint8Array(await file.arrayBuffer())
                    const isText =
                      /^(text\/|application\/json)/.test(file.type) ||
                      /\.(txt|md|srt|vtt)$/i.test(file.name)
                    addRecord.mutate(
                      isText
                        ? {
                            source: 'third_party',
                            text: new TextDecoder().decode(bytes),
                            name: file.name,
                            notice_given: true,
                          }
                        : {
                            source: 'device',
                            audio_base64: toBase64(bytes),
                            mime: file.type || 'audio/mpeg',
                            name: file.name,
                            notice_given: true,
                          },
                    )
                  })()
                }}
              />
            </label>
            {canRecord() ? null : (
              <span className="text-xs text-muted-foreground">
                {t('meeting.record.unavailable')}
              </span>
            )}
          </div>
          <Textarea
            aria-label={t('meeting.paste')}
            placeholder={t('meeting.paste.hint')}
            value={pasted}
            rows={4}
            onChange={(e) => {
              setPasted(e.target.value)
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pasted.trim() === '' || addRecord.isPending}
              onClick={() => {
                addRecord.mutate({ source: 'handed_over', text: pasted, notice_given: true })
              }}
            >
              {t('meeting.paste.submit')}
            </Button>
            {addRecord.error === null ? null : (
              <span role="alert" className="text-xs text-destructive">
                {addRecord.error.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {card === null ? null : (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle className="text-sm">{card.title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">{card.body}</p>
            <div className="flex gap-2">
              {card.actions.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCard(null)
                  }}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('meeting.records')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('meeting.records.empty')}</p>
          ) : (
            records.map((r) => (
              <RecordRow
                key={r.id}
                record={r}
                busy={process.isPending && process.variables === r.id}
                onProcess={() => {
                  process.mutate(r.id)
                }}
              />
            ))
          )}
          {note === null ? null : (
            <>
              <Separator />
              <p className="text-xs text-muted-foreground">{note}</p>
            </>
          )}
        </CardContent>
      </Card>

      <OutputsColumns outputs={outputs.data ?? []} send={send} />
    </div>
  )
}
