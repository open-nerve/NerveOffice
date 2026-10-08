// SDK 面板里按防抖写进模型的输入（M3-P4 设计 §3.4"面板的防抖"、§7 的风险表）：用户在这些面板里改动之后，SDK 过一段时间才执行写模型的
// 命令；关闭面板既不取消、也不提前执行（计时器照样到点），没有对外的"立即提交"。退出编辑与交出之前要销毁编辑器，到点之前销毁就丢了：
// 适配层记下这些面板开着时的用户输入，捕获之前等 SDK 的防抖到点（panel-debounce-watch.ts）；到点之前这段输入算"还没写进模型的输入"，
// 页头与离开提示据此算未保存（Codex 评审 CX4）。每一项是面板的 DOM 标记与防抖的时长（SDK 里的字面量，没有导出）：
// - 批注浮层的文本框：ui 的 useDebounceFn 默认 300 ms（views/hooks/use-debounce.ts:19-30：组件卸载时不清计时器），
//   sheets-note-ui 的 views/Note.tsx:110-143 用它写 SheetUpdateNoteCommand；1.0.1 的 ui lib/es/index.js:6584-6592、
//   sheets-note-ui lib/es/index.js:648（文本框的标记 :691，即 NOTE_TEXTAREA_SELECTOR）；
// - 数据验证的详情面板：@univerjs/core 再导出的 lodash debounce 1000 ms（sheets-data-validation-ui 的
//   views/components/DataValidationDetail.tsx:65-72，范围、设置与选项三种更新共用这一个防抖，面板卸载时不 flush）；
//   1.0.1 的 lib/es/index.js:2931-2934，面板根元素的标记 data-u-comp="data-validation-detail" 在 :3140。
// 别的面板没有这样写模型的防抖（M3-P4 S4 核对 refer/univer 的各个界面包：条件格式、筛选、排序、查找替换、超链接、数字格式、编辑栏与
// 名称框的防抖只管界面；图片的变换面板有，但 M5 之前图片进不来）。SDK 升级时由 E2E 回归（键入之后立即退出编辑，服务器上有这次的改动）
import { NOTE_TEXTAREA_SELECTOR } from './dom-markers.ts'

/** 一种按防抖写模型的面板 */
export interface PanelDebounce {
  /** 叫什么（日志与测试） */
  readonly panel: 'note' | 'data-validation'
  /** 面板开着时页面上有它（SDK 的 DOM 标记） */
  readonly selector: string
  /** SDK 的防抖时长（毫秒）：最后一次改动之后这么久执行写模型的命令 */
  readonly delayMs: number
}

/** 数据验证的详情面板的根元素（sheets-data-validation-ui 的 views/components/DataValidationDetail.tsx 的 data-u-comp） */
const DATA_VALIDATION_DETAIL_SELECTOR = '[data-u-comp="data-validation-detail"]'

export const PANEL_DEBOUNCES: readonly PanelDebounce[] = Object.freeze([
  Object.freeze({ panel: 'note', selector: NOTE_TEXTAREA_SELECTOR, delayMs: 300 } as const),
  Object.freeze({ panel: 'data-validation', selector: DATA_VALIDATION_DETAIL_SELECTOR, delayMs: 1000 } as const),
])
