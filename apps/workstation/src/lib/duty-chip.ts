/**
 * WP419（主会话 Mac 自测）：新建岗位 / 加职责时的职责芯片——Reddit 那两条叫「官方版块 / 外部版块」，芯片上没有
 * 「Reddit」字样，用户找「Reddit」找不到。芯片前面带上平台名（只改芯片上那几个字，职责名本身不动）。
 */
const PLATFORM_OF: Readonly<Record<string, string>> = {
  'social.reddit': 'Reddit',
  'pr.reddit': 'Reddit',
}

/** 芯片上显示的字（`Reddit · 官方版块`）；名字里已经有平台名就不重复。 */
export function dutyChipLabel(role_id: string, name: string): string {
  const platform = PLATFORM_OF[role_id]
  if (platform === undefined || new RegExp(`\\b${platform}\\b`, 'iu').test(name)) return name
  return `${platform} · ${name}`
}
