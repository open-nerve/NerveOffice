// 表格编辑器页的文案（P4）：只由编辑器页（features/sheet-editor）引用，随编辑器页的入口加载，不进平台页面的首屏（lint 的模块边界限定）。
// 两个入口共用的（通用的说明、错误与登录状态）在 messages.ts
import type { ProfileResourceName, SnapshotRule } from '@nerve-office/contracts'
import type { Phrase } from './messages.ts'
import { EDIT_HANDOVER_IDLE_SECONDS, EDIT_IDLE_RELEASE_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'

/** 本人接管的按钮（M3-P5 设计 §3.7）：说明里提到它时用同一个名字 */
const TAKE_OVER_HERE = '在此编辑'

/** 强制接管的按钮（M3-P5 设计 §3.8） */
const FORCE_TAKE_OVER = '强制接管'

/**
 * 能强制接管的人怎样称呼（M3-P5 设计 §3.8）：团队空间是空间管理员；个人空间里是文档的所有者（个人空间的所有者，有效角色也是空间管理员，
 * 但界面上不这样叫）
 */
function takeoverRole(personal: boolean): string {
  return personal ? '文档的所有者' : '空间管理员'
}

/** 本浏览器的另一个标签页没能交出的原因（交接频道的 handover-failed，same-browser.ts 的 HANDOVER_FAILURES：这里不引用编辑器页的模块，另写一份） */
type TakeoverFailure = 'not-saved' | 'conflict' | 'session' | 'not-handed-over'

/**
 * 本浏览器的另一个标签页没能交出（交接频道的 handover-failed，M3-P5 设计 §3.7）：按原因说那边为什么没交出
 */
const TAKEOVER_FAILURES: Readonly<Record<TakeoverFailure, string>> = {
  'not-saved': '另一个标签页的修改没能保存，没有交出编辑权',
  'conflict': '另一个标签页的修改与别处保存的版本冲突、没能保存，没有交出编辑权',
  'session': '另一个标签页暂时无法确认登录状态、没能保存，没有交出编辑权',
  // 那边的修改都已存上，只是正在把编辑权交给请求编辑的人、没交出去（请求已经不在、没有结果），留在了编辑（审查 B11）
  'not-handed-over': '另一个标签页的修改都已保存，但它在把编辑权交给请求编辑的人时没能交出去，还在编辑',
}

/** 空闲释放的阈值（分钟，US-M3-07）：时长取自契约，阈值改了说法跟着改 */
const IDLE_RELEASE_MINUTES = EDIT_IDLE_RELEASE_SECONDS / 60

/** 有人请求编辑时自动交出的空闲阈值（分钟，US-M3-06）：同上 */
const HANDOVER_IDLE_MINUTES = EDIT_HANDOVER_IDLE_SECONDS / 60

/** 请求编辑的按钮（M3-P5 设计 §3.6）：说明里提到它时用同一个名字 */
const REQUEST_EDIT = '请求编辑'
const CANCEL_REQUEST = '取消请求'
const HAND_OVER = '交出'
const KEEP_EDITING = '继续编辑'

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

/**
 * 打开自检里没能完整载入的那部分数据的说法（M3-P4 设计 §3.12）：按 sheet@1 的资源名（contracts 的白名单，档案加了资源而这里没有说法时
 * 类型检查不通过）。保护类与区域主题服务端要求为空，几乎不会出现，照样给出说法
 */
const DAMAGED_RESOURCE_PHRASES: Readonly<Record<ProfileResourceName<'sheet@1'>, string>> = {
  SHEET_CONDITIONAL_FORMATTING_PLUGIN: '条件格式',
  SHEET_DATA_VALIDATION_PLUGIN: '数据验证',
  SHEET_DEFINED_NAME_PLUGIN: '定义名称',
  SHEET_DRAWING_PLUGIN: '图片',
  SHEET_FILTER_PLUGIN: '筛选',
  SHEET_NOTE_PLUGIN: '批注',
  SHEET_RANGE_PROTECTION_PLUGIN: '保护设置',
  SHEET_WORKSHEET_PROTECTION_PLUGIN: '保护设置',
  SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN: '保护设置',
  SHEET_RANGE_THEME_MODEL_PLUGIN: '表格样式',
}

export const editorMessages = {
  back: '我的空间',
  loading: '正在打开表格…',
  /** 页头的文档详情（标题、所在的空间、能不能分享）没能刷新时的说法："文档信息没能刷新，显示的还是之前的内容"（DEF-040） */
  detail: '文档信息',
  save: '保存',
  saveShortcut: (keys: string) => `保存（${keys}）`,
  /** 页头的状态里与保存无关的几种（阅读、失去编辑权、阅读时与服务端不兼容） */
  status: {
    readOnly: '只能查看',
    /** 编辑权失效之后的保存状态（M3 总设计 §6.5）：不能再保存 */
    leaseLost: '编辑权已失效',
    /** 本页的版本过旧（CLIENT_OUTDATED，M3-P3）：需要刷新（M3 总设计 §6.5 的页面状态） */
    outdated: '需要刷新',
  },
  /**
   * 编辑时页头的保存状态（M3-P4 设计 §3.9，save-indicator.ts 的全集）。M3 没有本机的发件箱：没上传的修改只在这个页面里，
   * 一律不说"已保存在本机"（A14）
   */
  saveState: {
    /** 服务端确认到现在的修改、没有"公式待更新"、单元格里没有没提交的输入 */
    'saved': '已保存到云端',
    'unsaved': '有未保存的修改',
    'saving': '保存中…',
    /** 修改都已存上，只差公式的结果：收齐之后自动补存（含带"公式待更新"的文档进入编辑时的强制重算） */
    'formulas-pending': '公式结果尚未保存（算完之后自动保存）',
    /** 保存失败、会自动重试（原因在页头下面的说明里，重试期间保留） */
    'retrying': '保存失败，稍后自动重试',
    /** 保存失败、再试也一样：要等新的修改或者用户的操作（原因在说明里） */
    'failed': '保存失败',
    'offline': '已离线：修改还在本页，恢复网络之后自动保存',
    /** 会话不是本人（没有人登录、换了人；会话的说明另在页头下面）。本人在登录中、只是在确认或者确认失败时另有说法（pausedUnconfirmed） */
    'paused': '暂停保存：登录回来之后自动保存',
    'conflict': '版本冲突',
    /** 本页的版本过旧（CLIENT_OUTDATED，M3-P3）：需要刷新 */
    'outdated': '需要刷新',
    /** 文档由更新的版本保存过（DOCUMENT_TOO_NEW，M3-P3）：不能再保存 */
    'too-new': '不能保存',
  },
  /**
   * 自动保存暂停、本人在登录中，只是向服务端确认会话失败了（网络等，M3-P4 审查 A6）：页面在恢复联网、回到前台时与定时再确认，
   * 确认是本人之后自动保存；不说"登录回来之后"（人没有退出）
   */
  pausedUnconfirmed: '暂停保存：暂时无法确认登录状态，稍后自动重试',
  /**
   * 与服务端不兼容（M3-P3 设计 §3.5、§3.10）：本页的版本过旧（服务端更新了数据格式，或者运维要求旧页面都刷新）——重新加载就是新的页面；
   * 文档由更新的版本保存过（服务端回滚之后）——重新加载拿到的还是同一个版本，只能阅读，不提示刷新
   */
  incompatible: {
    /**
     * 编辑时得知本页过旧（保存或心跳）：本页的修改存上了没有（pending）决定说法——正在核对结果未知的那次保存（checking，核对完再下结论，
     * M3-P3 审查 B5）、修改没有保存（edits）、修改都已保存只有公式的结果没有存上（formulas）、都已保存（none）。
     * M4 之前没有发件箱，刷新会丢掉没保存的修改
     */
    outdatedEditing: (pending: 'checking' | 'edits' | 'formulas' | 'none') => {
      switch (pending) {
        case 'checking':
          return '页面的版本过旧，不能再保存。正在核对最后一次保存的结果…'
        case 'edits':
          return '页面的版本过旧，本页的修改没有保存，也不能再保存。需要的话先把内容复制出来，再重新加载页面'
        case 'formulas':
          return '页面的版本过旧，不能再保存。本页的修改都已保存，只是公式的结果没有存上；重新加载页面之后可以接着编辑'
        case 'none':
          return '页面的版本过旧，不能再保存。本页的修改都已保存，重新加载页面之后可以接着编辑'
      }
    },
    /** 阅读时（申请编辑权时得知，或者编辑时得知之后退出了编辑）：不能进入编辑 */
    outdatedReading: '页面的版本过旧，不能进入编辑。重新加载页面之后再编辑',
    /** 文档由更新的版本保存过：打开时就看得出（详情的 sdkVersion），或者申请编辑权时得知 */
    tooNewReading: '这份文档由更新的版本保存过，当前只能阅读，不能编辑',
    /** 编辑时得知文档由更新的版本保存过：pending 同上 */
    tooNewEditing: (pending: 'checking' | 'edits' | 'formulas' | 'none') => {
      switch (pending) {
        case 'checking':
          return '这份文档由更新的版本保存过，不能再保存。正在核对最后一次保存的结果…'
        case 'edits':
          return '这份文档由更新的版本保存过，本页的修改不能再保存。需要的话先把内容复制出来'
        case 'formulas':
          return '这份文档由更新的版本保存过，当前只能阅读，不能再保存。本页的修改都已保存，只是公式的结果没有存上'
        case 'none':
          return '这份文档由更新的版本保存过，当前只能阅读，不能再保存'
      }
    },
  },
  /**
   * 打开自检失败（M3-P4 设计 §3.12，US-M3-15；00 号计划书 §7.7、§8.2"文档数据不完整，已阻止编辑"）：
   * - 这份文档的数据没能完整载入（解析出错、被吞成空值、加载出错、写不出来、加载之后不在了或变空了）：能编辑的人说已阻止编辑，另说原因与去向；
   *   查看者只说显示的内容可能不完整（本来就不能编辑）；
   * - 编辑器自己没有完整载入（档案不全：构建的问题，任何文档都会这样）：请重新加载页面（给"重新加载"）
   */
  damaged: {
    blocked: '文档数据不完整，已阻止编辑',
    /** parts：没能完整载入的那几部分的说法（resource 给出，去掉重复、按出现的先后） */
    reason: (parts: readonly string[]) => `部分数据没能载入（${parts.join('、')}），继续编辑会让它们丢失。已通知管理员`,
    viewer: '文档的部分数据没能载入，显示的内容可能不完整',
    /** 编辑器没有完整载入：能编辑的人 */
    profile: '编辑器没有完整载入，已阻止编辑。请重新加载页面',
    /** 编辑器没有完整载入：查看者（本来就不能编辑，不说"已阻止编辑"） */
    profileViewer: '编辑器没有完整载入，显示的内容可能不完整。请重新加载页面',
    /** 资源名的说法；认不出的（白名单之外）是"其他数据" */
    resource: (name: string): string => Object.hasOwn(DAMAGED_RESOURCE_PHRASES, name) ? DAMAGED_RESOURCE_PHRASES[name as keyof typeof DAMAGED_RESOURCE_PHRASES] : '其他数据',
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
    /**
     * 是自己、那个页面在本浏览器的另一个标签页里（本机锁有人持有，M3-P5 设计 §3.7）。reenter：这一页给"在此编辑"（与服务端不兼容、
     * 数据不完整的阅读不给，不提它，M3-P3 审查 B8）
     */
    elsewhereThisBrowser: (reenter: boolean) => `你在本浏览器的另一个标签页里正在编辑这份文档${reenter ? `。点"${TAKE_OVER_HERE}"，那个标签页会先保存，再把编辑权交给这里` : '，这里只能阅读'}`,
    /**
     * 是自己、那个页面不在本浏览器里（另一台设备、浏览器，也可能是刚关闭、刷新过的页面：锁随页面放开了，编辑权还在服务端）。
     * "在此编辑"立即接手，那边失去编辑权（说明写清）。reenter 同上
     */
    elsewhereAway: (reenter: boolean) => `你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面）${reenter ? `。点"${TAKE_OVER_HERE}"在这里接着编辑，那边会失去编辑权，没保存的修改可以在那边另存为副本` : '，这里只能阅读'}`,
    /**
     * 编辑状态里是"自己在别处编辑"，而本页刚退出编辑、没能确认放掉编辑权（释放的结果未知或超过了等待的上限，审查 A13）：多半就是本页的那一代
     * （同一个页面再申请照样取得），不说成另一个标签页或设备；那一代至多一个有效期后自行到期。reenter 同上
     */
    elsewhereThisPage: (reenter: boolean) => `本页刚退出编辑，编辑权还没能确认放掉：最多 ${EDIT_LEASE_TTL_SECONDS} 秒后自动结束，这期间别人还不能编辑${reenter ? `；这一页可以直接点"${TAKE_OVER_HERE}"` : ''}`,
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
    /** 续上时被自己占着（另一个标签页或设备上的那一代，M3-P5 起回到阅读之后可以"在此编辑"） */
    lostHeldBySelf: '你在另一个标签页或设备上正在编辑这份文档',
    lostHeldUnknown: '这份文档正在别处编辑',
    /** 续上时发现编辑权中断期间别处保存了更新的版本：不覆盖它（可以另存为副本） */
    lostNewer: '编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它',
    /** 本人在本浏览器的另一个标签页接手了编辑（M3-P5：本页的本机锁被抢，不再问服务端） */
    lostTakenOverHere: '你在本浏览器的另一个标签页接手了编辑',
    /** 本人在另一台设备或浏览器上接手了编辑（M3-P5：续租或保存得到 taken_over、forced 为假） */
    lostTakenOverElsewhere: '你在另一台设备或浏览器上接手了编辑',
    /**
     * 强制接管了编辑（M3-P5 设计 §3.8：续租或保存得到 taken_over、forced 为真）：by 是接管的人（失去编辑权时读到的编辑状态里正在编辑的人，
     * 经人名组件呈现），没读到时为 undefined；personal 是文档在个人空间里（接管的是所有者）
     */
    lostForced: <T>(by: T | undefined, personal: boolean): Phrase<T> => by === undefined ? [`${takeoverRole(personal)}强制接管了编辑`] : [`${takeoverRole(personal)} `, by, ' 强制接管了编辑'],
    /**
     * 本页这一代已经交给了请求编辑的人（M3-P5 设计 §3.6：交出的回答没收到、留在了编辑，下一次心跳或保存才得知）：to 是交给了谁（经人名组件呈现），
     * 不知道时为 undefined
     */
    lostHandedOver: <T>(to: T | undefined): Phrase<T> => to === undefined ? ['已交给请求编辑的人'] : ['已交给请求编辑的 ', to],
    /**
     * 上一位编辑者异常中断（M3-P5 设计 §3.5、§3.11，US-M3-10）：别人的那一代（经人名组件呈现）；at 是结束的时刻（服务端的，按页面的时区写成
     * HH:mm，可能已经不是今天时带日期）。进入编辑之后页头下面的说明与读屏状态区，阅读时也说
     */
    interruptedBy: <T>(holder: T, at: string): Phrase<T> => ['上一位编辑者 ', holder, ` 的会话在 ${at} 异常中断，可能还有未同步的修改`],
    /** 同上，是自己的那一代（只在进入编辑之后说） */
    interruptedSelf: (at: string) => `你上一次的编辑在 ${at} 异常中断（例如页面被关闭、断网或电脑休眠），那时还没保存的修改可能没有存上`,
    /** 异常中断的说明里的按钮：说明消失 */
    dismissInterruption: '知道了',
    /**
     * 有人请求编辑时页头下面的提示（M3-P5 设计 §3.6，US-M3-06）：分组的标题（请求方经人名组件呈现）、两个按钮与一行静态说明（不倒计时）。
     * 提示出现时不移动焦点，读屏在一直在的状态区里播 requestAnnouncement 一次
     */
    requestTitle: <T>(requester: T): Phrase<T> => [requester, ' 请求编辑这份文档'],
    requestNote: `你停下操作 ${HANDOVER_IDLE_MINUTES} 分钟后会自动保存并交给对方`,
    handOver: HAND_OVER,
    /** "交出"之后、保存并交出的过程中：按钮留着、不可用 */
    handingOver: '正在交出…',
    keepEditing: KEEP_EDITING,
    /** 提示出现时读屏状态区里的那一句 */
    requestAnnouncement: <T>(requester: T): Phrase<T> => [requester, ` 请求编辑这份文档，可以在页头下方选择"${HAND_OVER}"或"${KEEP_EDITING}"`],
    /** 请求方取消了请求（提示随之消失） */
    requestWithdrawn: <T>(requester: T): Phrase<T> => [requester, ' 已取消请求'],
    /** 交出没有成功（没有结果、会话的问题；没存上的由保存的状态说明）：请求还在 */
    handOverFailed: (reason: string) => `没能交出编辑权：${reason}。请求还在，可以再点"${HAND_OVER}"`,
    /** 谢绝没有成功 */
    declineFailed: (reason: string) => `没能回复请求：${reason}。可以再点"${KEEP_EDITING}"`,
  },
  /** 阅读与编辑（M3-P2 设计 §3.4）：打开即阅读，点"编辑"进入编辑，"退出编辑"回到阅读；模式切换一律重建编辑器 */
  mode: {
    enter: '编辑',
    entering: '正在进入编辑…',
    /** 本人接管（M3-P5 设计 §3.7，US-M3-08）：持有者是自己（别的标签页或设备）时换掉"编辑" */
    takeOverHere: TAKE_OVER_HERE,
    /** "在此编辑"进行中（请那边交出、等刷新之前的保存）：按钮留着、不可用 */
    takingOver: '正在接手…',
    /** 本浏览器的另一个标签页没能交出之后：本人接管并抢锁（那边转为失去编辑权、给副本） */
    takeOverAnyway: '仍在此编辑',
    /** 同上，不再接手 */
    cancelTakeOver: '取消',
    /** "在此编辑"的进展，放进一直在的读屏状态区 */
    takeoverAsking: '正在请本浏览器的另一个标签页保存并交出编辑权…',
    takeoverWaitingSave: '上一个页面的保存还在进行，稍后接手…',
    /** 那边没能交出：原因，与之后能做的 */
    takeoverFailed: (reason: TakeoverFailure) => `${TAKEOVER_FAILURES[reason]}。点"仍在此编辑"在这里接着编辑（那边会失去编辑权，没保存的修改可以在那边另存为副本），或者点"取消"`,
    /**
     * 本页交给了本浏览器的另一个标签页（US-M3-08）：阅读时读屏状态区里的说明。不断言那边一定接着编辑了（审查 B4：本页存上之后只放弃这一代，
     * 那边随即以本人接管申请；它没跟上时这一代到期）
     */
    handedOverTab: '已交给本浏览器的另一个标签页',
    /** 请求编辑（M3-P5 设计 §3.6，US-M3-06）：持有者是别人、自己能编辑时换掉"编辑"；同一个按钮之后说正在请求、取消请求、正在取消 */
    requestEdit: REQUEST_EDIT,
    requesting: '正在请求…',
    cancelRequest: CANCEL_REQUEST,
    cancellingRequest: '正在取消…',
    /**
     * 等待中读屏状态区里的说明（不倒计时）：在等谁（经人名组件呈现，没人在编辑时不说是谁），他停下操作 2 分钟后会自动交过来，可以取消
     */
    requestWaiting: <T>(holder: T | undefined): Phrase<T> => holder === undefined
      ? [`已请求编辑，等待正在编辑的人回应；你也可以${CANCEL_REQUEST}`]
      : ['已请求编辑，等待 ', holder, ' 回应。', holder, ` 停下操作 ${HANDOVER_IDLE_MINUTES} 分钟后会自动保存并交给你；你也可以${CANCEL_REQUEST}`],
    /** 编辑权交给了本页（或者空着），页面在后台：回到这一页时进入编辑 */
    requestGranted: '可以进入编辑了：回到这一页时自动进入编辑',
    /** 同上，页面看得见、这一刻进入不了（会话不是本人、正在载入新的版本等，审查 B11）：一能进入就进入 */
    requestGrantedSoon: '可以进入编辑了：稍后自动进入编辑',
    /** 没取消成：请求还在 */
    cancelRequestFailed: (reason: string) => `没能取消请求：${reason}。请求还在，可以再点"${CANCEL_REQUEST}"`,
    /** 交给了请求编辑的人（持有者这一侧回到阅读之后）：auto 是空闲满 2 分钟自动交出的 */
    handedOver: <T>(to: T, auto: boolean): Phrase<T> => [auto ? `你 ${HANDOVER_IDLE_MINUTES} 分钟没有操作，已保存并把编辑权交给了 ` : '已保存并把编辑权交给了 ', to],
    /**
     * 编辑权刚交给了别人、还在保留期内（申请得到 EDIT_LEASE_RESERVED、请求得到 reservedForOther）：until 是服务端的时刻按页面的时区写成的 HH:mm；
     * forced 是强制接管时得到的（保留期内强制接管同样被挡，M3-P5 设计 §3.8）
     */
    reservedFor: <T>(person: T, until: string, forced = false): Phrase<T> => ['编辑权刚交给了 ', person, `，留到 ${until}${forced ? `，这期间不能${FORCE_TAKE_OVER}` : ''}`],
    /**
     * 持有者选了"继续编辑"：不能强制接管的人另说可以请空间管理员（个人空间里是文档的所有者）强制接管
     */
    requestDeclined: <T>(holder: T, canTakeOver: boolean, personal = false): Phrase<T> => [holder, ` 选择继续编辑，你的请求已取消${canTakeOver ? '' : `。着急时可以请${takeoverRole(personal)}${FORCE_TAKE_OVER}`}`],
    /** 强制接管（M3-P5 设计 §3.8，US-M3-09）：阅读时、别人在编辑时"请求编辑"旁边的按钮；进入编辑的过程中同一个按钮说正在接管 */
    forceTakeOver: FORCE_TAKE_OVER,
    forcingTakeover: '正在接管…',
    /** 强制接管之前的确认框 */
    forceTitle: '强制接管编辑？',
    /**
     * 确认框的说明：holder 是正在编辑的人（纯文字的写法，messages.people.text），lastActive 是"最后活动……"（服务端没给出时为 undefined）
     */
    forceDescription: (holder: string, lastActive: string | undefined) => `${holder} 正在编辑${lastActive === undefined ? '' : `（${lastActive}）`}。强制接管会立即结束对方的编辑权：对方还没保存的修改不会写进这份文档，可以在自己的页面上另存为副本。这次操作会记入审计。`,
    forceConfirm: FORCE_TAKE_OVER,
    /** 强制接管时不能了（403）：reason 是服务端这次给的原因（例如"只有空间管理员能强制接管这份文档的编辑"） */
    forceDenied: (reason: string) => `没能${FORCE_TAKE_OVER}：${reason}`,
    /** 强制接管没有成功（网络、服务端出错等）：可以再试 */
    forceFailed: (reason: string) => `没能${FORCE_TAKE_OVER}：${reason}`,
    /** 别人先请求了（单槽、先到先得）：本页的请求没有发出 */
    requestOccupied: <T>(requester: T): Phrase<T> => [requester, ' 已在请求编辑这份文档，你的请求没有发出'],
    /** 请求已经不在了（在别的页面取消了、换了一代、过期、被别人的新请求替换） */
    requestGone: `你的编辑请求已经失效（可能在别的页面取消了，或者正在编辑的人换了），可以重新${REQUEST_EDIT}`,
    /**
     * 本人在别的页面、设备上发出、正在等回应的请求，不是这一页发出的（M3-P5 审查 B2）：这一页不续期、不撤回、不自动进入；在这一页再点"请求编辑"
     * 照常发出（服务端只续期）
     */
    requestedElsewhere: '你已在别处请求编辑这份文档',
    /** 等待中本页空闲满 10 分钟，取消了 */
    requestIdle: `你 ${IDLE_RELEASE_MINUTES} 分钟没有操作，已取消编辑请求`,
    /** 发出请求时不能编辑了（403）：reason 是服务端这次给的原因 */
    requestDenied: (reason: string) => `没能请求编辑：你已没有编辑这份文档的权限（${reason}）`,
    /** 没能请求编辑（网络、服务端出错等）：可以再试 */
    requestFailed: (reason: string) => `没能请求编辑：${reason}`,
    exit: '退出编辑',
    exiting: '正在退出编辑…',
    /** 空闲释放的过程中（US-M3-07）：先保存、再释放编辑权、回到阅读 */
    idleReleasing: `${IDLE_RELEASE_MINUTES} 分钟没有操作，正在保存并释放编辑权…`,
    /** 空闲释放之后，阅读时读屏状态区里的说明 */
    idleReleased: `${IDLE_RELEASE_MINUTES} 分钟没有操作，已保存并释放编辑权`,
    /** 交出编辑权的过程中（交给请求编辑的人、本浏览器的另一个标签页，M3-P5 S6、S7） */
    handingOver: '正在保存并交出编辑权…',
    /** 失去编辑权之后正在捕获本页的内容、换成只读的编辑器 */
    losing: '编辑权已失效，正在保留本页的内容…',
    /** 阅读者的更新提示（US-M3-05）：别处保存了新的版本 */
    update: '有更新，点击刷新',
    updating: '正在载入最新的版本…',
    /** 有更新时读屏状态区里的说明（审查 A6）：页头的按钮之外，读屏也听得到；正在载入时说 updating */
    updateAvailable: '这份文档有更新的版本',
    /**
     * 本页显示的这一版"公式待更新"（M3-P4 设计 §3.5 第 4 条）：上次保存时公式还没算完。能编辑的人另说进入编辑之后会重算并保存
     * （阅读时不在本页重算）；查看者只说前半句
     */
    formulasPending: (canEdit: boolean) => `这份表格的公式结果可能还没更新（上次保存时公式还没算完）${canEdit ? '，进入编辑之后会自动重算并保存' : ''}`,
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
  saveFailed: (reason: string) => `保存失败：${reason}`,
  conflict: '别处保存了更新的版本。本页的修改没有保存；需要的话先复制出来，再重新加载查看最新版本',
  reload: '重新加载',
  notFound: '内容不存在，或者你没有访问权限',
  unsupported: '这份表格的格式比当前页面新，请刷新页面；刷新后仍然打不开，请联系管理员',
  loadFailed: (reason: string) => `表格加载失败：${reason}`,
  editorFailed: '编辑器加载失败，请刷新页面重试',
  // 编辑权绑定这次登录（M3-P1 设计 §3.4.1）：重新登录之后页面自动续上编辑权，修改随即自动保存（M3-P4）；期间别处保存过时，页头另有失效的说明
  signedOut: '登录已过期或已在别处退出。本页的修改还在：请在新的标签页中用同一个账户登录，回到这里之后会自动保存',
  /** 阅读时（以及只能查看）没有人登录了：没有修改、也不能保存，不提它们（M3-P1 审查 B10） */
  signedOutReadOnly: '登录已过期或已在别处退出。请在新的标签页中用同一个账户登录，然后回到这里继续',
  loginInNewTab: '在新标签页中登录',
  otherUser: '别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后会自动保存；也可以先复制出本页的内容',
  /** 阅读时换了人：同上，不提保存 */
  otherUserReadOnly: '别的标签页登录了另一个账户。原来的账户重新登录之后，这一页可以接着使用',
  otherUserBeforeReload: '别的标签页登录了另一个账户，重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载',
  /** 令牌失效的保存失败、会话随后确认是本人（令牌已换上）：自动保存随即重试（M3-P4），也可以按保存 */
  retrySave: '请求已失效，稍后自动重试',
  sessionCheckFailed: (reason: string) => `暂时无法确认登录状态：${reason}`,
} as const
