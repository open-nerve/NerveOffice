// 界面文字（规范 §2.4）：简体中文，集中在这里，组件里不散写。服务端的说明只是默认值，界面按错误码显示这里的文字。
import type { DocumentType, ErrorCode } from '@nerve-office/contracts'

/** 按错误码显示的提示。没有登记的错误码用服务端的说明。 */
const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  REQUEST_INVALID: '请求的内容不合法，请检查后重试',
  UNAUTHENTICATED: '请先登录',
  SESSION_EXPIRED: '登录已过期，请重新登录',
  INVALID_CREDENTIALS: '用户名或密码错误',
  CSRF_TOKEN_INVALID: '页面已失效，请刷新后重试',
  ORIGIN_NOT_ALLOWED: '请求来源不被允许，请从本站的地址访问',
  PERMISSION_DENIED: '你没有执行这个操作的权限',
  NOT_FOUND: '内容不存在，或者你没有访问权限',
  DOCUMENT_REVISION_CONFLICT: '别处保存了更新的版本',
  REQUEST_ID_CONFLICT: '请求已失效，请重试',
  PAYLOAD_TOO_LARGE: '内容超过容量上限',
  UNSUPPORTED_MEDIA_TYPE: '请求的格式不受支持，请刷新页面后重试',
  SNAPSHOT_INVALID: '表格内容的格式不正确，无法保存',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试',
  INTERNAL_ERROR: '服务器出了点问题，请稍后重试',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试',
}

const DOCUMENT_TYPE_NAMES: Record<DocumentType, string> = {
  sheet: '表格',
}

export const messages = {
  app: {
    name: 'NerveOffice',
  },
  common: {
    retry: '重试',
    backHome: '回到首页',
    requestId: (id: string) => `请求标识：${id}`,
  },
  errors: {
    byCode: (code: ErrorCode, fallback: string) => ERROR_MESSAGES[code] ?? fallback,
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
    checkingSession: '正在确认登录状态…',
    logout: '退出',
    loggingOut: '正在退出…',
    logoutFailed: (reason: string) => `退出失败：${reason}`,
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
    retrySave: '请求已失效，请再保存一次',
    pageTitle: (title: string) => `${title} - NerveOffice`,
  },
  notFound: {
    title: '页面不存在',
    description: '你要找的页面不存在，或者已经移走。',
  },
  errorPage: {
    title: '页面出错了',
    description: '页面遇到了意外的问题。可以重新加载试试；问题一直出现时，把下面的请求标识告诉管理员。',
    reload: '重新加载',
  },
} as const
