// 界面文字（规范 §2.4）：简体中文，集中在 shared/i18n，组件里不散写。服务端的说明只是默认值，界面按错误码显示这里的文字。
// 这个文件是平台页面首屏用到的部分（经 shared/i18n/index.ts 给出）：页框、登录与账户、空间页与整理、错误与按错误码的提示、人名。
// 只给按需加载的页面用的文案按功能各放一个文件（同目录的 admin.ts、members.ts、colleagues.ts、trash.ts、search.ts），
// 编辑器页的在 editor.ts：各功能按路径引用自己那份，不进平台页面的首屏（M2-P6 复核第二批；lint 的模块边界限定谁能引用）
import type { DocumentType, ErrorCode, LinkInvalidReason, OneTimeLinkPurpose, SpaceRole, SpaceType, UserStatus } from '@nerve-office/contracts'
import { FOLDER_MAX_DEPTH } from '@nerve-office/contracts'

/**
 * 原因取决于服务端的状态、界面自己判断不了的错误码：显示服务端这次给出的说明（ADR-008 的例外；ADR-006：服务端的说明只写面向用户的内容）。
 * PERMISSION_DENIED 的同一个 403 可能是"空间已归档，只能查看"、"编辑者只能删除自己创建的文档"、"不能转移到自己的个人空间"……
 * 一律说成"没有权限"就盖掉了真正的原因（M2-P6 复核 S5）
 */
const SERVER_EXPLAINS = Symbol('服务端的说明')

/**
 * 按错误码显示的提示。每个错误码都要有一项（Record 而不是 Partial：新增错误码时编译期就要求补上文案，M2-P6 复核 G3）；
 * 前端还不认识的错误码（服务端比前端新）用服务端的说明。
 */
const ERROR_MESSAGES: Record<ErrorCode, string | typeof SERVER_EXPLAINS> = {
  REQUEST_INVALID: '请求的内容不合法，请检查后重试',
  UNAUTHENTICATED: '请先登录',
  // 组件里显示这条时，运行时已在向服务端确认会话（复验 N3）：真的没有会话会整页转到登录页（那里另有"登录已过期"的说明），
  // 留在页面上的只有"还是同一个人、这个请求带的是换令牌之前的旧 Cookie"这一种，所以说成这次没有完成、可以重试
  SESSION_EXPIRED: '登录状态刚刚变化，这次操作没有完成，请重试',
  INVALID_CREDENTIALS: '用户名或密码错误',
  // 全局处理随即向服务端确认会话（ADR-008）：还是同一个人就换上新的令牌、页面不动，再点一次就行；换了人或已经退出时整页重新加载。
  // 不叫人刷新：刷新会丢掉表单里的输入（M2-P6 复核 G3）
  CSRF_TOKEN_INVALID: '登录状态刚刚更新，这次操作没有完成，请再试一次',
  ORIGIN_NOT_ALLOWED: '请求来源不被允许，请从本站的地址访问',
  PERMISSION_DENIED: SERVER_EXPLAINS,
  FOLDER_HAS_OTHERS_DOCUMENTS: '这个文件夹里有别人创建的文档，只有空间管理员能删除',
  CURRENT_PASSWORD_INCORRECT: '当前密码不正确',
  NOT_FOUND: '内容不存在，或者你没有访问权限',
  ADMIN_ALREADY_INITIALIZED: '系统管理员已经初始化，不能重复执行',
  LAST_ADMIN: '至少要保留一个有效的系统管理员',
  USERNAME_TAKEN: '这个登录名已被账户占用，或者已有待接受的邀请',
  ACCOUNT_DISABLED: '这个账户已停用',
  ACCOUNT_UNAVAILABLE: '这个账户不存在或已停用',
  ACCOUNT_NOT_DISABLED: '账户仍然有效：只有停用的账户才能转移文档',
  SPACE_NAME_TAKEN: '已有同名的团队空间（大小写、全角与半角、空格的种类与个数、看不见的字符都不算区别，已归档的也算）',
  ALREADY_MEMBER: '这个人已经是空间的成员',
  LAST_SPACE_ADMIN: '团队空间至少要保留一个空间管理员',
  SPACE_ARCHIVED: '目标空间已归档',
  FOLDER_DEPTH_EXCEEDED: `文件夹最多 ${FOLDER_MAX_DEPTH} 层：这样新建或移动会超过层数上限（移动时连同里面的子文件夹一起算）`,
  FOLDER_CYCLE: '不能把文件夹移动到它自己或它的子文件夹里',
  TRANSFER_CONFLICT: '有文档已经不在这个人的个人空间里（可能被别人转走了），请刷新后重试',
  LINK_INVALID: '链接无效或已失效，请联系管理员重新发送',
  DOCUMENT_REVISION_CONFLICT: '别处保存了更新的版本',
  // 编辑租约（M3-P1）：编辑器页按 details 另有具体的说明（谁在编辑、是不是自己，失效的原因），这里是通用的说法。
  // 同一个人在另一个标签页或设备上编辑也会得到它，所以不说"别人"
  EDIT_LEASE_HELD: '这份文档正在别处编辑，现在不能编辑',
  EDIT_LEASE_LOST: '编辑权已失效，这次操作没有生效',
  REQUEST_ID_CONFLICT: '请求已失效，请重试',
  PAYLOAD_TOO_LARGE: '内容超过容量上限',
  UNSUPPORTED_MEDIA_TYPE: '请求的格式不受支持，请刷新页面后重试',
  SNAPSHOT_INVALID: '表格内容的格式不正确，无法保存',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试',
  INTERNAL_ERROR: '服务器出了点问题，请稍后重试',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试',
}

