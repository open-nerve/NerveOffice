// 成员页的文案（M2-P2）：只由按需加载的成员页（features/members）引用，不进平台页面的首屏（lint 的模块边界限定）
import type { SpaceRole } from '@nerve-office/contracts'
import type { Phrase } from './messages.ts'
import { messages } from './messages.ts'

export const membersMessages = {
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
  // 选了、还没保存（M2-P6 复核第二批 S-3）：说明关联到选择框上，读屏用户听得到这个角色还没有生效
  unsaved: '还没保存：点"保存"之后才生效',
  saveRoleOf: (name: string) => `保存 ${name} 的角色`,
  remove: '移出',
  confirmRemove: (name: string) => `把 ${name} 移出这个空间？`,
  removeDescription: '移出之后，这个人立即失去这个空间带来的权限；单独分享给他的文档不受影响。',
  confirmRemoveSelf: '把你自己移出这个空间？',
  removeSelfDescription: '移出之后，你立即失去这个空间带来的权限；只能由空间管理员或系统管理员重新添加。',
  /** 要移出的人已经不是成员了（404）：成员列表已刷新，确认的弹窗随之关闭，在成员表上方说明（M2-P2 复验） */
  alreadyRemoved: <T>(name: T): Phrase<T> => [name, ' 已经不在成员里了（可能已被别人移出），列表已刷新'],
  alreadyRemovedSelf: '你已经不在成员里了（可能已被别人移出），列表已刷新',
  confirmDemoteSelf: (role: SpaceRole) => `把你自己的角色改为${messages.spaces.roleName(role)}？`,
  demoteSelfDescription: '改完之后你立即失去空间管理员的权限，只能由另一位空间管理员或系统管理员改回来。',
  change: '修改',
  /** 调整一行的角色进行中（审查 B3） */
  saving: '正在保存…',
  disabled: '已停用',
  empty: '这个空间还没有成员',
  you: '（我）',
  // 添加的结果未知（M2-P6 复核 S1）：可能已经加好；再添加会得到"已经是成员"。两种情形成员列表都随即刷新，没能刷新时另说（第四批）
  addOutcomeUnknown: (reason: string, refreshed: boolean) => `没能确认是否已经添加（${reason}）。${messages.common.listRefreshed(refreshed, '成员列表')}：这个人在列表里，就是已经加好了。`,
  addedEarlier: (refreshed: boolean) => `这个人已经是空间的成员了（可能就是刚才没能确认的那一次添加），${messages.common.listRefreshed(refreshed, '成员列表')}。`,
} as const
