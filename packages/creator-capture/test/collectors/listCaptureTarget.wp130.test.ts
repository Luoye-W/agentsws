/** 移植自 agentsws-extension `test/contents/listCaptureTarget.wp130.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * WP130 本仓补的两种页型与面板上那一格的写法（不是移植——旧插件没有这几条，
 * 所以单独一个文件，移植来的 listCaptureTarget.test.ts 一个字不动）。
 */
import { expect, test } from 'vitest'

import { listQueryLabel, resolveListCaptureTarget } from '../../src/collectors/listCaptureTarget.js'

test('TikTok 搜索的「用户」「视频」分栏也是列表页，网址只留分栏与搜索词', () => {
  expect(resolveListCaptureTarget('https://www.tiktok.com/search/user?q=meal%20prep&t=123')).toEqual({
    platform: 'tiktok',
    pageType: 'search',
    sourceQuery: 'https://www.tiktok.com/search/user?q=meal%20prep',
  })
  expect(resolveListCaptureTarget('https://www.tiktok.com/search/video?q=bento')).toEqual({
    platform: 'tiktok',
    pageType: 'search',
    sourceQuery: 'https://www.tiktok.com/search/video?q=bento',
  })
  // 没有搜索词不是列表页；别的分栏（直播）不认。
  expect(resolveListCaptureTarget('https://www.tiktok.com/search/user')).toBeNull()
  expect(resolveListCaptureTarget('https://www.tiktok.com/search/live?q=x')).toBeNull()
})

test('Instagram 关键词搜索结果页是列表页', () => {
  expect(
    resolveListCaptureTarget('https://www.instagram.com/explore/search/keyword/?q=%23mealprep'),
  ).toEqual({
    platform: 'instagram',
    pageType: 'search',
    sourceQuery: 'https://www.instagram.com/explore/search/keyword/?q=%23mealprep',
  })
  expect(resolveListCaptureTarget('https://www.instagram.com/explore/search/keyword/')).toBeNull()
  expect(resolveListCaptureTarget('https://www.instagram.com/explore/')).toBeNull()
})

test('面板上「搜索词」那一格：话题页写 #话题，搜索页写搜索词，YouTube 原样', () => {
  expect(listQueryLabel('https://www.tiktok.com/tag/mealprep')).toBe('#mealprep')
  expect(listQueryLabel('https://www.instagram.com/explore/tags/%E6%97%A9%E9%A4%90/')).toBe('#早餐')
  expect(listQueryLabel('https://www.tiktok.com/search?q=meal%20prep')).toBe('meal prep')
  expect(listQueryLabel('https://www.instagram.com/explore/search/keyword/?q=salad')).toBe('salad')
  expect(listQueryLabel('standing desk')).toBe('standing desk')
})
