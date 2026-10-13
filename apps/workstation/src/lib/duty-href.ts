/**
 * 职责页的地址：`/positions/<本人在这条职责上的分配>/duties/<role_id>`。
 *
 * WP298：从 `components/app-shell.tsx` 挪出来的（那边照旧 re-export）。右栏「设定」的
 * 角色 / 额度两个懒加载标签只要这一个函数，以前为它 import 整个外壳——第一次点开标签时
 * 要把左栏、命令面板、账号块……整棵模块树都拉一遍（测试里冷启动 2.6 秒，超过
 * `findBy` 的 1 秒，`rail-panels` 用例因此时好时坏）。
 */
export function dutyHref(assignment_id: string, role_id: string): string {
  return `/positions/${encodeURIComponent(assignment_id)}/duties/${encodeURIComponent(role_id)}`
}
