/** 教程上官网（私有 docs/113）：`vite.config.ts` 的 `helpContent()` 从 `docs/help` 头上读出来的随包目录。 */
declare module 'virtual:agentsws-help' {
  const list: readonly {
    slug: string
    title: { zh: string; en: string }
    description: { zh: string; en: string }
    group?: 'start' | 'models' | 'connect' | 'channels' | 'tools'
    order?: number
    positions: readonly string[]
    roles: readonly string[]
    requires?: string
    aliases?: readonly string[]
  }[]
  export default list
}
