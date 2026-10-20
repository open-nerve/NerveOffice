// 按阶段开放的入口：命令守卫（M1-P4 设计 §3.6.8，M5-P2 正式图片输入）。
// 隐藏菜单不会停用命令与快捷键（例如超链接的 Ctrl/Cmd+K）；平台图片输入就绪前，图片命令也在执行前取消。
// 多数按命令的 id 取消；带图片的粘贴（DEF-035 的旁支，M3-P2 S3）另按参数判断，见 IMAGE_PASTE_COMMAND。
// 用的是 Facade 的 BeforeCommandExecute（公开 API）：订阅者把 cancel 设为 true，命令不执行，也不进撤销栈（core 的 f-univer.ts:255-268）
import type { IDisposable } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'

export interface GuardedCommand {
  readonly id: string
  /** 命令定义的位置（refer/univer，v1.0.0）与取消它的原因 */
  readonly source: string
}

/** 图片：默认全部拦截；M5-P2 的平台输入就绪后只放行两种入口和浮图提交。SDK 原始 data URL 路径仍不可写入快照。 */
export const IMAGE_GUARDED_COMMANDS: readonly GuardedCommand[] = [
  { id: 'sheet.command.insert-float-image', source: 'sheets-drawing-ui/src/commands/commands/insert-image.command.ts:27（插入浮动图片；粘贴图片文件也经过它：controllers/sheet-drawing-copy-paste.controller.ts:208-222）' },
  { id: 'sheet.command.insert-cell-image', source: 'sheets-drawing-ui/src/commands/commands/insert-image.command.ts:55（插入单元格图片）' },
  { id: 'sheet.command.insert-sheet-image', source: 'sheets-drawing/src/commands/commands/insert-sheet-drawing.command.ts:37（底层的插入浮动图片，上面两条之外的调用方也经过它）' },
  { id: 'sheet.command.add-worksheet-background-image', source: 'sheets-drawing-ui/src/commands/commands/worksheet-background-image.command.ts:28（工作表背景图片：菜单已隐藏，同样写入图片数据）' },
  { id: 'sheet.command.set-worksheet-background-image', source: 'sheets-drawing 1.0.1 lib/es/index.js:699（背景图片的底层命令；M5-P2 仍不支持背景图片）' },
  { id: 'sheet.mutation.set-worksheet-background-image', source: 'sheets-drawing 1.0.1 lib/es/index.js:684（直接写工作表背景；不能绕过关闭的入口）' },
  { id: 'doc.command.insert-doc-image', source: 'docs-drawing 1.0.1 lib/es/index.js:9（向编辑栏内部文档插入图片，直接使用 RichTextEditingMutation；M5-P2 仍不支持此路径）' },
]

/**
 * 超链接：插入链接的入口由 M5-P3 接入（计划书 §11.3）。取消链接（cancel-hyper-link）只删除数据，不拦。
 * 键入网址时 SDK 的自动识别不经这些命令（sheets-hyper-link 的写入拦截器），照常保留：它与粘贴带来的链接、HYPERLINK() 的结果一样，
 * 写进单元格之前由链接的改写器改成规范写法、不合法的去掉链接（link-policy.ts，M3-P3，DEF-021）
 */
export const HYPERLINK_GUARDED_COMMANDS: readonly GuardedCommand[] = [
  { id: 'sheet.operation.insert-hyper-link-toolbar', source: 'sheets-hyper-link-ui/src/commands/operations/popup.operations.ts:94（工具栏，快捷键 Ctrl/Cmd+K 绑定它：menu/menu.ts:156-160）' },
  { id: 'sheet.operation.insert-hyper-link', source: 'sheets-hyper-link-ui/src/commands/operations/popup.operations.ts:64（右键菜单）' },
  { id: 'sheet.operation.open-hyper-link-edit-panel', source: 'sheets-hyper-link-ui/src/commands/operations/popup.operations.ts:35（打开编辑面板，含已有链接的"编辑"）' },
  { id: 'sheets.command.add-hyper-link', source: 'sheets-hyper-link/src/commands/commands/add-hyper-link.command.ts:54' },
  { id: 'sheets.command.add-rich-hyper-link', source: 'sheets-hyper-link/src/commands/commands/add-hyper-link.command.ts:200（单元格编辑器里的链接）' },
  { id: 'sheets.command.update-hyper-link', source: 'sheets-hyper-link/src/commands/commands/update-hyper-link.command.ts:55' },
  { id: 'sheets.command.update-rich-hyper-link', source: 'sheets-hyper-link/src/commands/commands/update-hyper-link.command.ts:196' },
]

