/**
 * WP438：报表图表的 ECharts 引擎——和 genui 共用同一个 `echarts/core`（`answer/genui/echarts-asset.ts` 登记的
 * 那一份；`use()` 是叠加的，两边谁先加载都行）。这里只多登记报表要的标记线 / 标记点。
 * 单独一块、懒加载：没打开报表之前一个字节都不下载。
 */
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkPointComponent,
  CanvasRenderer,
])

export { echarts }