/** 错误码对应的提示：服务端说明原因的错误码（SERVER_EXPLAINS）用服务端这次的说明 */
function errorText(code: ErrorCode, serverMessage: string): string {
  const text = ERROR_MESSAGES[code]
  return text === SERVER_EXPLAINS ? serverMessage : text
}

/** 一次性链接不能用时，按用途与原因给出下一步（M2-P1 设计 §3.4） */
const LINK_INVALID_MESSAGES: Record<OneTimeLinkPurpose, Record<LinkInvalidReason, string>> = {
  invitation: {
    invalid: '邀请链接无效：请检查链接是否完整，或者请管理员重新发送',
    expired: '邀请链接已过期，请管理员重新发送',
    used: '这个邀请已经接受过了，请直接登录',
    revoked: '邀请链接已作废，请管理员重新发送',
  },
  password_reset: {
    invalid: '重置链接无效：请检查链接是否完整，或者请管理员重新发送',
    expired: '重置链接已过期，请管理员重新发送',
    used: '这个重置链接已经用过了，请直接用新密码登录',
    revoked: '重置链接已作废，请管理员重新发送',
  },
}

/** 地址里没有一次性链接的令牌（例如令牌去掉之后刷新了页面）：要重新打开发来的链接（审查 B10） */
const LINK_MISSING_MESSAGES: Record<OneTimeLinkPurpose, string> = {
  invitation: '请重新打开发给你的邀请链接。为了安全，链接打开之后会从地址栏里去掉，所以刷新页面后要重新打开它。',
  password_reset: '请重新打开发给你的重置链接。为了安全，链接打开之后会从地址栏里去掉，所以刷新页面后要重新打开它。',
}

const DOCUMENT_TYPE_NAMES: Record<DocumentType, string> = {
  sheet: '表格',
}

const SPACE_TYPE_NAMES: Record<SpaceType, string> = { personal: '个人空间', team: '团队空间' }
const SPACE_ROLE_NAMES: Record<SpaceRole, string> = { admin: '空间管理员', editor: '编辑者', viewer: '查看者' }