export const GUARDED_COMMANDS: readonly GuardedCommand[] = [...IMAGE_GUARDED_COMMANDS, ...HYPERLINK_GUARDED_COMMANDS]

/**
 * 带图片的粘贴（DEF-035 的旁支，M3-P2 S3 的 E2E 核实：tests/e2e/specs/editor/paste-images.spec.ts）。编辑栏在编辑时（先键入过），
 * 粘贴图片文件或带 <img> 的 HTML，docs-ui 的剪贴板把它们转成编辑栏内部文档里的图片（docs-ui 的 services/clipboard/clipboard.service.ts：
 * 编辑栏不是单元格编辑器，按 source 方式粘贴，图片文件先转成 <img>，再由 html-to-udm/converter.ts 的 IMG 分支转成 drawings；
 * 1.0.1 的 lib/es/index.js:8591-8603、6988），执行这条命令（:5106）写进去；回车之后单元格的富文本带着这些图片（p.drawings、drawingsOrder），
 * 成了单元格图片，地址是 data URL 或外链（外链在画出来时还触发 CSP 的违规）。M5-P2 仍关闭此路径，服务端会拒收这类快照。
 * 单元格编辑器按纯文本粘贴（只认 text/plain，没有时什么也不贴），继续保持；表格上的文件图片粘贴由平台接管上传和插入，
 * 不经过这条内部文档命令。
 * 取消的是整次粘贴（同时复制来的文字也不贴）：参数里的内容由 SDK 组装，改写它（去掉图片留下文字）要依赖它的结构，得不偿失
 */
export const IMAGE_PASTE_COMMAND: GuardedCommand = {
  id: 'doc.command.inner-paste',
  source: 'docs-ui/src/commands/commands/clipboard.inner.command.ts:89-90（文档与编辑器内部的粘贴；参数 doc 是要贴进去的内容，带 drawings 时就是图片），'
    + '由 services/clipboard/clipboard.service.ts 的 _paste 执行（编辑栏处于编辑时粘贴图片文件、带 <img> 的 HTML）',
}

const GUARDED_IDS: ReadonlySet<string> = new Set(GUARDED_COMMANDS.map(command => command.id))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 要贴进去的内容带着图片：doc.drawings 有任何一项，或者正文里有图片的锚点（body.customBlocks 非空：文档里图片占一个位置，
 * 锚点指向 drawings 的一项）。看不懂的参数按带着图片算：宁可这一次贴不进去，也不让图片写进单元格
 */
function pastesImages(params: unknown): boolean {
  if (!isRecord(params) || !isRecord(params.doc))
    return true
  const { drawings, body } = params.doc
  if (drawings !== undefined && (!isRecord(drawings) || Object.keys(drawings).length > 0))
    return true
  return isRecord(body) && Array.isArray(body.customBlocks) && body.customBlocks.length > 0
}

/** 这条命令在执行前取消：清单里的命令，以及带图片的粘贴 */
export function isGuardedCommand(id: string, params?: unknown): boolean {
  return GUARDED_IDS.has(id) || (id === IMAGE_PASTE_COMMAND.id && pastesImages(params))
}

/** 在创建工作簿之前挂上：打开文档的过程中也不执行这些命令 */
export function installEntryGuards(univerAPI: FUniver, managedImageInput: () => boolean = () => false): IDisposable {
  return univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
    // 正式适配接管两种文件入口及正常浮图提交；背景、文档和链接入口仍关闭。
    // 切换时保留本监听，不能改变 Facade 与只读防火墙在 SDK 之前的顺序。
    if (managedImageInput() && ['sheet.command.insert-sheet-image', 'sheet.command.insert-float-image', 'sheet.command.insert-cell-image'].includes(event.id))
      return
    if (isGuardedCommand(event.id, event.params))
      event.cancel = true
  })
}
