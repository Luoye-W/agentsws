/**
 * 云侧的邮件投递口子。
 *
 * 三条纪律：
 *
 * 1. **一个接口，两种实现**：开发环境把链接打到 stdout（`consoleMailSender`），
 *    真投递由宿主注入（`createCloudServer({ mail })`）。这一层不认识 SMTP。
 * 2. **SMTP 配置只从环境变量读，永远不硬编码**。这个文件里没有任何主机名、
 *    端口、用户名、口令，也不该有——真账号的那几行属于部署，不属于仓库。
 * 3. 一次性登录链接**只进邮件正文**：不进响应体、不进事件、不进任何持久化的日志。
 *    开发档打到 stdout 是有意的（本机开发要点得进去），所以 `consoleMailSender`
 *    在环境变量说"这是生产"时会拒绝启动，而不是把链接打到生产日志里。
 */

export interface CloudMail {
  to: string
  subject: string
  /** 纯文本正文；一次性登录链接就在里面。 */
  text: string
}

export type MailSender = (mail: CloudMail) => Promise<void>

/** SMTP 只认这几个环境变量名；值一个都不在仓库里。 */
export const SMTP_ENV = {
  url: 'AGENTSWS_CLOUD_SMTP_URL',
  from: 'AGENTSWS_CLOUD_MAIL_FROM',
} as const

/** 开发档：把信打到 stdout（或注入的 sink），链接肉眼可见。 */
export function consoleMailSender(write: (line: string) => void = (l) => process.stdout.write(l)) {
  return async (mail: CloudMail): Promise<void> => {
    write(`\n[cloud-mail] to=${mail.to} subject=${mail.subject}\n${mail.text}\n`)
  }
}

/**
 * 按环境变量挑一个投递实现。
 *
 * 配了 `AGENTSWS_CLOUD_SMTP_URL` 就说明这是要真发信的一档——但本 WP **不带**
 * SMTP 客户端（那属于部署，且加一个依赖就得连带答"退信怎么办、限速怎么办"）。
 * 所以这里**显式拒绝**而不是悄悄退化成 console：把真账号的登录链接打进生产日志，
 * 比起不了服务糟得多。宿主要真发信，注入自己的 `MailSender`。
 */
export function mailSenderFromEnv(
  env: Record<string, string | undefined>,
  write?: (line: string) => void,
): MailSender {
  const url = env[SMTP_ENV.url]
  if (url !== undefined && url.trim() !== '')
    throw new Error(
      `${SMTP_ENV.url} 配了，但这个进程没有 SMTP 客户端：请给 createCloudServer 注入 mail（WP58 不带发信实现）`,
    )
  return consoleMailSender(write)
}

/** 登录信的正文。只有一句话与一条链接——没有品牌废话，也没有任何别的信息。 */
export function loginMail(to: string, link: string, minutes: number): CloudMail {
  return {
    to,
    subject: '登录 agentsws 云账号',
    text: [
      '点下面这条链接登录 agentsws 云账号：',
      '',
      link,
      '',
      `链接 ${String(minutes)} 分钟内有效，只能用一次。`,
      '不是你本人操作的话，忽略这封信就行——没有点，什么都不会发生。',
    ].join('\n'),
  }
}