/** 一个人：显示名与登录名 */
interface Person {
  readonly displayName: string
  readonly username: string
}

/** 登录名在界面上的写法：前面带 @，与显示名分开呈现（M2-P6 复核 M2） */
function usernameText(username: string): string {
  return `@${username}`
}

/**
 * 纯文字里的人名（确认框的标题、aria-label、title）：登录名在最前（前面带 @），后面是显示名，用 FSI…PDI（U+2068…U+2069）隔离，
 * 里面从右到左的文字不打乱两边的字。登录名只含 [a-z0-9._-]、全库唯一；显示名是本人填的，什么都能写（需求方 2026-10-01 的决定），
 * 可以写成"李四 @lisi"——放在后面的显示名冒充不了开头，读屏用户从第一个词就分得清是谁（M2-P6 复核第二批 M-1：
 * 原来显示名在前，"李四 @lisi"与"李四 @lisi @eve"开头相同）。界面上一律用 PersonName（shared/ui，同样登录名在前），
 * 只有拼进纯文字的地方用这个。显示名本身不含双向控制字符（名称的规则，contracts 的 text.ts），隔离不会被它打断
 */
function personText(person: Person): string {
  // eslint-disable-next-line no-restricted-syntax -- 这里就是纯文字里人名的写法本身（登录名在前、显示名隔离），别处经 messages.people.text 用它
  return `${usernameText(person.username)} \u2068${person.displayName}\u2069`
}

const USER_STATUS_NAMES: Record<UserStatus, string> = { active: '有效', disabled: '已停用' }

/**
 * 句子里嵌着一段内容（人名在界面上用 PersonName 呈现）：按顺序的几段，组件逐段渲染（shared/ui 的 Phrase），
 * 纯文字的地方传进 personText 的结果、再用 phraseText 拼起来
 */
export type Phrase<T> = readonly (string | T)[]

/** 纯文字的句子：各段拼起来 */
export function phraseText(phrase: Phrase<string>): string {
  return phrase.join('')
}

/**
 * 写操作的结果未知（以及之后的拒绝说明上一次多半已经生效）之后，说明里"列表刷新了没有"那一句（M2-P6 复核第四批）：
 * 刷新好了说"已刷新"；没能刷新（刷新失败，或者到了时限还没回来：shared/api/write-outcome.ts 的 refreshIfUnknown）时，
 * 说显示的可能还是之前的、请稍后再看，不说"已刷新"。list 是刷新的是什么（默认"列表"，成员页是"成员列表"）
 */
function listRefreshed(refreshed: boolean, list = '列表'): string {
  return refreshed ? `${list}已刷新` : `${list}没能刷新，显示的可能还是之前的，请稍后再看`
}

