/**
 * 存储口的**接口**（只有类型，没有实现）。
 *
 * 出处：agentsws-extension `src/lib/storage.ts` @ 57fca9c 里的 `KeyValueStore`（那一份最早就是从开源仓
 * `apps/extension/src/lib/storage.ts` 拷过去的）。`kol/language.ts` 与 `kol/bioLinkCache.ts` 两个移植文件
 * 由调用方注入存储；这个包里**不碰**任何浏览器存储，谁要存谁自己给一个实现（插件给 `chrome.storage.local`，
 * 测试给内存表，ego 路不存）。
 */
export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
}
