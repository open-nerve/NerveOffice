// 表格编辑器页的文案（P4）：只由编辑器页（features/sheet-editor）引用，随编辑器页的入口加载，不进平台页面的首屏（lint 的模块边界限定）。
// 两个入口共用的（通用的说明、错误与登录状态）在 messages.ts
import type { Phrase } from './messages.ts'

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
  /**
   * 编辑权（M3-P1 设计 §3.4.7）：别处正在编辑时只能阅读；失效时说明原因、提供重新加载。
   * 编辑权中断（到期、空闲回收、换了登录、被接手等）先自动续上，续上了就不说明；这里的失效是续不上、或者失去了访问或编辑权
   */
  editing: {
    /** 别人正在编辑（持有者经人名组件显示）；lastActive 是"最后活动……"，服务端没给出时为 undefined */
    elsewhere: <T>(holder: T, lastActive: string | undefined): Phrase<T> => [holder, ` 正在编辑这份文档${lastActive === undefined ? '' : `（${lastActive}）`}，你现在只能阅读`],
    /** 持有者最后一次操作在几分钟之前（服务端回答时，向下取整） */
    lastActive: (minutes: number) => minutes < 1 ? '最后活动不到 1 分钟前' : `最后活动 ${minutes} 分钟前`,
    elsewhereBySelf: '你在另一个标签页或设备上正在编辑这份文档，这里只能阅读',
    /** 服务端给的详情认不出时的通用说法 */
    elsewhereUnknown: '这份文档正在别处编辑，你现在只能阅读',
    /**
     * 失效的说明：cause 是原因（几段，人名经人名组件呈现；不认识的原因为 undefined，只说编辑权已失效）；
     * unsaved 是本页还有没保存的修改（没有时不说"没有保存"）
     */
    lost: <T>(cause: Phrase<T> | undefined, unsaved: boolean): Phrase<T> => [
      '编辑权已失效',
      ...(cause === undefined ? [] : ['：', ...cause]),
      unsaved ? '。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。' : '。本页的修改都已保存，重新加载可以看到最新的版本。',
    ],
    /** 编辑权被收回（明确收回，或者持有者已经不能编辑） */
    lostRevoked: '你对这份文档的编辑权被收回了',
    /** 读不到这份文档了（404，与不存在一致） */
    lostNotFound: '你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）',
    /** 读得到却不能编辑了（403）：reason 是服务端这次给的原因（例如"空间已归档，只能查看"，不用笼统的"没有权限"盖掉，M2-P6 复核 S5） */
    lostDenied: (reason: string) => `你已没有编辑这份文档的权限（${reason}）`,
    /** 续上时别人正在编辑（持有者经人名组件呈现）；lastActive 是"最后活动……"，服务端没给出时为 undefined */
    lostHeldBy: <T>(holder: T, lastActive: string | undefined): Phrase<T> => [holder, ` 正在编辑这份文档${lastActive === undefined ? '' : `（${lastActive}）`}`],
    lostHeldBySelf: '你在另一个标签页或设备上正在编辑这份文档',
    lostHeldUnknown: '这份文档正在别处编辑',
    /** 续上时发现编辑权中断期间别处保存了更新的版本：不覆盖它（另存为副本在 P2） */
    lostNewer: '编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它',
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
  // 编辑权绑定这次登录（M3-P1 设计 §3.4.1）：重新登录之后页面自动续上编辑权，回到这里照常保存；期间别处保存过时，页头另有失效的说明
  signedOut: '登录已过期或已在别处退出。本页的修改还在：请在新的标签页中用同一个账户登录，然后回到这里保存',
  loginInNewTab: '在新标签页中登录',
  otherUser: '别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后可以继续保存；也可以先复制出本页的内容',
  otherUserBeforeReload: '别的标签页登录了另一个账户，重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载',
  retrySave: '请求已失效，请再保存一次',
  sessionCheckFailed: (reason: string) => `暂时无法确认登录状态：${reason}`,
} as const
