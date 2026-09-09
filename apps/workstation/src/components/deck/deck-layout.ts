/**
 * 卡片的尺寸铁律（37 §1 第 1 行，照 KefuAgent `inbox-card-layout.ts`）。
 *
 * 卡面是这个工作台唯一的主力界面，所以它的几何是**定下来的**，不是内容碰巧撑出来的：
 *
 * - **max-width 780px 居中**——横跨 1600px 显示器的卡，会把一行标题拉成 200 字的一条线，
 *   并且把「发送」按钮推到离它所批准的文字一米远的地方。
 * - **min-height 320px**——四段都在、内容很短时也不塌成一条。没有下限，一句话的卡就成了
 *   一根横条，这副牌也就不再是「一次一张」，而那正是整个交互模型本身。
 *
 * 第三个数是让下限安全的那个：有下限没上限时，一封三千字的邮件会把动作行顶出视口，
 * 所以内容区**在卡内滚**而不是把卡撑高。动作行是唯一一个绝不许靠翻页才够得着的东西。
 *
 * 写成 Tailwind 类串而不是数字，是因为这个数得待在 Tailwind 扫描器看得见的地方；
 * 一个 px 常量加一处手写任意值就是两个真源，它们迟早会分家。
 */

/** 队列容器：居中 + 最大宽度 780px。 */
export const DECK_MAX_WIDTH_CLASS = 'mx-auto w-full max-w-[780px]'

/** 卡片容器：最小高度 320px。 */
export const DECK_CARD_MIN_HEIGHT_CLASS = 'min-h-[320px]'

/** 内容区：超长时卡内滚，绝不把动作行挤出视口。 */
export const DECK_CARD_BODY_SCROLL_CLASS = 'max-h-[420px] overflow-y-auto'

/** 飞出动画时长（ms）：决定完 300ms 换下一张（37 §1 第 8 行）。 */
export const DECK_EXIT_MS = 300