export const messages = {
  app: {
    name: 'NerveOffice',
    navigating: '正在打开页面…',
    /** 浏览器标签页上的标题（WCAG 2.4.2，M2-P6 复核 S4）：页面的名称在前，产品名在后 */
    pageTitle: (title: string) => `${title} - NerveOffice`,
    /** 管理界面的名称：页头的入口与管理界面的标题共用 */
    admin: '管理',
  },
  /** 人名（M2-P6 复核 M2）：界面上用 PersonName（shared/ui），纯文字的地方用 text */
  people: {
    username: usernameText,
    text: personText,
    /** 账户的状态：管理界面的账户页与成员页共用 */
    statusName: (status: UserStatus) => USER_STATUS_NAMES[status],
  },
  common: {
    retry: '重试',
    backHome: '回到首页',
    requestId: (id: string) => `请求标识：${id}`,
    close: '关闭',
    cancel: '取消',
    loadMore: '加载更多',
    loadingMore: '正在加载…',
    all: '全部',
    working: '正在处理…',
    /** 表格里每行的操作按钮的可读名称：带上对象，例如"停用 @amy 艾米"（审查 B14）。管理界面与成员页共用 */
    actionOn: (action: string, target: string) => `${action} ${target}`,
    /**
     * 按状态幂等的写操作结果未知（M2-P6 复核第二批 G-2，shared/api 的 writeFailureText）：可能已经生效，页面随即按服务端现在的状态刷新；
     * 再试是安全的
     */
    outcomeUnknown: (reason: string) => `没能确认是否已经完成（${reason}）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。`,
    /** 同上，随后的刷新也失败了、或者到了时限还没回来（M2-P6 复核第三批 G-a）：页面上的可能还是之前的状态，不能说"已刷新" */
    outcomeUnknownNotRefreshed: (reason: string) => `没能确认是否已经完成（${reason}）。可能已经生效，只是页面没能刷新，显示的可能还是之前的状态：请稍后再看；确认还没有生效的话，可以再试一次。`,
    listRefreshed,
    /**
     * 写操作成功之后的刷新到了时限还没回来（Codex 对抗评审 CX4，shared/api/write-outcome.ts 的 refreshAfterSuccess）：操作已经完成，
     * 列表还在后台刷新，好了随之更新；有了结果之后不再显示（shared/ui/still-refreshing.tsx）。list 是刷新的是什么（默认"列表"）
     */
    stillRefreshing: (list = '列表') => `${list}还在刷新，显示的可能还是之前的，刷新好了会自动更新`,
    /** 列表留着之前的数据、重新请求却失败了（Codex 对抗评审 CX5，shared/ui/refresh-problem.tsx）：明说没能刷新，旧的内容照常显示 */
    refreshFailed: (list = '列表') => `${list}没能刷新，显示的还是之前的内容`,
  },
  errors: {
    byCode: errorText,
    network: '网络连接失败，请检查网络后重试',
    unexpected: '出了点问题，请稍后重试',
    tooManyAttempts: (minutes: number) => `尝试次数过多，请 ${minutes} 分钟后再试`,
  },
  auth: {
    loginTitle: '登录',
    loginDescription: '用你的用户名和密码登录',
    username: '用户名',
    password: '密码',
    submit: '登录',
    submitting: '正在登录…',
    sessionExpired: '登录已过期，请重新登录',
    // 修改密码的结果未知、再提交时登录已经失效：多半是上一次已经改好，当前的会话随之撤销了（M2-P6 复核 G-1）
    passwordMaybeChanged: '刚才修改密码时没能确认结果，随后登录失效了：新密码可能已经生效，请试试用新密码登录。',
    // 为自己生成重置链接的结果未知、再试时登录已经失效：多半是上一次已经生成，密码随之失效、会话全部撤销了，链接却没能显示（M2-P6 复核 S1）
    passwordMaybeReset: '刚才为自己生成重置链接时没能确认结果，随后登录失效了：你的密码可能已经失效，那条链接也已经找不回来。请联系另一位系统管理员为你生成新的重置链接。',
    // 停用自己的结果未知、随后登录失效了：多半是已经停用，会话随之撤销了（M2-P6 复核第五批 G1）
    accountMaybeDisabled: '刚才停用自己的账户时没能确认结果，随后登录失效了：你的账户可能已经被停用。需要继续使用的话，请联系另一位系统管理员重新启用。',
    checkingSession: '正在确认登录状态…',
    logout: '退出',
    loggingOut: '正在退出…',
    logoutFailed: (reason: string) => `退出失败：${reason}`,
  },
  account: {
    changePassword: '修改密码',
    changePasswordDescription: '修改之后，你在其他设备上的登录都会退出，这里保持登录。',
    currentPassword: '当前密码',
    newPassword: '新密码',
    confirmPassword: '再输入一次新密码',
    passwordRule: (min: number) => `至少 ${min} 个字符，不要求字符种类`,
    passwordMismatch: '两次输入的新密码不一致',
    changing: '正在修改…',
    changed: '密码已修改。你在其他设备上的登录已经退出。',
    // 结果未知（网络中断、服务端出错、回包读不出来）：请求可能已经生效（M2-P6 复核 G-1）
    outcomeUnknown: (reason: string) => `没能确认密码是否已经改好（${reason}）。新密码可能已经生效：可以再提交一次；如果随后被要求重新登录，请试试用新密码登录。`,
    // 结果未知之后再提交，当前密码不对：多半是上一次已经改好了
    maybeChangedAlready: '当前密码不正确。上一次提交可能已经把密码改好了：请试试把新密码当作当前密码；如果随后被要求重新登录，请用新密码登录。',
    username: '登录名',
    displayName: '显示名',
    goToLogin: '去登录',
    link: {
      invitation: {
        title: '接受邀请',
        description: '设置密码后即可登录。',
        password: '设置密码',
        submit: '设置密码并登录',
        checking: '正在核对邀请链接…',
      },
      password_reset: {
        title: '重置密码',
        description: '设置新密码后即可登录；你在其他地方的登录都已退出。',
        password: '新密码',
        submit: '设置新密码并登录',
        checking: '正在核对重置链接…',
      },
      submitting: '正在设置…',
      invalid: (purpose: OneTimeLinkPurpose, reason: LinkInvalidReason) => LINK_INVALID_MESSAGES[purpose][reason],
      missing: (purpose: OneTimeLinkPurpose) => LINK_MISSING_MESSAGES[purpose],
    },
  },
  spaces: {
    navLabel: '空间',
    toggleNav: '空间',
    personal: '我的空间',
    /** 左侧导航里的"与我共享"（M2-P5）：别人单独分享给我的文档；页面的文案随页面按需加载（shared-with-me.ts） */
    sharedWithMe: '与我共享',
    /**
     * 别人的个人空间（搜索结果与"与我共享"，M2-P5）：按所有者的人名呈现（人名组件），不用个人空间存的名称——那是所有者建号时的显示名，
     * 可以伪造（规范 §2.4）。自己的个人空间写"我的空间"（documents.title）
     */
    personalSpaceOf: <T>(owner: T): Phrase<T> => [owner, ' 的个人空间'],
    teamHeading: '团队空间',
    /** 导航与空间页的骨架屏名称不同：分得清是哪一处在加载（审查 B10） */
    navLoading: '正在加载空间列表…',
    loading: '正在加载空间…',
    loadFailed: '空间列表加载失败',
    /** 导航留着之前的空间列表、刷新却失败了（Codex 对抗评审 CX5）："空间列表没能刷新，显示的还是之前的内容" */
    listName: '空间列表',
    noTeamSpaces: '还没有加入团队空间',
    archived: '已归档',
    archivedName: (name: string) => `${name}（已归档）`,
    visibleToAll: '全员可见',
    typeName: (type: SpaceType) => SPACE_TYPE_NAMES[type],
    roleName: (role: SpaceRole) => SPACE_ROLE_NAMES[role],
    myRole: (role: SpaceRole) => `我的角色：${SPACE_ROLE_NAMES[role]}`,
    archivedNotice: '这个空间已归档，只能查看。',
    /** 看不到这个空间时页面的标题（G5：这类页面也要有 h1）与说明 */
    notFoundTitle: '空间不存在',
    notFound: '空间不存在，或者你没有访问权限',
    pageLoadFailed: '空间加载失败',
    members: '成员',
    rename: '改名',
    renameLabel: '空间名称',
    save: '保存',
    saving: '正在保存…',
    cancel: '取消',
    // 页头的操作被拒绝（M2-P6 复核 S2、S5）：页头随即按新的权限重画，按钮与表单可能已经不在，原因写在一条说明里
    renameDenied: (reason: string) => `没能改名：${reason}`,
  },
  documents: {
    title: '我的空间',
    listLabel: '文档列表',
    empty: '这里还没有文档',
    loading: '正在加载文档列表…',
    loadFailed: '文档列表加载失败',
    loadMore: '加载更多',
    loadingMore: '正在加载…',
    typeName: (type: DocumentType) => DOCUMENT_TYPE_NAMES[type],
    updatedAt: (time: string) => `更新于 ${time}`,
    create: '新建表格',
    creating: '正在新建…',
    createFailed: (reason: string) => `新建表格失败：${reason}`,
    // 结果未知（M2-P6 复核 M1）：带着 requestId，再点沿用同一个，服务端不会建出第二份。列表随即刷新，没能刷新时另说（第四批）
    createOutcomeUnknown: (reason: string, refreshed: boolean) => `没能确认表格是否已经建好（${reason}）。${listRefreshed(refreshed)}；再点"新建表格"不会重复新建。`,
    // 结果未知之后服务端认出那个 requestId 已经用掉了：上一次多半已经建好
    createdEarlier: (refreshed: boolean) => `上一次新建可能已经建好（当时没能确认结果），${listRefreshed(refreshed)}：先在列表里找找它；还要另建一份时再点"新建表格"。`,
    // 服务端说这是重放（M2-P6 复核第二批 S-1）：结果未知的那一次其实已经建好了，这次没有再建；它可能已经改了名、换了位置。
    // 不直接打开它：很久以后想另建一份时，打开的会是改过名的那一份。这件事随之了结，再点就是新建一份
    createdReplayed: (title: string) => `上一次新建其实已经完成（当时没能确认结果），这次没有再建一份：就是「${title}」。还要另建一份时，再点"新建表格"。`,
    openReplayed: '打开它',
    createDenied: (reason: string) => `没能新建表格：${reason}`,
  },
  /** 文件夹、行内的整理操作与回收站的入口（M2-P4） */
  organize: {
    // 面包屑与文件夹
    breadcrumbLabel: '位置',
    folderListLabel: '文件夹列表',
    folderLoading: '正在加载文件夹…',
    folderLoadFailed: '文件夹列表加载失败',
    folderTruncated: (max: number) => `这一层的文件夹超过 ${max} 个，只显示前 ${max} 个`,
    locationNotFound: '这个文件夹不存在，或者你没有访问权限',
    // 路径中间的文件夹被挪到了同一个空间的别处（M2-P6 复核 G2）：它的上一层已经没有它，这条路径不再成立
    locationMoved: '这个位置已经变了：路径上的文件夹被移到了别处。请回到空间的根目录重新找它。',
    backToSpaceRoot: '回到空间的根目录',
    newFolder: '新建文件夹',
    newFolderName: '文件夹名称',
    creatingFolder: '正在新建…',
    createFolderFailed: (reason: string) => `新建文件夹失败：${reason}`,
    // 结果未知（M2-P6 复核 M1）：带着 requestId，原样再提交不会重复新建。列表随即刷新，没能刷新时另说（第四批）
    createFolderOutcomeUnknown: (reason: string, refreshed: boolean) => `没能确认文件夹是否已经建好（${reason}）。${listRefreshed(refreshed)}；原样再提交一次不会重复新建。`,
    // 结果未知之后改了名再提交：服务端认出那个 requestId 已经用掉了，上一次多半已经建好
    createFolderEarlier: (refreshed: boolean) => `上一次新建可能已经建好（当时没能确认结果），${listRefreshed(refreshed)}：先看看列表里是否已经有它；还要另建时再提交一次。`,
    // 服务端说这是重放（M2-P6 复核第二批 S-1）：结果未知的那一次其实已经建好了（同一个位置、同一个名称），这次没有再建
    createFolderReplayed: (name: string) => `上一次新建其实已经完成（当时没能确认结果），这次没有再建一个：文件夹「${name}」已经在列表里了。`,
    // 新建被拒绝（403：空间刚被归档、自己刚被降为查看者；404：这个位置已经不在了）：表单随即关掉，原因写在说明里（M2-P6 复核 S2）
    createFolderDenied: (reason: string) => `没能新建文件夹：${reason}`,
    // 行内操作：可读名称一律是"操作 对象"
    actions: '操作',
    actionsOn: (name: string) => `操作 ${name}`,
    loadingActions: '正在确认可以做哪些操作…',
    actionsFailed: (reason: string) => `没能确认可以做哪些操作：${reason}`,
    rename: '改名',
    renameLabel: (name: string) => `${name} 的新名称`,
    move: '移动',
    copy: '复制',
    delete: '删除',
    /** 分享（M2-P5）：只有能分享时（canShare）出现；对话框按需加载，它的文案在 sharing.ts */
    share: '分享',
    save: '保存',
    saving: '正在保存…',
    cancel: '取消',
    // 选目标位置（行内的两级选择：先选空间，再一层层点进文件夹）
    targetSpace: '目标空间',
    // 复制的目标只在能新建的空间里选（M2 Codex 评审复验的一般 1）：这些空间还没取到、取不到、一个也没有时这样说
    targetSpacesLoading: '正在加载可以复制到的空间…',
    targetSpacesLoadFailed: (reason: string) => `可以复制到的空间没能加载：${reason}`,
    noTargetSpaces: '没有可以复制到的空间：你在任何空间里都不能新建文档。',
    targetLocation: '目标位置',
    targetLoading: '正在加载目标位置…',
    targetLoadFailed: (reason: string) => `目标位置加载失败：${reason}`,
    targetEmpty: '这里没有子文件夹',
    enterFolder: (name: string) => `进入 ${name}`,
    upOneLevel: '上一级',
    moveHere: '移动到这里',
    copyHere: '复制到这里',
    moving: '正在移动…',
    copying: '正在复制…',
    sameLocation: '它已经在这里了',
    // 结果与说明
    // 改名与新建文件夹平时不另外说明（列表随即刷新，看得见）；成功之后的刷新到了时限还没回来时才说，接着说列表还在刷新（Codex 对抗评审 CX4）
    renamed: (from: string, to: string) => `已把「${from}」改名为「${to}」`,
    folderCreated: (name: string) => `已新建文件夹「${name}」`,
    moved: (name: string, location: string) => `已把「${name}」移动到${location}`,
    copied: (title: string) => `已复制出「${title}」`,
    openCopy: '打开副本',
    deleted: (name: string) => `已把「${name}」移到回收站`,
    deleting: '正在删除…',
    goToTrash: '打开回收站',
    trash: '回收站',
    // 结果未知（M2-P6 复核 S1）：列表随即刷新，没能刷新时另说（第四批）。删除与移动会让那一行消失，说明写在列表上方；
    // 改名与复制留在面板里，可以原样再提交
    renameOutcomeUnknown: (reason: string, refreshed: boolean) => `没能确认是否已经改好（${reason}）。${listRefreshed(refreshed)}；可以再保存一次。`,
    copyOutcomeUnknown: (reason: string) => `没能确认是否已经复制（${reason}）。再点一次不会重复复制。`,
    copiedEarlier: (refreshed: boolean) => `上一次复制可能已经完成（当时没能确认结果），${listRefreshed(refreshed)}：先到目标位置看看；还要再复制一份时再点一次。`,
    // 服务端说这是重放（M2-P6 复核第二批 S-1）：结果未知的那一次其实已经复制好了，这次没有再复制；再点就是再复制一份
    copyReplayed: (title: string) => `上一次复制其实已经完成（当时没能确认结果），这次没有再复制一份：副本就是「${title}」。还要再复制一份时，再复制一次。`,
    moveOutcomeUnknown: (name: string, reason: string, refreshed: boolean) => `没能确认「${name}」是否已经移动（${reason}）。${listRefreshed(refreshed)}：它已经不在这里，就是移走了；还在的话可以再移动一次。`,
    deleteOutcomeUnknown: (name: string, reason: string, refreshed: boolean) => `没能确认「${name}」是否已经删除（${reason}）。${listRefreshed(refreshed)}：它已经不在这里，就是已经移到回收站了；还在的话可以再删除一次。`,
    // 操作被拒绝（M2-P6 复核 S2、S3、S5）：面板随即收起，页面按新的权限重新请求，说明写在列表上方。
    // 列表刷新好了没有按刷新的结果说（第五批 G3）
    gone: (name: string, refreshed: boolean) => `「${name}」已经不在这里了（可能已经删除，或者被别人移走了），${listRefreshed(refreshed)}。`,
    targetOrItemGone: (name: string, refreshed: boolean) => `「${name}」或者目标位置已经不在了（可能被删除或移走），${listRefreshed(refreshed)}。`,
    denied: (name: string, reason: string) => `「${name}」的操作没有完成：${reason}`,
  },
  /** 页头里的搜索框（M2-P4）：只带着关键词跳到搜索结果页；结果页的文案随它按需加载（search.ts） */
  searchBox: {
    label: '按标题搜索文档',
    placeholder: '搜索文档',
    submit: '搜索',
  },
  notFound: {
    title: '页面不存在',
    description: '你要找的页面不存在，或者已经移走。',
  },
  errorPage: {
    title: '页面出错了',
    // 没有请求标识时不提它（M2-P6 复核 S6）
    description: '页面遇到了意外的问题。可以重新加载试试；问题一直出现时，请告诉管理员。',
    descriptionWithRequestId: '页面遇到了意外的问题。可以重新加载试试；问题一直出现时，把下面的请求标识告诉管理员。',
    reload: '重新加载',
  },
  /**
   * 组件级的按需加载（M2-P5 S3：平台页面文档的行操作里的分享对话框；编辑器页的页头静态引用它，用不到这里）：
   * 点了入口才下载它的代码。没能下载下来时入口自己说明（shared/ui/chunk-load-notice.tsx），原因的判断与路由级共用；
   * 不自动整页重新加载（页面上可能有用户正在做的事），"重试"整页重新加载（浏览器记住了失败的模块，在这一页里再下载也还是失败）
   */
  lazyFeature: {
    loading: (feature: string) => `正在打开${feature}…`,
    offline: (feature: string) => `没能加载${feature}：连不上服务器，请检查网络后重试。`,
    missing: (feature: string) => `没能加载${feature}：它的代码没能下载下来（服务器连得上，版本也没有变）。可以重试；一直这样的话，请告诉管理员。`,
    updated: (feature: string) => `没能加载${feature}：服务器上已经部署了新版本，这个页面还是旧的。重试（重新加载页面）之后就能用了。`,
    retry: '重试',
  },
  /**
   * 按需加载的页面的代码没能下载下来（M2-P6 复核 S6）。部署了新版本时整页重新加载，通常不出现这里的说明；
   * 连不上服务器与服务器连得上、分块却下载不下来分开说（第二批 G-4）：后者不是网络的问题，重试不好时要告诉管理员；
   * 部署了新版本、却没能自动换上的另说（第三批 G-c）
   */
  routeLoadFailed: {
    title: '页面没能加载',
    offline: '连不上服务器，请检查网络后重试。',
    missing: '这个页面的代码没能下载下来（服务器连得上，版本也没有变）。可以重试；一直这样的话，请告诉管理员。',
    // 服务器上已经是新版本，这个页面没能自动换上它：已经为它重新加载过一次，或者会话存储不可用、为防循环不自动重新加载（第三批 G-c）
    updated: '服务器上已经部署了新版本，这个页面没能自动换上它。可以重试（重新加载页面）；一直这样的话，请告诉管理员。',
    retry: '重试',
  },
} as const
