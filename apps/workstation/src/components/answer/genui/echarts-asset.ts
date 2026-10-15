/**
 * WP336：dsh-genui 的 `echart` 组件要一个 ECharts 引擎（插件原本从它自己 dsh 插件的 HTTP 路由按需拉
 * `echarts-core.js`）。我们不装插件本体，改成**本机打包**：只装柱 / 线 / 饼 / 漏斗四种（白名单里的预设），
 * 由 vite 拆成单独一块，只有回答里真有 `echart` 时才加载，从工坊自己的服务进程取，不出网。
 *
 * 加载完把 `createChart` 登记到 `window.__GenuiAssets__`（插件的约定：登记过就不再插 <script>）。
 * 漏斗在插件里算「完整引擎」那一档，所以两档登记同一个。
 */
import { BarChart, FunnelChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  FunnelChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
])

function createChart(
  el: HTMLElement,
  option: Record<string, unknown>,
  opts?: { height?: number },
): echarts.EChartsType {
  const instance = echarts.init(
    el,
    undefined,
    opts?.height === undefined ? {} : { height: opts.height },
  )
  instance.setOption(option)
  return instance
}

const host = globalThis as unknown as { __GenuiAssets__?: Record<string, unknown> }
host.__GenuiAssets__ ??= {}
host.__GenuiAssets__.echartsCore = { createChart }
host.__GenuiAssets__.echartsFull = { createChart }
