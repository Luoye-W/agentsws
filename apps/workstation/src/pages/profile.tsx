/**
 * 「我的代理」（41 §1；原「秘书」，09-10 改名——包名 / 路由 / 事件名不动）。
 *
 * 四个 Tab，对应代理的四个能力：
 * - **问代理**：问别人的代理（代答），外加"把一件事丢给代理"（任务路由）
 * - **我的 profile**：岗位与范围（从制度层算，只读）+ 擅长 / 可用时段 / 联系偏好 / 公开级别
 * - **谁问过我**：谁问了什么、代理答了什么——**只有本人看得到**（41 §1.2）
 * - **约时间**：等我点头的那几张卡
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AskSecretary } from '@/components/secretary/ask-secretary'
import { MeetInbox } from '@/components/secretary/meet-inbox'
import { ProfileForm } from '@/components/secretary/profile-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getMyProfile,
  listAskedMe,
  listMyMeets,
  listPeople,
  routeToDesk,
  type SecretaryRouteResult,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

function RoutePanel(): React.ReactNode {
  const { t } = useApp()
  const [text, setText] = useState('')
  const [result, setResult] = useState<SecretaryRouteResult | null>(null)
  const route = useMutation({
    mutationFn: (input: string) => routeToDesk(input),
    onSuccess: (out) => {
      setResult(out)
    },
  })

  return (
    <Card data-testid="route-panel">
      <CardHeader>
        <CardTitle className="text-sm">{t('secretary.route.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <Input
          data-testid="route-text"
          value={text}
          placeholder={t('secretary.route.placeholder')}
          onChange={(e) => {
            setText(e.target.value)
          }}
        />
        <div>
          <Button
            size="sm"
            data-testid="route-submit"
            disabled={route.isPending || text.trim() === ''}
            onClick={() => {
              route.mutate(text.trim())
            }}
          >
            {t('secretary.route.submit')}
          </Button>
        </div>
        {result === null ? null : (
          <div
            className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3"
            data-testid="route-result"
            data-kind={result.kind}
          >
            <p>
              {result.role_name === undefined
                ? t('secretary.route.unrouted')
                : result.kind === 'task'
                  ? t('secretary.route.task', { role: result.role_name })
                  : t('secretary.route.question', { role: result.role_name })}
            </p>
            <span className="text-muted-foreground text-xs">{result.reason}</span>
            {result.existing_tools.length === 0 ? null : (
              <span className="text-muted-foreground text-xs" data-testid="route-existing">
                {t('secretary.route.existing', {
                  titles: result.existing_tools.map((e) => e.title).join('、'),
                })}
              </span>
            )}
            {result.similar_in_progress.map((s) => (
              <span
                key={s.id}
                className="text-muted-foreground text-xs"
                data-testid="route-similar"
              >
                {t('secretary.route.similar', {
                  who: s.owner_label ?? s.owner,
                  title: s.title,
                })}
              </span>
            ))}
          </div>
        )}
        {route.error === null || route.error === undefined ? null : (
          <p role="alert" className="text-destructive text-sm">
            {route.error instanceof Error ? route.error.message : String(route.error)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function SecretaryPage(): React.ReactNode {
  const { t } = useApp()
  const [tab, setTab] = useState('ask')

  const profile = useQuery({ queryKey: ['secretary', 'profile'], queryFn: getMyProfile })
  const people = useQuery({ queryKey: ['secretary', 'people'], queryFn: listPeople })
  const asked = useQuery({ queryKey: ['secretary', 'asked'], queryFn: () => listAskedMe() })
  const meets = useQuery({ queryKey: ['secretary', 'meets'], queryFn: listMyMeets })

  const others = (people.data ?? []).filter((p) => p.person_id !== profile.data?.person_id)
  const waiting = (meets.data ?? []).filter((m) => m.state === 'proposed')

  return (
    <div className="flex flex-col gap-4" data-testid="secretary-page">
      {/* WP43 ③：一句标题就够，「代理只管四件事」进问号 */}
      <h1 className="flex items-center gap-1 font-semibold text-base">
        {t('secretary.title')}
        <Hint text={t('secretary.intro')} />
      </h1>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="ask">{t('secretary.tab.ask')}</TabsTrigger>
          <TabsTrigger value="profile">{t('secretary.tab.profile')}</TabsTrigger>
          <TabsTrigger value="asked">
            {t('secretary.tab.asked')}
            {(asked.data ?? []).length === 0 ? null : (
              <Badge variant="secondary" className="ml-1.5">
                {(asked.data ?? []).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="meets">
            {t('secretary.tab.meets')}
            {waiting.length === 0 ? null : (
              <Badge variant="secondary" className="ml-1.5" data-testid="meets-badge">
                {waiting.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ask" className="flex flex-col gap-4 pt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('secretary.tab.ask')}</CardTitle>
            </CardHeader>
            <CardContent>
              {people.data === undefined ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <AskSecretary people={others} />
              )}
            </CardContent>
          </Card>
          <RoutePanel />
        </TabsContent>

        <TabsContent value="profile" className="pt-3">
          {profile.data === undefined ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <ProfileForm profile={profile.data} />
          )}
        </TabsContent>

        <TabsContent value="asked" className="flex flex-col gap-2 pt-3">
          {asked.data === undefined ? (
            <Skeleton className="h-32 w-full" />
          ) : asked.data.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('secretary.asked.empty')}</p>
          ) : (
            asked.data.map((r) => (
              <Card key={r.id} data-testid="asked-row">
                <CardContent className="flex flex-col gap-1 py-3 text-sm">
                  <span className="text-muted-foreground text-xs">
                    {t('secretary.asked.by', { who: r.asked_by_label ?? r.asked_by })}
                  </span>
                  <span className="font-medium">{r.question}</span>
                  <span>{r.answer}</span>
                  <span className="text-muted-foreground text-xs">
                    {r.refused
                      ? t('secretary.asked.refused')
                      : t('secretary.asked.fields', {
                          fields: r.fields.map((f) => t(`secretary.field.${f}`)).join('、'),
                        })}
                  </span>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="meets" className="pt-3">
          {meets.data === undefined ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <MeetInbox meets={meets.data} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
