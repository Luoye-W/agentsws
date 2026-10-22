import { cn } from 'cn'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      // WP456-T2：和共用骨架（`.ws-skel`）同一个样子——灰底一道慢光，动效关了就停
      className={cn('ws-skel rounded-md', className)}
      {...props}
    />
  )
}

export { Skeleton }
