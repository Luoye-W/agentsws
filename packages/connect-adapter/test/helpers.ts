import type { Clock, Iso8601 } from '@agentsws/contracts'

/** 时间经注入的 Clock；测试与录制脚本共用同一把，回放才和录制一一对应。 */
export class TestClock implements Clock {
  private t: number

  constructor(start: Iso8601 = '2026-09-09T09:00:00.000Z') {
    this.t = Date.parse(start)
  }

  now(): Iso8601 {
    return new Date(this.t).toISOString()
  }

  advance(ms: number): void {
    this.t += ms
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms)
  }
}

/** 录制脚本写进磁带的附加信息：回放侧要知道用哪些 id。 */
export interface FixtureMeta {
  base_url: string
  admin_token_env: string
  admin_token_placeholder: string
  workspace_id: string
  service: string
  read_action: string
  write_action: string
  unknown_action: string
  oauth_service: string
  connection_id: string
  other_connection_id: string
  other_service_connection_id: string
  assignment_id: string
  clock_start: string
  runtime_kind: 'docker' | 'external'
  /**
   * 录这份磁带用的镜像（`仓库:tag@sha256:…`，WP146 起写）。`check-upstreams.mjs --check`
   * 要求它等于 upstreams.yml 里锁的那一版——换了镜像版本就得重录磁带。
   */
  runtime_image?: string
}
