// 分享对话框的文案（M2-P5）：只由分享对话框（features/sharing）引用，随它在平台页面按需加载、不进平台页面的首屏（lint 的模块边界限定；
// 编辑器页的页头静态引用对话框，文案随编辑器页一起加载）。入口上的"分享"与组件级加载失败的说明在 messages.ts（两个入口的首屏都用）
import type { Phrase } from './messages.ts'
import { messages } from './messages.ts'

export const sharingMessages = {
  title: (documentTitle: string) => `分享「${documentTitle}」`,
  // 对方可能本来就在这个空间里有角色（例如全员可见的空间）：分享不收回、也不限制那个角色（M2-P5 审查 B 的 S4）
  description: '分享给同事之后，对方在"与我共享"里看得到这份文档。这条分享只给这一份，不给它所在空间里的其他内容；对方在这个空间里另有角色的，照样按那个角色访问。查看者只能查看，编辑者还能修改内容与标题。',
  // 添加：同事选择的标签与提交按钮的文字不同（审查 B10 的做法）
  colleague: '要分享给的同事',
  role: '角色',
  add: '分享',
  adding: '正在分享…',
  pickColleague: '请先选择要分享给的同事',
  added: <T>(name: T, role: string): Phrase<T> => ['已分享给 ', name, `（${role}）`],
  // 授权列表
  listHeading: '已分享给',
  loading: '正在加载分享的情况…',
  loadFailed: '分享的情况没能加载',
  /** 留着之前的列表、刷新却失败了（Codex 对抗评审 CX5）："分享的情况没能刷新，显示的还是之前的内容" */
  listName: '分享的情况',
  empty: '还没有单独分享给任何人。',
  disabled: '已停用',
  you: '（我）',
  /** 最后设置这个角色的人与时间 */
  grantedBy: <T>(name: T, time: string): Phrase<T> => ['由 ', name, ` 设置于 ${time}`],
  // 调整：选好之后点"保存"才提交（与成员页同一个做法：收起的选择框上按方向键会逐个改值）
  roleOf: (name: string) => `${name} 的角色`,
  saveRole: '保存',
  saveRoleOf: (name: string) => `保存 ${name} 的角色`,
  unsaved: '还没保存：点"保存"之后才生效',
  saving: '正在保存…',
  /** 自己的那条授权（别的空间管理员分享给我的）：不能调整自己的（只能取消） */
  ownGrant: '这是分享给你自己的，只能取消',
  /** 被授权人已停用：服务端对停用的人调整角色一律拒绝（409），授权保留、可以取消（M2-P5 审查 B 的 S3） */
  disabledGrant: '对方的账户已停用，只能取消',
  // 取消
  revoke: '取消分享',
  confirmRevoke: (name: string) => `取消分享给 ${name}？`,
  confirmRevokeSelf: '取消分享给你自己的这一条？',
  // 取消的是这一条分享：对方在这个空间里另有角色的（例如全员可见的空间），照样按那个角色访问（M2-P5 审查 B 的 S4）
  revokeDescription: '取消之后，对方立即不能再凭这条分享访问这份文档，已经打开的页面也一样；他在这个空间里另有角色的，照样按那个角色访问。',
  revokeSelfDescription: '取消之后，你只能凭在这个空间里的角色访问这份文档。',
  revoked: <T>(name: T): Phrase<T> => ['已取消分享给 ', name],
  // 被拒绝：文档已经不在了、或者已经不能分享了（404）；403 用服务端说的原因（例如"空间已归档，恢复之后才能调整分享"）
  gone: '这份文档已经不在了，或者你已经不能访问它。',
  roleName: (role: 'viewer' | 'editor') => messages.spaces.roleName(role),
} as const
