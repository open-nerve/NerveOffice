// "与我共享"页的文案（M2-P5）：只由按需加载的"与我共享"页（features/shared-with-me）引用，不进平台页面的首屏（lint 的模块边界限定）。
// 左侧导航里的入口文字在 messages.ts（spaces.sharedWithMe）；行内操作（复制、改名）的文案与空间页共用，也在 messages.ts（organize）
import { messages } from './messages.ts'

export const sharedWithMeMessages = {
  // 这一页包括我在那个空间里也有角色的文档：分享只给文档本身，那个角色照样有效（M2-P5 审查 B 的 S4）
  description: '别人单独分享给你的文档。分享只给这些文档本身，不给它们所在空间里的其他内容；你在那个空间里另有角色的，照样按那个角色访问。',
  listLabel: '分享给我的文档',
  loading: '正在加载分享给你的文档…',
  loadFailed: '分享给你的文档没能加载',
  /** 留着之前的列表、刷新却失败了（Codex 对抗评审 CX5）："分享给你的文档没能刷新，显示的还是之前的内容" */
  listName: '分享给你的文档',
  empty: '还没有人单独分享文档给你。',
  /** 我对这份文档的内容权限（空间角色与授权取较高者，归档的空间里只能查看） */
  canEdit: '可以编辑',
  readOnly: '只能查看',
  // 行内操作得到 404（Codex 对抗评审 CX3）：除了删除、移走，在这一页还可能是分享被取消了。列表刷新好了没有按刷新的结果说
  gone: (name: string, refreshed: boolean) => `「${name}」已经不在这里了（可能已经删除，或者分享已被取消），${messages.common.listRefreshed(refreshed)}。`,
  targetOrItemGone: (name: string, refreshed: boolean) => `「${name}」或者目标位置已经不在了（可能被删除、移走，或者分享已被取消），${messages.common.listRefreshed(refreshed)}。`,
} as const
