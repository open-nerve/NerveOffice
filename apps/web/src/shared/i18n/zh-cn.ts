// 界面文字（规范 §2.4）：简体中文，集中在这里，组件里不散写。服务端的说明只是默认值，界面按错误码显示这里的文字。
import type { AuditAction, DocumentType, ErrorCode, InvitationStatus, LinkInvalidReason, OneTimeLinkPurpose, SpaceRole, SpaceStatus, SpaceType, TrashEntryKind, UserStatus, UserSystemRole } from '@nerve-office/contracts'
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

/** 审计动作的名称（M2-P1 设计 §3.7）；前端还不认识的动作显示原文 */
const AUDIT_ACTION_NAMES: Record<AuditAction, string> = {
  'auth.login_succeeded': '登录成功',
  'auth.login_failed': '登录失败',
  'auth.logout': '退出',
  'auth.link_rejected': '一次性链接被拒',
  'users.admin_initialized': '初始化系统管理员',
  'users.invited': '签发邀请',
  'users.invitation_revoked': '作废邀请',
  'users.invitation_accepted': '接受邀请',
  'users.password_changed': '修改密码',
  'users.password_change_failed': '修改密码失败',
  'users.password_reset_issued': '签发重置链接',
  'users.password_reset_completed': '重置密码',
  'users.password_reset_revoked': '作废重置链接',
  'users.login_unlocked': '解除登录锁定',
  'users.disabled': '停用账户',
  'users.enabled': '启用账户',
  'users.system_role_changed': '变更系统角色',
  'spaces.created': '创建团队空间',
  'spaces.renamed': '空间改名',
  'spaces.visibility_changed': '设置全员可见',
  'spaces.archived': '归档空间',
  'spaces.restored': '恢复空间',
  'spaces.member_added': '添加成员',
  'spaces.member_role_changed': '调整成员角色',
  'spaces.member_removed': '移出成员',
  'spaces.admin_joined': '系统管理员加入空间',
  'documents.created': '新建文档',
  'documents.content_saved': '保存文档',
  'documents.transferred': '转移文档',
  'documents.renamed': '文档改名',
  'documents.moved': '移动文档',
  'documents.copied': '复制文档',
  'documents.deleted': '删除文档',
  'documents.restored': '恢复文档',
  'documents.purged': '永久删除文档',
  'folders.created': '新建文件夹',
  'folders.renamed': '文件夹改名',
  'folders.moved': '移动文件夹',
  'folders.deleted': '删除文件夹',
  'folders.restored': '恢复文件夹',
  'folders.purged': '永久删除文件夹',
}

function isAuditAction(action: string): action is AuditAction {
  return Object.hasOwn(AUDIT_ACTION_NAMES, action)
}

const DOCUMENT_TYPE_NAMES: Record<DocumentType, string> = {
  sheet: '表格',
}

/** 回收站里一个删除单元的种类（M2-P4）：一份文档，或者一个文件夹连同它的整棵子树 */
const TRASH_ENTRY_KIND_NAMES: Record<TrashEntryKind, string> = { document: '文档', folder: '文件夹' }

const SPACE_TYPE_NAMES: Record<SpaceType, string> = { personal: '个人空间', team: '团队空间' }
const SPACE_ROLE_NAMES: Record<SpaceRole, string> = { admin: '空间管理员', editor: '编辑者', viewer: '查看者' }
const SPACE_STATUS_NAMES: Record<SpaceStatus, string> = { active: '正常', archived: '已归档' }

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
 * 纯文字里的人名（确认框的标题、aria-label、title）：显示名用 FSI…PDI（U+2068…U+2069）隔离，里面从右到左的文字不打乱两边的字；
 * 登录名另外标出（前面带 @）。显示名是本人填的，可以写成"李四（lisi）"：界面上一律用 PersonName（shared/ui，显示名与登录名分开呈现），
 * 只有拼进纯文字的地方用这个（M2-P6 复核 M2）。显示名本身不含双向控制字符（名称的规则，contracts 的 text.ts），隔离不会被它打断
 */
