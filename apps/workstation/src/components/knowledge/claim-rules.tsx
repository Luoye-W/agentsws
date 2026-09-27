/**
 * WP159：知识库里那张「违规宣称规则」表——按市场分组（通用 / 美国 / 欧盟英国 / 加拿大 / 澳大利亚）。
 *
 * 一组一张小卡：组名 + 开关（按目标市场自动开，人可以拨）+ 一张表（要拦的字 / 为什么 / 出处 / 开）。
 * 每一行能关、能改（改字或理由）；最底下能加一条自己的。改的都记成知识库里的卡（服务端做）。
 * 说明文字放在表里（数据），卡面只留标题一句话——36 §7 的减字规矩。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Pencil } from 'lucide-react'
import { useState } from 'react'
import { WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  type ClaimMarketGroupId,
  type ClaimRuleRowData,
  type ClaimRulesPatchInput,
  getClaimRules,
  setClaimRules,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function ClaimRulesSection(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const rules = useQuery({ queryKey: ['knowledge-claim-rules'], queryFn: () => getClaimRules() })
  const patch = useMutation({
    mutationFn: (input: ClaimRulesPatchInput) => setClaimRules(input),
    onSuccess: (data) => client.setQueryData(['knowledge-claim-rules'], data),
  })
  const data = rules.data
  if (data === undefined) return null
  const markets = data.markets.join(' / ')
  return (
    <Card data-testid="knowledge-claim-rules">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('knowledge.claims.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('knowledge.claims.note')}</p>
        <p className="text-xs" data-slot="status" data-testid="claim-markets">
          {data.markets_from === 'default'
            ? t('knowledge.claims.markets_default', { markets })
            : t('knowledge.claims.markets', { markets })}
        </p>
        {data.groups.map((g) => (
          <ClaimGroup
            key={g.id}
            id={g.id}
            enabled={g.enabled}
            why={g.why}
            rows={data.rules.filter((r) => r.market === g.id)}
            busy={patch.isPending}
            onPatch={(input) => patch.mutate(input)}
          />
        ))}
        {patch.error === null ? null : (
          <p className="text-xs text-destructive">{String(patch.error.message)}</p>
        )}
      </CardContent>
    </Card>
  )
}

function ClaimGroup(props: {
  id: ClaimMarketGroupId
  enabled: boolean
  why: 'always' | 'market' | 'manual'
  rows: ClaimRuleRowData[]
  busy: boolean
  onPatch(input: ClaimRulesPatchInput): void
}): React.ReactNode {
  const { t } = useApp()
  const name = t(`knowledge.claims.group.${props.id}`)
  const [adding, setAdding] = useState(false)
  const [pattern, setPattern] = useState('')
  const [reason, setReason] = useState('')
  return (
    <Card data-testid={`claim-group-${props.id}`} className={props.enabled ? '' : 'opacity-60'}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">{name}</CardTitle>
        <div className="flex items-center gap-2">
          <span data-slot="badge">
            <WsTag>{t(`knowledge.claims.why.${props.why}`)}</WsTag>
          </span>
          <Switch
            size="sm"
            checked={props.enabled}
            disabled={props.id === 'global' || props.busy}
            aria-label={t('knowledge.claims.toggle', { name })}
            onCheckedChange={(on) => props.onPatch({ group: { id: props.id, enabled: on } })}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-normal">{t('knowledge.claims.col.pattern')}</th>
              <th className="py-1 pr-2 font-normal">{t('knowledge.claims.col.reason')}</th>
              <th className="py-1 pr-2 font-normal">{t('knowledge.claims.col.source')}</th>
              <th className="py-1 font-normal">{t('knowledge.claims.col.on')}</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <ClaimRow key={r.id} row={r} busy={props.busy} onPatch={props.onPatch} />
            ))}
          </tbody>
        </table>
        {adding ? (
          <div className="flex flex-wrap gap-2">
            <Input
              className="h-8 w-40"
              value={pattern}
              placeholder={t('knowledge.claims.col.pattern')}
              onChange={(e) => setPattern(e.target.value)}
            />
            <Input
              className="h-8 flex-1"
              value={reason}
              placeholder={t('knowledge.claims.col.reason')}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              size="sm"
              disabled={pattern.trim() === '' || props.busy}
              onClick={() => {
                props.onPatch({ add: { pattern, reason, market: props.id } })
                setPattern('')
                setReason('')
                setAdding(false)
              }}
            >
              {t('knowledge.claims.save')}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            {t('knowledge.claims.add')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function ClaimRow(props: {
  row: ClaimRuleRowData
  busy: boolean
  onPatch(input: ClaimRulesPatchInput): void
}): React.ReactNode {
  const { t } = useApp()
  const { row } = props
  const [editing, setEditing] = useState(false)
  const [pattern, setPattern] = useState(row.pattern)
  const [reason, setReason] = useState(row.reason)
  return (
    <tr className="border-t align-top" data-testid={`claim-rule-${row.id}`}>
      <td className="py-1 pr-2 font-mono">
        {editing ? (
          <Input className="h-7" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        ) : (
          row.pattern
        )}
      </td>
      <td className="py-1 pr-2">
        {editing ? (
          <div className="space-y-1">
            <Input className="h-7" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex gap-1">
              <Button
                size="sm"
                disabled={props.busy}
                onClick={() => {
                  props.onPatch({ rule: { id: row.id, pattern, reason } })
                  setEditing(false)
                }}
              >
                {t('knowledge.claims.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('knowledge.claims.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <span>
            {row.reason}
            {row.origin === 'builtin' ? null : (
              <span className="ml-1 text-muted-foreground">
                （{t(`knowledge.claims.origin.${row.origin}`)}）
              </span>
            )}
          </span>
        )}
      </td>
      <td className="py-1 pr-2">
        {row.source_url === undefined ? null : (
          <a
            href={row.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            {row.source_title ?? row.source_url}
            <ExternalLink className="size-3" />
          </a>
        )}
      </td>
      <td className="py-1">
        <div className="flex items-center gap-1">
          <Switch
            size="sm"
            checked={row.enabled}
            disabled={props.busy}
            aria-label={t('knowledge.claims.toggle', { name: row.pattern })}
            onCheckedChange={(on) => props.onPatch({ rule: { id: row.id, enabled: on } })}
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={t('knowledge.claims.edit')}
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3" />
          </Button>
        </div>
      </td>
    </tr>
  )
}
