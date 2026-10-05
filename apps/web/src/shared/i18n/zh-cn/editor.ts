// 表格编辑器页的文案（P4）：只由编辑器页（features/sheet-editor）引用，随编辑器页的入口加载，不进平台页面的首屏（lint 的模块边界限定）。
// 两个入口共用的（通用的说明、错误与登录状态）在 messages.ts
import type { SnapshotRule } from '@nerve-office/contracts'
import type { Phrase } from './messages.ts'
import { EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'

/**
 * 是自己在另一个标签页或设备上编辑时的补充：刚关闭、刷新过的那个页面没能放掉编辑权（释放没送到，或者载入中就离开了），
 * 那一代不再续租，最多一个有效期（EDIT_LEASE_TTL_SECONDS）就到期（M3-P1 审查 B7）。时长取自契约，有效期改了说法跟着改
 */
const SELF_ELSEWHERE_HINT = `要是刚刚关闭或刷新过那个页面，那边的编辑权最多 ${EDIT_LEASE_TTL_SECONDS} 秒后自动结束，到时再点"编辑"就能编辑`

/**
 * 快照被服务端拒绝时按违反的规则给的说法（SNAPSHOT_INVALID 的 details.rule，M3-P3 设计 §3.10）：链接、图片、资源各一类，
 * 嵌套与数量、检查用的内存超限合成"过于复杂"；不认识的规则（以后的 Phase 加的）照"格式不正确"说
 */
const SNAPSHOT_RULE_PHRASES: Readonly<Record<SnapshotRule, string>> = {
  'encoding': '表格内容的格式不正确',
  'json': '表格内容的格式不正确',
  'structure': '表格内容的格式不正确',
  'depth': '表格的内容过于复杂（嵌套太深）',
  'entries': '表格的内容过于复杂（元素太多）',
  'too-complex': '表格的内容过于复杂',
  'resources': '表格的插件数据不正确',
  'resource-duplicate': '表格的插件数据不正确',
  'resource-unknown': '表格里有不支持的插件数据',
  'resource-data': '表格的插件数据不正确',
  'resource-not-empty': '表格里有不支持的功能的数据（例如保护）',
  'resource-missing': '表格里缺少上一版有的内容（例如批注、筛选、条件格式），为免丢失没有保存',
  'image-source': '表格里有不能保存的图片',
  'link-structure': '表格里有不能保存的链接',
  'link-address': '表格里有不能保存的链接',
  'link-range-id': '表格里有不能保存的链接',
  'unit-id': '表格内容不属于这份文档',
}

/**
 * 失效的说明的结尾（M3-P2 设计 §3.4）：本页有没有还没确认的内容 × 还读不读得到这份文档。
 * 读得到而且有修改：另存为副本或放弃（副本被拒、再试也一样时不再提副本，copyable 为假，下一段另有说明，M3-P3 审查 B3）；
 * 读不到了（404）：说明，本页的内容不再能保存（M3 总设计 §2.1 第 4 条）——页面上还显示着本页的内容时提一句先复制出来；
 * 编辑器没能重新打开、什么也显示不了（shown 为假，审查 A3）时不提
 */
function lostEnding(unsaved: boolean, readable: boolean, shown: boolean, copyable: boolean): string {
  if (unsaved) {
    if (readable)
      return copyable ? '本页的修改没有保存：可以另存为副本，或者放弃这些修改。' : '本页的修改没有保存。'
    return shown ? '本页的修改没有保存，也不能再保存到这份文档，需要的话先把内容复制出来。' : '本页的修改没有保存，也不能再保存到这份文档。'
  }
  return readable ? '本页的修改都已保存，重新加载可以看到最新的版本。' : '本页的修改都已保存。'
}

/** 超过容量上限（保存时本页先算出来，另存为副本时服务端回答 PAYLOAD_TOO_LARGE） */
const CAPACITY_EXCEEDED = '表格超过容量上限（5 MiB）'

export const editorMessages = {
  back: '我的空间',
  loading: '正在打开表格…',
  /** 页头的文档详情（标题、所在的空间、能不能分享）没能刷新时的说法："文档信息没能刷新，显示的还是之前的内容"（DEF-040） */
  detail: '文档信息',
  save: '保存',
  saveShortcut: (keys: string) => `保存（${keys}）`,
  status: {
    'clean': '已保存到云端',
    'dirty': '有未保存的修改',
    'saving': '保存中…',
    'conflict': '版本冲突',
    'failed': '保存失败',
    'readOnly': '只能查看',
    /** 编辑权失效之后的保存状态（M3 总设计 §6.5）：不能再保存 */
    'leaseLost': '编辑权已失效',
    /** 本页的版本过旧（CLIENT_OUTDATED，M3-P3）：需要刷新（M3 总设计 §6.5 的页面状态） */
    'outdated': '需要刷新',
    /** 文档由更新的版本保存过（DOCUMENT_TOO_NEW，M3-P3）：不能再保存 */
    'too-new': '不能保存',
  },
  /**
   * 与服务端不兼容（M3-P3 设计 §3.5、§3.10）：本页的版本过旧（服务端更新了数据格式，或者运维要求旧页面都刷新）——重新加载就是新的页面；
   * 文档由更新的版本保存过（服务端回滚之后）——重新加载拿到的还是同一个版本，只能阅读，不提示刷新
   */
  incompatible: {
    /** 编辑时得知本页过旧（保存或心跳）：本页的修改有没有保存（unsaved）决定说法；M4 之前没有发件箱，刷新会丢掉没保存的修改 */
    outdatedEditing: (unsaved: boolean) => unsaved
      ? '页面的版本过旧，本页的修改没有保存，也不能再保存。需要的话先把内容复制出来，再重新加载页面'
      : '页面的版本过旧，不能再保存。本页的修改都已保存，重新加载页面之后可以接着编辑',
    /** 阅读时（申请编辑权时得知，或者编辑时得知之后退出了编辑）：不能进入编辑 */
    outdatedReading: '页面的版本过旧，不能进入编辑。重新加载页面之后再编辑',
    /** 文档由更新的版本保存过：打开时就看得出（详情的 sdkVersion），或者申请编辑权时得知 */
    tooNewReading: '这份文档由更新的版本保存过，当前只能阅读，不能编辑',
    /** 编辑时得知文档由更新的版本保存过 */
    tooNewEditing: (unsaved: boolean) => unsaved
      ? '这份文档由更新的版本保存过，本页的修改不能再保存。需要的话先把内容复制出来'
      : '这份文档由更新的版本保存过，当前只能阅读，不能再保存',
  },
  /**
   * 快照达到容量的 80%（US-M3-14，00 号计划书 §7.7）：不打断的说明，percent 是最近一次捕获占上限的百分比（向下取整）
   */
  nearCapacity: (percent: number) => `这份表格已用去容量上限（5 MiB）的 ${percent}%，再加内容可能就保存不了了`,
  /** 快照被服务端拒绝（SNAPSHOT_INVALID）：按违反的规则说（不认识的规则照"格式不正确"说） */
  snapshotInvalid: (rule: SnapshotRule | undefined) => rule === undefined ? '表格内容的格式不正确' : SNAPSHOT_RULE_PHRASES[rule],
  /**
   * 编辑权（M3-P1 设计 §3.4.7、M3-P2 设计 §3.4）：别处正在编辑时说明是谁；失效时说明原因，读得到时给另存为副本、放弃或重新加载。
   * 编辑权中断（到期、空闲回收、换了登录、被接手等）先自动续上，续上了就不说明；这里的失效是续不上、或者失去了访问或编辑权
   */
  editing: {
    /**
     * 别人正在编辑（持有者经人名组件显示）；lastActive 是"最后活动……"，服务端没给出时为 undefined。
     * canEdit：能编辑的人另说"你现在只能阅读"（等他放下编辑权才能编辑）；查看者本来就只能查看（页头已经说了），只说谁在编辑
     */
    elsewhere: <T>(holder: T, lastActive: string | undefined, canEdit: boolean): Phrase<T> => [holder, ` 正在编辑这份文档${lastActive === undefined ? '' : `（${lastActive}）`}${canEdit ? '，你现在只能阅读' : ''}`],
    /** 持有者最后一次操作在几分钟之前（服务端回答时，向下取整） */
    lastActive: (minutes: number) => minutes < 1 ? '最后活动不到 1 分钟前' : `最后活动 ${minutes} 分钟前`,
    /** reenter：这一页能再点"编辑"（与服务端不兼容的阅读不给"编辑"，不提它，M3-P3 审查 B8） */
    elsewhereBySelf: (reenter: boolean) => `你在另一个标签页或设备上正在编辑这份文档，这里只能阅读${reenter ? `。${SELF_ELSEWHERE_HINT}` : ''}`,
    /**
     * 编辑状态里是"自己在别处编辑"，而本页刚退出编辑、没能确认放掉编辑权（释放的结果未知或超过了等待的上限，审查 A13）：多半就是本页的那一代
     * （同一个页面再申请照样取得），不说成另一个标签页或设备；那一代至多一个有效期后自行到期。reenter 同上
     */
    elsewhereThisPage: (reenter: boolean) => `本页刚退出编辑，编辑权还没能确认放掉：最多 ${EDIT_LEASE_TTL_SECONDS} 秒后自动结束，这期间别人还不能编辑${reenter ? '；这一页可以直接再点"编辑"' : ''}`,
    /** 服务端给的详情认不出时的通用说法 */
    elsewhereUnknown: '这份文档正在别处编辑，你现在只能阅读',
    /**
     * 失效的说明：cause 是原因（几段，人名经人名组件呈现；不认识的原因为 undefined，只说编辑权已失效）；
     * unsaved 是本页还有服务端没确认的内容（没有时不说"没有保存"，审查 B3）；readable 是还读得到这份文档
     * （读不到了时不提另存为副本与重新加载，审查 B2）；shown 是页面上还显示着本页的内容（编辑器没能重新打开时为假，审查 A3）；
     * copyable 是还能另存为副本（副本被拒、再试也一样时为假，M3-P3 审查 B3）
     */
    lost: <T>(cause: Phrase<T> | undefined, unsaved: boolean, readable: boolean, shown = true, copyable = true): Phrase<T> => [
      '编辑权已失效',
      ...(cause === undefined ? [] : ['：', ...cause]),
      `。${lostEnding(unsaved, readable, shown, copyable)}`,
    ],
    /** 编辑权被收回（明确收回，或者持有者已经不能编辑） */
    lostRevoked: '你对这份文档的编辑权被收回了',
    /** 读不到这份文档了（404，与不存在一致） */
    lostNotFound: '你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）',
    /** 读得到却不能编辑了（403）：reason 是服务端这次给的原因（例如"空间已归档，只能查看"，不用笼统的"没有权限"盖掉，M2-P6 复核 S5） */
    lostDenied: (reason: string) => `你已没有编辑这份文档的权限（${reason}）`,
    /** 续上时别人正在编辑（持有者经人名组件呈现）；lastActive 是"最后活动……"，服务端没给出时为 undefined */
    lostHeldBy: <T>(holder: T, lastActive: string | undefined): Phrase<T> => [holder, ` 正在编辑这份文档${lastActive === undefined ? '' : `（${lastActive}）`}`],
    lostHeldBySelf: `你在另一个标签页或设备上正在编辑这份文档（${SELF_ELSEWHERE_HINT}）`,
    lostHeldUnknown: '这份文档正在别处编辑',
    /** 续上时发现编辑权中断期间别处保存了更新的版本：不覆盖它（可以另存为副本） */
    lostNewer: '编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它',
  },
  /** 阅读与编辑（M3-P2 设计 §3.4）：打开即阅读，点"编辑"进入编辑，"退出编辑"回到阅读；模式切换一律重建编辑器 */
  mode: {
    enter: '编辑',
    entering: '正在进入编辑…',
    exit: '退出编辑',
    exiting: '正在退出编辑…',
    /** 失去编辑权之后正在捕获本页的内容、换成只读的编辑器 */
    losing: '编辑权已失效，正在保留本页的内容…',
    /** 阅读者的更新提示（US-M3-05）：别处保存了新的版本 */
    update: '有更新，点击刷新',
    updating: '正在载入最新的版本…',
    /** 有更新时读屏状态区里的说明（审查 A6）：页头的按钮之外，读屏也听得到；正在载入时说 updating */
    updateAvailable: '这份文档有更新的版本',
    /** 阅读时读不到这份文档了（编辑状态、进入编辑或刷新时得到 404）：页面上还是之前打开的内容 */
    gone: '你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限），这里显示的是之前打开的内容',
    /** 进入编辑时不能编辑了（403）：reason 是服务端这次给的原因 */
    denied: (reason: string) => `没能进入编辑：你已没有编辑这份文档的权限（${reason}）`,
    /** 进入编辑没有成功（网络、服务端出错等）：可以再试 */
    enterFailed: (reason: string) => `没能进入编辑：${reason}`,
    /** 进入编辑时，编辑权在编辑器建好之前就失效了：cause 同失效的原因 */
    enterLost: <T>(cause: Phrase<T> | undefined): Phrase<T> => ['没能进入编辑：编辑权已失效', ...(cause === undefined ? [] : ['（', ...cause, '）'])],
    /** 以编辑方式重建编辑器失败：已经释放编辑权、回到阅读 */
    editorFailed: '编辑器没能以编辑方式打开，已回到阅读，可以再试一次',
    /** "有更新"之后没能取到最新的版本 */
    refreshFailed: (reason: string) => `没能载入最新的版本：${reason}`,
    /** 另存为副本成功：新文档在新标签页打开 */
    copied: (title: string) => `已另存为副本《${title}》。`,
    openCopy: '打开副本（新标签页）',
  },
  /** 失去编辑权之后（M3-P2 设计 §3.4）：还读得到而且有修改时另存为副本或放弃；有一次结果未知的保存时先核对它 */
  lost: {
    checking: '正在核对最后一次保存的结果…',
    saveCopy: '另存为副本',
    savingCopy: '正在另存为副本…',
    copyFailed: (reason: string) => `没能另存为副本：${reason}。本页的内容还在，可以再试一次`,
    /**
     * 副本被拒、再试也一样（M3-P3 审查 B3）：本页的版本过旧——服务端对副本同样拦旧页面；重新加载会丢掉本页没保存的修改
     * （M4 之前没有发件箱），先说明复制出来。不再给"另存为副本"
     */
    copyOutdated: '页面的版本过旧，不能另存为副本。需要的话先把内容复制出来，再重新加载页面',
    /** 同上，内容本身不能保存：problem 是按违反的规则（或容量）的说法，不说"可以再试" */
    copyRefused: (problem: string) => `没能另存为副本：${problem}。这份内容不能另存为副本，需要的话先把内容复制出来，或者放弃这些修改`,
    discard: '放弃本页的修改',
    discardTitle: '放弃本页的修改？',
    discardDescription: '本页没有保存的修改会被丢弃，页面改为显示服务端的最新版本。需要的话先把内容复制出来，或者另存为副本。',
    discardConfirm: '放弃修改',
    reloading: '正在载入最新的版本…',
    reloadFailed: (reason: string) => `没能载入最新的版本：${reason}`,
    /** 捕获本页的内容时编辑器出错：编辑器留着（还能复制），不给副本 */
    captureFailed: '本页的修改没能取出（编辑器出了问题）。需要的话先把内容复制出来，再重新加载',
    /** 单元格里正在输入的那一处提交不了（编辑器提交之后仍在编辑，审查 A4）：取出的内容里没有它，别的修改照常在 */
    inputLeft: '单元格里正在输入的那一处没能取出（编辑器没有提交它），本页的内容里没有它，另存为副本也不含它',
    /**
     * 以只读重建编辑器失败（审查 A3）：页面上没有表格；本页的内容已经取出，copyable（还读得到而且有修改）时另存为副本照常可用
     */
    reopenFailed: (copyable: boolean) => `编辑器没能重新打开，表格暂时显示不出来${copyable ? '；本页的修改已经取出，另存为副本照常可用' : ''}`,
  },
  finishCellEditing: '请先完成单元格的编辑',
  tooLarge: `${CAPACITY_EXCEEDED}，无法保存`,
  /** 超过容量上限这件事本身（另存为副本被拒时的说法里用） */
  capacityExceeded: CAPACITY_EXCEEDED,
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
  /** 阅读时（以及只能查看）没有人登录了：没有修改、也不能保存，不提它们（M3-P1 审查 B10） */
  signedOutReadOnly: '登录已过期或已在别处退出。请在新的标签页中用同一个账户登录，然后回到这里继续',
  loginInNewTab: '在新标签页中登录',
  otherUser: '别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后可以继续保存；也可以先复制出本页的内容',
  /** 阅读时换了人：同上，不提保存 */
  otherUserReadOnly: '别的标签页登录了另一个账户。原来的账户重新登录之后，这一页可以接着使用',
  otherUserBeforeReload: '别的标签页登录了另一个账户，重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载',
  retrySave: '请求已失效，请再保存一次',
  sessionCheckFailed: (reason: string) => `暂时无法确认登录状态：${reason}`,
} as const
