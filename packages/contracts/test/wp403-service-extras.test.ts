/**
 * WP403（决策 1134）：追加费用与订单附件的契约——路径、附件名洗法、在等你点头的那条追加、上限。
 */
import { describe, expect, it } from 'vitest'
import {
  pendingServiceExtra,
  SERVICE_ATTACHMENT_LIMITS,
  SERVICE_ORDER_EXTRA_STATUSES,
  type ServiceOrderExtra,
  serviceAttachmentName,
  serviceOrderPath,
} from '../src/index.js'

const extra = (id: string, status: ServiceOrderExtra['status']): ServiceOrderExtra => ({
  id,
  credits: 100,
  reason: '会上定了加两页',
  status,
  requested_at: '2026-10-18T00:00:00.000Z',
})

describe('WP403 追加费用与订单附件', () => {
  it('一单的路径：追加 / 附件 / 一份附件', () => {
    expect(serviceOrderPath('svo_1')).toBe('/v1/services/orders/svo_1')
    expect(serviceOrderPath('svo_1', '/extra')).toBe('/v1/services/orders/svo_1/extra')
    expect(serviceOrderPath('svo_1', '/attachments/att_2')).toBe(
      '/v1/services/orders/svo_1/attachments/att_2',
    )
  })

  it('附件名去掉路径与控制字符、压空白、截到上限；洗完是空的不收', () => {
    expect(serviceAttachmentName('C:\\Users\\me\\logo 原图.png')).toBe('logo 原图.png')
    expect(serviceAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(serviceAttachmentName('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(serviceAttachmentName('  多   空格 .pdf ')).toBe('多 空格 .pdf')
    expect(serviceAttachmentName('..')).toBeUndefined()
    expect(serviceAttachmentName('   ')).toBeUndefined()
    expect(serviceAttachmentName(42)).toBeUndefined()
    expect(serviceAttachmentName('x'.repeat(500))?.length).toBe(SERVICE_ATTACHMENT_LIMITS.max_name)
  })

  it('在等你点头的那条追加：只认 pending', () => {
    expect(pendingServiceExtra({})).toBeUndefined()
    expect(
      pendingServiceExtra({ extras: [extra('x1', 'accepted'), extra('x2', 'declined')] }),
    ).toBeUndefined()
    expect(
      pendingServiceExtra({ extras: [extra('x1', 'accepted'), extra('x2', 'pending')] })?.id,
    ).toBe('x2')
    expect(SERVICE_ORDER_EXTRA_STATUSES).toEqual(['pending', 'accepted', 'declined', 'withdrawn'])
  })

  it('上限：单个 25 MB、一单 50 个 / 200 MB', () => {
    expect(SERVICE_ATTACHMENT_LIMITS.max_bytes).toBe(25 * 1024 * 1024)
    expect(SERVICE_ATTACHMENT_LIMITS.max_files).toBe(50)
    expect(SERVICE_ATTACHMENT_LIMITS.max_total_bytes).toBe(200 * 1024 * 1024)
  })
})