function personText(person: Person): string {
  return `\u2068${person.displayName}\u2069 ${usernameText(person.username)}`
}

/**
 * 句子里嵌着一段内容（人名在界面上用 PersonName 呈现）：按顺序的几段，组件逐段渲染（shared/ui 的 Phrase），
 * 纯文字的地方传进 personText 的结果、再用 phraseText 拼起来
 */
export type Phrase<T> = readonly (string | T)[]

/** 纯文字的句子：各段拼起来 */
export function phraseText(phrase: Phrase<string>): string {
  return phrase.join('')
}

export const messages = {
  app: {
    name: 'NerveOffice',
    navigating: '正在打开页面…',
    /** 浏览器标签页上的标题（WCAG 2.4.2，M2-P6 复核 S4）：页面的名称在前，产品名在后 */
    pageTitle: (title: string) => `${title} - NerveOffice`,
  },
  /** 人名（M2-P6 复核 M2）：界面上用 PersonName（shared/ui），纯文字的地方用 text */
  people: {
    username: usernameText,
    text: personText,
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
  admin: {
    title: '管理',
    /** 管理界面各页在浏览器标签页上的标题（M2-P6 复核 S4），例如"账户 - 管理" */
    pageTitle: (page: string) => `${page} - 管理`,
    navLabel: '管理界面',
    nav: { users: '账户', invitations: '邀请', spaces: '团队空间', audit: '审计' },
    noPermission: '只有系统管理员能打开管理界面。',
    /** 表格里每行的操作按钮的可读名称：带上对象，例如"停用 艾米（amy）"（审查 B14） */
    actionOn: (action: string, target: string) => `${action} ${target}`,
    roleName: (role: UserSystemRole) => ({ admin: '系统管理员', member: '成员' })[role],
    statusName: (status: UserStatus) => ({ active: '有效', disabled: '已停用' })[status],
    users: {
      search: '按名字或登录名搜索',
      statusFilter: '状态',
      listLabel: '账户列表',
      loading: '正在加载账户…',
      loadFailed: '账户列表加载失败',
      empty: '没有符合条件的账户',
      columns: { username: '登录名', displayName: '显示名', role: '角色', status: '状态', createdAt: '创建时间', actions: '操作' },
      disable: '停用',
      enable: '启用',
      grantAdmin: '设为系统管理员',
      revokeAdmin: '取消系统管理员',
      resetPassword: '生成重置链接',
      confirmDisable: (name: string) => `停用 ${name}？`,
      disableDescription: '停用后，这个人立即不能访问任何页面与接口，也不能登录。随时可以重新启用。',
      // 对自己的操作另给说明（审查 B4）：停用自己之后本人立即退出，只能由另一位系统管理员重新启用
      confirmDisableOwn: '停用你自己的账户？',
      disableOwnDescription: '停用后你立即退出，不能再登录，只能由另一位系统管理员重新启用。至少要保留一个有效的系统管理员。',
      confirmEnable: (name: string) => `启用 ${name}？`,
      enableDescription: '启用后这个人可以照常登录。停用期间转移走的文档不会回到他的个人空间。',
      transfer: '转移文档',
      confirmGrantAdmin: (name: string) => `把 ${name} 设为系统管理员？`,
      grantAdminDescription: '系统管理员可以管理账户、邀请与审计，默认看不到任何人的文档内容。',
      confirmRevokeAdmin: (name: string) => `取消 ${name} 的系统管理员？`,
      revokeAdminDescription: '取消后这个人不能再打开管理界面。至少要保留一个有效的系统管理员。',
      confirmRevokeOwnAdmin: '取消你自己的系统管理员？',
      revokeOwnAdminDescription: '取消后你立即不能再打开管理界面，只能由另一位系统管理员重新授予。至少要保留一个有效的系统管理员。',
      // 签发重置链接时，服务端把这个账户的密码换成不可用的，并撤销这个人的全部会话（审查 A7、A12）
      confirmReset: (name: string) => `为 ${name} 生成重置链接？`,
      resetDescription: (hours: number) => `生成后，这个人的当前密码立即失效，所有地方的登录都会退出。链接 ${hours} 小时内有效，只显示这一次，请交给本人。`,
      confirmResetOwn: '为你自己生成重置链接？',
      resetOwnDescription: (hours: number) => `生成后，你自己的登录会立即退出，当前密码随即失效，之后用这个链接设置新密码。链接 ${hours} 小时内有效，只显示这一次，请先复制保存。`,
      // 生成重置链接的结果未知（M2-P6 复核 S1）：服务端可能已经让密码失效、撤销了会话，链接却只在响应里出现一次
      resetOutcomeUnknown: (reason: string) => `没能确认重置链接是否已经生成（${reason}）。如果已经生成，这个人的当前密码已经失效，链接却没能显示：可以再生成一次，之前那一条随即作废。`,
      resetOwnOutcomeUnknown: (reason: string) => `没能确认重置链接是否已经生成（${reason}）。如果已经生成，你的密码已经失效、登录也已退出，那条链接找不回来：再试时会回到登录页，请联系另一位系统管理员为你生成新的重置链接。`,
      // 登录锁定（M2-P6 复核 A1），到时自动解除：只按用户名的上限到了，这个账户在所有来源上都登录不了；
      // 只锁了某些来源（按用户名与来源的组合）时，本人从别的来源照常登录
      loginLocked: (until: string) => `登录已锁定，到 ${until} 解除`,
      loginLockedSomeSources: (until: string) => `部分来源的登录已锁定，到 ${until} 解除`,
      unlockLogin: '解除锁定',
      confirmUnlockLogin: (name: string) => `解除 ${name} 的登录锁定？`,
      // 只按来源的计数（例如同一个办公网络失败太多次）不属于任何账户，解除清不掉，账户页也不显示（复验 N5）：不能说"可以立即登录"
      unlockLoginDescription: '解除后，清掉这个人在所有来源上的登录失败次数。他所在的网络如果整体被锁（同一来源失败次数太多），仍要等锁定到期。多次输错密码的来源不一定是本人：如果不是本人所为，请提醒他修改密码。',
    },
    invitations: {
      // 有效期来自 contracts 的常量（INVITATION_LIFETIME_DAYS），界面不写死天数（M2-P6 复核 S-2）
      description: (days: number) => `填好登录名与显示名，生成一次性链接（${days} 天内有效），经受控的渠道发给本人。`,
      // 签发的结果未知：邀请可能已经建好，链接却丢了，只能重新生成（M2-P6 复核 G-2）
      issueOutcomeUnknown: (reason: string) => `没能确认邀请是否已经生成（${reason}）。如果已经生成，链接不能再次显示：请在下面的列表里找到这个登录名，点"重新生成"得到新的链接（原来的随即作废）；列表里没有时，可以再生成一次。`,
      // 结果未知之后，同一个登录名再签发得到"已被占用"：多半就是刚才那一次
      issueRetryTaken: '这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次。链接不能再次显示：请在下面的列表里找到它，点"重新生成"。',
      username: '登录名',
      displayName: '显示名',
      issue: '生成邀请链接',
      issuing: '正在生成…',
      statusFilter: '状态',
      statusName: (status: InvitationStatus) => ({ pending: '待接受', accepted: '已接受', expired: '已过期', revoked: '已作废' })[status],
      listLabel: '邀请列表',
      loading: '正在加载邀请…',
      loadFailed: '邀请列表加载失败',
      empty: '还没有邀请',
      columns: { username: '登录名', displayName: '显示名', status: '状态', createdBy: '签发人', createdAt: '签发时间', expiresAt: '到期时间', actions: '操作' },
      revoke: '作废',
      reissue: '重新生成',
      confirmRevoke: (username: string) => `作废发给 ${username} 的邀请？`,
      revokeDescription: '作废后这个链接不能再用；需要时可以重新生成。',
      confirmReissue: (username: string) => `为 ${username} 重新生成邀请链接？`,
      reissueDescription: '原来的链接随即作废。',
      // 重新生成的结果未知（M2-P6 复核 S1）：新的邀请可能已经建好、原来的随即作废，新的链接却只在响应里出现一次
      reissueOutcomeUnknown: (reason: string) => `没能确认邀请链接是否已经重新生成（${reason}）。如果已经生成，原来的链接已经作废，新的链接不能再次显示：列表已刷新，请找到这个登录名最新的那一条，再点"重新生成"。`,
      // 结果未知之后再点，同一个登录名已有待接受的邀请：多半就是刚才那一次
      reissueRetryTaken: '这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次重新生成。链接不能再次显示：列表已刷新，请找到最新的那一条，再点"重新生成"。',
    },
    spaces: {
      create: '创建团队空间',
      name: '名称',
      admin: '首个空间管理员',
      visibleToAll: '全员可见：所有有效账户（包括你自己）都能以查看者的身份看到它的内容',
      creating: '正在创建…',
      pickAdmin: '请先选择首个空间管理员',
      // 创建的结果未知（M2-P6 复核 S1）：空间可能已经建好；再创建会得到"已有同名"
      createOutcomeUnknown: (reason: string) => `没能确认团队空间是否已经创建（${reason}）。列表已刷新：下面的列表里有它，就是已经建好了。`,
      createRetryTaken: '已有同名的团队空间，可能就是刚才没能确认的那一次创建。列表已刷新：请在下面的列表里找找它。',
      search: '按名称搜索',
      statusFilter: '状态',
      statusName: (status: SpaceStatus) => SPACE_STATUS_NAMES[status],
      listLabel: '团队空间列表',
      loading: '正在加载团队空间…',
      loadFailed: '团队空间列表加载失败',
      empty: '没有符合条件的团队空间',
      columns: { name: '名称', status: '状态', visibility: '全员可见', members: '成员数', myRole: '我的角色', createdAt: '创建时间', actions: '操作' },
      visibleYes: '是',
      visibleNo: '否',
      notJoined: '没有加入',
      members: '成员',
      rename: '改名',
      renameTitle: (name: string) => `给 ${name} 改名`,
      renameSave: '保存',
      renameDescription: '团队空间的名称不能与别的团队空间相同（大小写、全角与半角、空格的种类与个数、看不见的字符都不算区别，已归档的也算）。',
      showToAll: '设为全员可见',
      hideFromAll: '取消全员可见',
      confirmShow: (name: string) => `把 ${name} 设为全员可见？`,
      // 系统管理员也在"所有有效账户"之中：打开之后他不必加入也能看到内容（需求方 2026-10-01 确认的规则），确认框里写明
      showDescription: '打开之后所有有效账户都能以查看者的身份看到这个空间里的内容，包括你自己。',
      confirmHide: (name: string) => `取消 ${name} 的全员可见？`,
      hideDescription: '不是成员的人随即看不到这个空间。',
      archive: '归档',
      restore: '恢复',
      confirmArchive: (name: string) => `归档 ${name}？`,
      archiveDescription: '归档之后所有人只能查看，不能新建与编辑；可以随时恢复。',
      confirmRestore: (name: string) => `恢复 ${name}？`,
      restoreDescription: '恢复之后，成员按原来的角色继续使用。',
      join: '加入空间',
      joinTitle: (name: string) => `加入 ${name}`,
      // 加入的结果未知（M2-P6 复核 S1）：可能已经加入；再加入会得到"已经是成员"
      joinOutcomeUnknown: (reason: string) => `没能确认是否已经加入（${reason}）。列表已刷新：这个空间的"我的角色"不再是"没有加入"，就是已经加入了。`,
      joinedEarlier: '你已经是这个空间的成员了，可能就是刚才没能确认的那一次加入。列表已刷新。',
      joinDescription: '系统管理员要看团队空间的内容，得先把自己加入这个空间（全员可见的空间不必加入，所有有效账户都能以查看者的身份看到）。加入会记入审计。',
      joinRole: '以什么角色加入',
    },
    transfer: {
      title: <T>(name: T): Phrase<T> => ['转移 ', name, ' 的文档'],
      description: '这个账户已停用。把他个人空间里的文档转移到别人的个人空间或某个团队空间；这里只看得到标题，打不开内容。',
      back: '返回账户',
      loadingAccount: '正在加载账户…',
      loadAccountFailed: '账户加载失败',
      listLabel: '个人空间里的文档',
      columns: { select: '选择', title: '标题', type: '类型', updatedAt: '更新时间' },
      loading: '正在加载文档…',
      loadFailed: '文档列表加载失败',
      empty: '个人空间里没有文档了',
      selectAll: '全选已加载的文档',
      select: (title: string) => `选择 ${title}`,
      selected: (count: number, max: number) => `已选择 ${count} 份，一次最多 ${max} 份`,
      tooMany: (max: number) => `一次最多转移 ${max} 份，请分批转移`,
      targetLegend: '转移到',
      toPersonal: '某人的个人空间',
      toTeam: '团队空间',
      // 选择的标签是选的对象（选中之后仍显示在原处，"重新选择"的可读名称也带上它），怎么找写在输入框的提示里（审查 B10）
      pickPerson: '接收文档的同事',
      pickTeam: '目标团队空间',
      teamCandidates: '找到的团队空间',
      searchTeam: '按名称搜索团队空间',
      searchingTeam: '正在查找…',
      noTeam: '没有找到没有归档的团队空间',
      teamSearchFailed: (reason: string) => `查找失败：${reason}`,
      pickTarget: '请先选择转移到哪里',
      pickDocuments: '请先选择要转移的文档',
      submit: '转移',
      personalTarget: <T>(name: T): Phrase<T> => [name, ' 的个人空间'],
      confirm: <T>(count: number, target: Phrase<T>): Phrase<T> => [`把 ${count} 份文档转移到 `, ...target, '？'],
      confirmDescription: '转移之后，目标空间的成员按各自的角色访问这些文档；这个账户重新启用之后，个人空间里不再有它们。',
      done: <T>(count: number, target: Phrase<T>): Phrase<T> => [`已把 ${count} 份文档转移到 `, ...target],
      /** 转移时有文档已经不在了（TRANSFER_CONFLICT）：列表已刷新、失效的选择已清掉，确认的弹窗随之关闭，在转移按钮旁说明（M2-P2 复验） */
      conflict: '有文档已经不在这个人的个人空间里了（可能被别人转走了）：列表已刷新，请重新选择后再转移',
    },
    link: {
      invitationTitle: '邀请链接',
      resetTitle: '重置链接',
      /** 弹窗的标题：链接的种类与发给谁 */
      title: <T>(kind: string, recipient: T): Phrase<T> => [`${kind}：`, recipient],
      label: '链接',
      once: '链接只显示这一次。请经受控的渠道（当面、公司的即时通讯等）发给本人，不要贴进公开的群聊或工单。',
      expiresAt: (time: string) => `${time} 之前有效`,
      copy: '复制链接',
      copied: '已复制',
      copyFailed: '复制失败，请选中链接后手动复制',
      ownResetNote: '你的登录已经退出：关闭之后回到登录页，打开这个链接设置新密码。',
    },
    audit: {
      from: '开始时间',
      to: '结束时间',
      // 按换算成 UTC 之后的时刻判断：东八区的 0001-01-01 05:00 在 UTC 是 0 年（复验 X5）
      invalidTime: '超出可查询的时间范围（按 UTC 计，公元 1–9999 年），这个时间没有作为条件',
      action: '动作',
      actor: '操作者',
      searchActor: '按名字找操作者',
      searchingActor: '正在查找…',
      noActor: '没有找到这个人',
      actorSearchFailed: (reason: string) => `查找失败：${reason}`,
      clear: '清除',
      clearActor: '清除操作者的筛选',
      clearTarget: '清除对象的筛选',
      listLabel: '审计事件',
      loading: '正在加载审计事件…',
      loadFailed: '审计事件加载失败',
      empty: '没有符合条件的事件',
      columns: { occurredAt: '时间', actor: '操作者', action: '动作', target: '对象', origin: '来源', details: '详情' },
      actorKind: (type: string) => ({ system: '系统', anonymous: '未登录的访问者' } as Record<string, string>)[type] ?? type,
      source: (source: string) => ({ http: '网页', cli: '命令行', job: '定时任务' } as Record<string, string>)[source] ?? source,
      targetKind: (type: string) => ({ user: '账户', space: '空间', document: '文档', invitation: '邀请', folder: '文件夹', trash_entry: '回收站条目' } as Record<string, string>)[type] ?? type,
      actionName: (action: string) => (isAuditAction(action) ? AUDIT_ACTION_NAMES[action] : action),
      onlyTarget: '只看这个对象',
      chipActor: <T>(name: T): Phrase<T> => ['操作者：', name],
      chipTarget: <T>(target: T): Phrase<T> => ['对象：', target],
      /** 对象：类型与它的名字，例如"账户：艾米 @amy" */
      target: <T>(kind: string, name: T): Phrase<T> => [`${kind}：`, name],
    },
  },
  spaces: {
    navLabel: '空间',
    toggleNav: '空间',
    personal: '我的空间',
    teamHeading: '团队空间',
    /** 导航与空间页的骨架屏名称不同：分得清是哪一处在加载（审查 B10） */
    navLoading: '正在加载空间列表…',
    loading: '正在加载空间…',
    loadFailed: '空间列表加载失败',
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
  members: {
    title: (space: string) => `${space} 的成员`,
    /** 成员页加载不出来、看不到时的标题 */
    pageTitle: '成员',
    backToSpace: '返回空间',
    backToAdmin: '返回团队空间管理',
    listLabel: '成员列表',
    loading: '正在加载成员…',
    loadFailed: '成员列表加载失败',
    readOnly: '只有空间管理员能添加、调整与移出成员。',
    archivedReadOnly: '这个空间已归档：只有系统管理员能调整成员。',
    // 系统管理员在归档的空间里仍能管理成员：同样说明已归档，调整成员不改变只读（审查 B5）
    archivedManaged: '这个空间已归档，所有人只能查看。系统管理员仍然可以调整成员，调整之后空间照样只读。',
    columns: { name: '成员', role: '角色', status: '状态', actions: '操作' },
    /** 同事选择的标签：与提交按钮"添加成员"区分开（审查 B10） */
    colleague: '要添加的同事',
    add: '添加成员',
    adding: '正在添加…',
    role: '角色',
    pickColleague: '请先选择要添加的同事',
    roleOf: (name: string) => `${name} 的角色`,
    // 角色改动经明确的"保存"才提交（M2-P6 复核的疑点）：Windows、Linux 上的 Chrome 与 Edge 在收起的选择框上按方向键直接改值，
    // 选一下就保存的话会逐个保存中间的角色
    saveRole: '保存',
    saveRoleOf: (name: string) => `保存 ${name} 的角色`,
    remove: '移出',
    confirmRemove: (name: string) => `把 ${name} 移出这个空间？`,
    removeDescription: '移出之后，这个人立即失去这个空间带来的权限；单独分享给他的文档不受影响。',
    confirmRemoveSelf: '把你自己移出这个空间？',
    removeSelfDescription: '移出之后，你立即失去这个空间带来的权限；只能由空间管理员或系统管理员重新添加。',
    /** 要移出的人已经不是成员了（404）：成员列表已刷新，确认的弹窗随之关闭，在成员表上方说明（M2-P2 复验） */
    alreadyRemoved: <T>(name: T): Phrase<T> => [name, ' 已经不在成员里了（可能已被别人移出），列表已刷新'],
    alreadyRemovedSelf: '你已经不在成员里了（可能已被别人移出），列表已刷新',
    confirmDemoteSelf: (role: SpaceRole) => `把你自己的角色改为${SPACE_ROLE_NAMES[role]}？`,
    demoteSelfDescription: '改完之后你立即失去空间管理员的权限，只能由另一位空间管理员或系统管理员改回来。',
    change: '修改',
    /** 调整一行的角色进行中（审查 B3） */
    saving: '正在保存…',
    disabled: '已停用',
    empty: '这个空间还没有成员',
    you: '（我）',
    // 添加的结果未知（M2-P6 复核 S1）：可能已经加好；再添加会得到"已经是成员"
    addOutcomeUnknown: (reason: string) => `没能确认是否已经添加（${reason}）。成员列表已刷新：这个人在列表里，就是已经加好了。`,
    addedEarlier: '这个人已经是空间的成员了（可能就是刚才没能确认的那一次添加），成员列表已刷新。',
  },
  colleagues: {
    search: '按名字或登录名搜索同事',
    searching: '正在查找…',
    none: '没有找到这个人',
    failed: (reason: string) => `查找失败：${reason}`,
    candidates: '找到的同事',
    selected: <T>(name: T): Phrase<T> => ['已选择：', name],
    change: '重新选择',
    /** "重新选择"的可读名称带上选的是什么，例如"重新选择 首个空间管理员"（审查 B10） */
    changeOf: (label: string) => `重新选择 ${label}`,
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
    // 结果未知（M2-P6 复核 M1）：带着 requestId，再点沿用同一个，服务端不会建出第二份
    createOutcomeUnknown: (reason: string) => `没能确认表格是否已经建好（${reason}）。列表已刷新；再点"新建表格"不会重复新建。`,
    // 结果未知之后服务端认出那个 requestId 已经用掉了：上一次多半已经建好
    createdEarlier: '上一次新建可能已经建好（当时没能确认结果），列表已刷新：请先在列表里找找它；还要另建一份时再点"新建表格"。',
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
    // 结果未知（M2-P6 复核 M1）：带着 requestId，原样再提交不会重复新建
    createFolderOutcomeUnknown: (reason: string) => `没能确认文件夹是否已经建好（${reason}）。列表已刷新；原样再提交一次不会重复新建。`,
    // 结果未知之后改了名再提交：服务端认出那个 requestId 已经用掉了，上一次多半已经建好
    createFolderEarlier: '上一次新建可能已经建好（当时没能确认结果），列表已刷新：请先看看列表里是否已经有它；还要另建时再提交一次。',
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
    save: '保存',
    saving: '正在保存…',
    cancel: '取消',
    // 选目标位置（行内的两级选择：先选空间，再一层层点进文件夹）
    targetSpace: '目标空间',
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
    moved: (name: string, location: string) => `已把「${name}」移动到${location}`,
    copied: (title: string) => `已复制出「${title}」`,
    openCopy: '打开副本',
    deleted: (name: string) => `已把「${name}」移到回收站`,
    deleting: '正在删除…',
    goToTrash: '打开回收站',
    trash: '回收站',
    // 结果未知（M2-P6 复核 S1）：列表随即刷新。删除与移动会让那一行消失，说明写在列表上方；改名与复制留在面板里，可以原样再提交
    renameOutcomeUnknown: (reason: string) => `没能确认是否已经改好（${reason}）。列表已刷新，可以再保存一次。`,
    copyOutcomeUnknown: (reason: string) => `没能确认是否已经复制（${reason}）。再点一次不会重复复制。`,
    copiedEarlier: '上一次复制可能已经完成（当时没能确认结果），列表已刷新：请先到目标位置看看；还要再复制一份时再点一次。',
    moveOutcomeUnknown: (name: string, reason: string) => `没能确认「${name}」是否已经移动（${reason}）。列表已刷新：它已经不在这里，就是移走了；还在的话可以再移动一次。`,
    deleteOutcomeUnknown: (name: string, reason: string) => `没能确认「${name}」是否已经删除（${reason}）。列表已刷新：它已经不在这里，就是已经移到回收站了；还在的话可以再删除一次。`,
    // 操作被拒绝（M2-P6 复核 S2、S3、S5）：面板随即收起，页面按新的权限重新请求，说明写在列表上方
    gone: (name: string) => `「${name}」已经不在这里了（可能已经删除，或者被别人移走了），列表已刷新。`,
    targetOrItemGone: (name: string) => `「${name}」或者目标位置已经不在了（可能被删除或移走），列表已刷新。`,
    denied: (name: string, reason: string) => `「${name}」的操作没有完成：${reason}`,
  },
  trash: {
    title: '回收站',
    heading: (space: string) => `${space} 的回收站`,
    backToSpace: '返回空间',
    retention: (days: number) => `删除的内容在回收站里保留 ${days} 天，到期后自动永久删除。`,
    /** 恢复的规则（access-rules.ts 的 trashPermissionsOf）：空间管理员，或者仍有编辑者及以上角色的删除者（审查建议 4） */
    readOnly: '能恢复的是空间管理员，以及删除它的人（要仍有编辑者及以上的角色）；永久删除只有空间管理员能做。',
    listLabel: '回收站列表',
    loading: '正在加载回收站…',
    loadFailed: '回收站加载失败',
    empty: '回收站里没有内容',
    columns: { name: '名称', deletedBy: '删除者与时间', origin: '原位置', expiresAt: '到期', actions: '操作' },
    kindName: (kind: TrashEntryKind) => TRASH_ENTRY_KIND_NAMES[kind],
    documentCount: (count: number) => `${count} 份文档`,
    unknownUser: '（账户已注销）',
    originRoot: '空间的根目录',
    originGone: '原位置已不存在',
    originIn: (folder: string) => `文件夹「${folder}」`,
    restore: '恢复',
    restoring: '正在恢复…',
    restored: (name: string) => `已恢复「${name}」`,
    restoredToRoot: (name: string) => `「${name}」原来的位置已经不在了，已恢复到空间的根目录`,
    purge: '永久删除',
    confirmPurge: (name: string) => `永久删除「${name}」？`,
    purgeDescription: '永久删除之后内容就找不回来了，里面的文档与它们的历史一并清除。',
    purged: (name: string) => `已永久删除「${name}」`,
    /** 别人已经动过它（恢复或永久删除）：列表刷新之后在上方说明 */
    gone: '这一条已经不在回收站里了（可能已被别人恢复或永久删除），列表已刷新',
    // 恢复的结果未知（M2-P6 复核 S1）
    restoreOutcomeUnknown: (name: string, reason: string) => `没能确认「${name}」是否已经恢复（${reason}）。列表已刷新：它已经不在回收站里，就是恢复好了。`,
    // 恢复被拒绝（403，例如空间刚被归档）：列表与页头按新的权限重新请求，原因写在说明里（M2-P6 复核 S2、S5）
    denied: (name: string, reason: string) => `没能恢复「${name}」：${reason}`,
  },
  search: {
    title: '搜索文档',
    boxLabel: '按标题搜索文档',
    submit: '搜索',
    heading: (keyword: string) => `“${keyword}”的搜索结果`,
    noKeyword: '输入关键词后按“搜索”，按标题查找你能访问的文档。',
    sortNote: '按标题匹配，最近更新在前。',
    listLabel: '搜索结果',
    loading: '正在搜索…',
    loadFailed: '搜索失败',
    empty: (keyword: string) => `没有找到标题包含“${keyword}”的文档（回收站里的不算）`,
    /** 结果里的位置：空间名，以及从空间根目录到它所在文件夹的路径 */
    location: (space: string, folderPath: readonly string[]) => [space, ...folderPath].join(' / '),
  },
  editor: {
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
    loginInNewTab: '在新标签页中登录',
    otherUser: '别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后可以继续保存；也可以先复制出本页的内容',
    otherUserBeforeReload: '别的标签页登录了另一个账户，重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载',
    retrySave: '请求已失效，请再保存一次',
    // 文档被删除、移走或失去权限之后的保存（M2 总设计 A14，M2-P6 复核 S8）：本页的修改留在页面上，存不进去了
    saveGone: '这份表格已经被删除、移走，或者你已经没有访问权限，本页的修改没有保存。需要的话先把内容复制出来。',
    saveDenied: (reason: string) => `${reason}，本页的修改没有保存。需要的话先把内容复制出来。`,
    sessionCheckFailed: (reason: string) => `暂时无法确认登录状态：${reason}`,
    pageTitle: (title: string) => `${title} - NerveOffice`,
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
  /** 按需加载的页面的代码没能下载下来（断网，或者部署之后旧的分块已经不在，M2-P6 复核 S6） */
  routeLoadFailed: {
    title: '页面没能加载',
    description: '请检查网络后重试。',
    retry: '重试',
  },
} as const
