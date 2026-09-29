// E2E 的探针（M2-P3 设计 §3.7）：只在测试构建里（vite build --mode e2e），由 createSheetEditor 在就绪之后动态引入并装上。
// 生产构建里那个分支与这个分块都被去掉，门禁 artifacts 核对：生产产物里没有探针的分块（TEST_ONLY_ARTIFACTS），也没有 __nerveEditorProbe。
// 为什么要它：画布上的内容读不出来，"改动被拦住"要比较内存里的快照；M0 的 28 个表格编辑入口里 21 个是直接调 Facade 的，
// 只读时界面上没有它们的入口，但防火墙必须拦住它们（SDK 升级可能带来新的入口），E2E 经这里逐项调用。
// 探针只读取与调用 Facade，不改变编辑器的行为；E2E 的其他用例不用它。
// 放在 editor/ 下：只有编辑器适配层能引用 Univer；文件名不带 test-support，生产代码（sheet-editor.ts）才能引用它
import type { FUniver } from '@univerjs/core/facade'

type Workbook = ReturnType<FUniver['createWorkbook']>

export interface EditorProbe {
  /** 编辑器的 Facade：E2E 经它调用各个编辑入口 */
  readonly univerAPI: FUniver
  /** 内存里的快照，与编辑器的捕获相同（JSON.stringify(save())） */
  readonly snapshot: () => string
}

declare global {
  interface Window {
    /** 只在测试构建里有 */
    __nerveEditorProbe?: EditorProbe
  }
}

/** 装上探针，返回移除它的函数（编辑器销毁时调用；已经换成别的探针时不动） */
export function installEditorProbe(univerAPI: FUniver, workbook: Workbook): () => void {
  const probe: EditorProbe = { univerAPI, snapshot: () => JSON.stringify(workbook.save()) }
  window.__nerveEditorProbe = probe
  return () => {
    if (window.__nerveEditorProbe === probe)
      delete window.__nerveEditorProbe
  }
}
