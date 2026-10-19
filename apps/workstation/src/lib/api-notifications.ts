/**
 * WP429：站内通知（顶栏铃铛）与「设置 → 通知」开关的几条接口。
 */
import type {
  InboxNotification,
  NotificationCategory,
  NotificationList,
  NotificationPrefs,
} from '@agentsws/contracts'
import { api } from './api'

export type { InboxNotification, NotificationCategory, NotificationList, NotificationPrefs }

export const NOTIFICATIONS_KEY = ['notifications'] as const
export const NOTIFICATION_PREFS_KEY = ['settings', 'notifications'] as const

export const listNotifications = (
  view: 'unread' | 'all' = 'unread',
  limit = 50,
): Promise<NotificationList> => api(`/v1/notifications?view=${view}&limit=${limit}`)

export const markNotificationsRead = (ids: readonly string[]): Promise<{ unread: number }> =>
  api('/v1/notifications/read', { method: 'POST', body: { ids } })

export const markAllNotificationsRead = (): Promise<{ unread: number }> =>
  api('/v1/notifications/read-all', { method: 'POST' })

export const getNotificationPrefs = (): Promise<NotificationPrefs> =>
  api('/v1/settings/notifications')

export const putNotificationPrefs = (
  patch: Partial<Record<NotificationCategory, { inbox?: boolean; system?: boolean }>>,
): Promise<NotificationPrefs> => api('/v1/settings/notifications', { method: 'PUT', body: patch })
