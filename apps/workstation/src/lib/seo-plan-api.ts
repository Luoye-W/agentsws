/**
 * WP450（docs/109 §5.2 #9–11、17）：编辑日历、出一组主题、外链体检、llms.txt、改写成社媒稿的接口。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加），形状直接用契约里那几个类型。
 */
import type {
  BacklinkAuditRun,
  BacklinkAuditSettings,
  BacklinkAuditView,
  LlmsTxtView,
  RepurposeChannel,
  RepurposeResult,
  SeoCalendarView,
  SeoClusterPlanResult,
} from '@agentsws/contracts'
import { api } from './api'

export type {
  BacklinkAuditRun,
  BacklinkAuditView,
  LlmsTxtView,
  RepurposeResult,
  SeoCalendarEntry,
  SeoCalendarView,
  SeoCluster,
  SeoClusterPayload,
} from '@agentsws/contracts'

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

export const SEO_CALENDAR_KEY = 'seo-calendar'
export const SEO_BACKLINKS_KEY = 'seo-backlinks'
export const SEO_LLMS_KEY = 'seo-llms-txt'

export const getSeoCalendar = (assignment?: string): Promise<SeoCalendarView> =>
  api('/v1/seo/calendar', as(assignment))

export const planSeoClusters = (assignment?: string): Promise<SeoClusterPlanResult> =>
  api('/v1/seo/clusters/plan', { method: 'POST', body: {}, ...as(assignment) })

export const getBacklinkAudit = (assignment?: string): Promise<BacklinkAuditView> =>
  api('/v1/seo/backlinks', as(assignment))

export const setBacklinkAudit = (
  patch: Partial<BacklinkAuditSettings>,
  assignment?: string,
): Promise<BacklinkAuditView> =>
  api('/v1/seo/backlinks', { method: 'PUT', body: patch, ...as(assignment) })

export const runBacklinkAudit = (assignment?: string): Promise<BacklinkAuditRun> =>
  api('/v1/seo/backlinks/run', { method: 'POST', body: {}, ...as(assignment) })

export const getLlmsTxt = (assignment?: string): Promise<LlmsTxtView> =>
  api('/v1/seo/llms-txt', as(assignment))

export const generateLlmsTxt = (
  input: { handoff?: boolean },
  assignment?: string,
): Promise<LlmsTxtView> =>
  api('/v1/seo/llms-txt', { method: 'POST', body: input, ...as(assignment) })

export const repurposePost = (
  input: { change_id: string; channels?: RepurposeChannel[] },
  assignment?: string,
): Promise<RepurposeResult> =>
  api('/v1/seo/repurpose', { method: 'POST', body: input, ...as(assignment) })
