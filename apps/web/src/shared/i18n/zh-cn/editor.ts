// 表格编辑器页的文案（P4）：只由编辑器页（features/sheet-editor）引用，随编辑器页的入口加载，不进平台页面的首屏（lint 的模块边界限定）。
// 两个入口共用的（通用的说明、错误与登录状态）在 messages.ts
import type { EditLeaseLostReason } from '@nerve-office/contracts'
import type { Phrase } from './messages.ts'

/**
 * 编辑权失效的原因（EDIT_LEASE_LOST 的 details，M3-P1 设计 §3.4.1）的通俗说法，接在"编辑权已失效："之后。
 * 不认识的原因不在这里：按通用的"编辑权已失效"说明（以后的 Phase 会加原因，契约的响应结构是宽松的）
 */
const LEASE_LOST_REASONS: Record<EditLeaseLostReason, string> = {
  none: '这一页没有有效的编辑权',
  replaced: '这份文档已经在别处取得了编辑权（另一个标签页、另一台设备，或者别人）',
  released: '这一页的编辑权已经释放',
  revoked: '你对这份文档的编辑权被收回了',
  stale: '这份文档被移动到了别处，或者权限有了调整',
  expired: '这一页有一阵子没能联系上服务器（例如断网或电脑休眠），编辑权已经过期',
  idle: '太久没有操作，编辑权已被服务器收回',
  session: '登录状态变了（重新登录、退出或换了账户），编辑权随原来的登录一起失效',
}

export const editorMessages = {
  back: '我的空间',
  loading: '正在打开表格…',
  save: '保存',
  saveShortcut: (keys: string) => `保存（${keys}）`,
  status: {
    clean: '已保存到云端',
    dirty: '有未保存的修改',
    saving: '保存中…',
    conflict: '版本冲突',
    failed: '保存失败',
    readOnly: '只能查看',
    /** 编辑权失效之后的保存状态（M3 总设计 §6.5）：不能再保存 */
    leaseLost: '编辑权已失效',
  },
  /** 编辑权（M3-P1 设计 §3.4.7）：别处正在编辑时只能阅读；失效时说明原因、提供重新加载 */
  editing: {
    /** 别人正在编辑（持有者经人名组件显示）；lastActive 是"最后活动……"，服务端没给出时为 undefined */
    elsewhere: <T>(holder: T, lastActive: string | undefined): Phrase<T> => [holder, ` 正在编辑这份文档${lastActive === undefined ? '' : `（${lastActive}）`}，你现在只能阅读`],
    /** 持有者最后一次操作在几分钟之前（服务端回答时，向下取整） */
    lastActive: (minutes: number) => minutes < 1 ? '最后活动不到 1 分钟前' : `最后活动 ${minutes} 分钟前`,
    elsewhereBySelf: '你在另一个标签页或设备上正在编辑这份文档，这里只能阅读',
    /** 服务端给的详情认不出时的通用说法 */
    elsewhereUnknown: '这份文档正在别处编辑，你现在只能阅读',
    /** 失效的说明：cause 是原因（不认识的原因为 undefined）；unsaved 是本页还有没保存的修改 */
    lost: (cause: string | undefined, unsaved: boolean) => `编辑权已失效${cause === undefined ? '' : `：${cause}`}。${unsaved ? '本页的修改没有保存，需要的话先把内容复制出来，再重新加载。' : '本页的修改都已保存，重新加载可以看到最新的版本。'}`,
    lostReason: (reason: EditLeaseLostReason) => LEASE_LOST_REASONS[reason],
    /** 读不到这份文档了（404） */
    lostNotFound: '这份表格已经被删除、移走，或者你已经没有访问权限',
  },
  finishCellEditing: '请先完成单元格的编辑',
  tooLarge: '表格超过容量上限（5 MiB），无法保存',
  formulasPending: '公式结果尚未保存，请稍后再保存一次',
  saveFailed: (reason: string) => `保存失败：${reason}`,
  conflict: '别处保存了更新的版本。本页的修改没有保存；需要的话先复制出来，再重新加载查看最新版本',
  reload: '重新加载',
  notFound: '内容不存在，或者你没有访问权限',
  unsupported: '这份表格的格式比当前页面新，请刷新页面；刷新后仍然打不开，请联系管理员',
  loadFailed: (reason: string) => `表格加载失败：${reason}`,
  editorFailed: '编辑器加载失败，请刷新页面重试',
  signedOut: '登录已过期或已在别处退出。本页的修改还在：请在新的标签页中用同一个账户登录，然后回到这里保存',
  /**
   * 持有编辑权的页面没有人登录了（M3-P1）：编辑权绑定这次登录（P1 设计 §3.4.1），重新登录之后它已经失效，回到这里也保存不了
   * （自动续上在 P2）。不再说"回到这里保存"
   */
  signedOutEditing: '登录已过期或已在别处退出，编辑权随之失效，本页不能再保存。本页的修改还在：需要的话先把内容复制出来；在新的标签页中登录之后，重新加载这一页再编辑',
  loginInNewTab: '在新标签页中登录',
  otherUser: '别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后可以继续保存；也可以先复制出本页的内容',
  /** 持有编辑权的页面换了人（M3-P1）：编辑权绑定原来的登录，原来的账户重新登录之后也保存不了（自动续上在 P2） */
  otherUserEditing: '别的标签页登录了另一个账户，本页不能再保存：编辑权随原来的登录失效了。本页的修改还在，需要的话先把内容复制出来',
  otherUserBeforeReload: '别的标签页登录了另一个账户，重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载',
  retrySave: '请求已失效，请再保存一次',
  // 文档被删除、移走或失去权限之后的保存（M2 总设计 A14，M2-P6 复核 S8）：本页的修改留在页面上，存不进去了
  saveGone: '这份表格已经被删除、移走，或者你已经没有访问权限，本页的修改没有保存。需要的话先把内容复制出来。',
  saveDenied: (reason: string) => `${reason}，本页的修改没有保存。需要的话先把内容复制出来。`,
  sessionCheckFailed: (reason: string) => `暂时无法确认登录状态：${reason}`,
} as const
