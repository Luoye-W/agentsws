/**
 * WP254（决策 100 / 123）：设置 · 诊断里的「下载源」一行——这台电脑装平台 CLI、下载连接器从哪儿取包。
 *
 * 默认官方源；用户在失败那一行点过「换国内源再试」就是国内源（npmmirror），这里能改回官方源
 * （也能主动改用国内源）。只影响这台电脑。界面少字：一句状态 + 一个按钮，说明进问号。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { getNpmRegistry, type NpmRegistrySource, setNpmRegistry } from '@/lib/npm-registry-api'

const KEY = ['npm-registry']

export function NpmRegistryDiagnostics(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const view = useQuery({ queryKey: KEY, queryFn: getNpmRegistry, retry: false })
  const change = useMutation({
    mutationFn: (source: NpmRegistrySource) => setNpmRegistry(source),
    onSuccess: (next) => {
      client.setQueryData(KEY, next)
    },
  })
  const data = view.data
  // 没装配（老服务进程 / 云端）：这一行不画
  if (data === undefined) return null
  const next: NpmRegistrySource = data.source === 'npmmirror' ? 'official' : 'npmmirror'
  return (
    <section className="flex flex-col gap-1.5" data-testid="npm-registry-diagnostics">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Globe className="size-3.5" aria-hidden />
        {t('npm_registry.title')}
        <Hint text={t('npm_registry.hint')} />
      </h4>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span data-slot="status" data-testid="npm-registry-source" data-source={data.source}>
          {t(`npm_registry.source.${data.source}`)}
        </span>
        {data.source === 'official' && data.env_override ? (
          <Hint text={t('npm_registry.env_override')} />
        ) : null}
        <Button
          size="xs"
          variant="outline"
          data-testid={`npm-registry-use-${next}`}
          disabled={change.isPending}
          onClick={() => change.mutate(next)}
        >
          {t(next === 'official' ? 'npm_registry.use_official' : 'npm_registry.use_mirror')}
        </Button>
      </div>
      {change.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {change.error.message}
        </p>
      )}
    </section>
  )
}
