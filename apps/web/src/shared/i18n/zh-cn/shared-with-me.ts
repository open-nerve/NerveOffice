// "与我共享"页的文案（M2-P5）：只由按需加载的"与我共享"页（features/shared-with-me）引用，不进平台页面的首屏（lint 的模块边界限定）。
// 左侧导航里的入口文字在 messages.ts（spaces.sharedWithMe）
export const sharedWithMeMessages = {
  description: '别人单独分享给你的文档。你只看得到这些文档本身，看不到它们所在空间里的其他内容。',
  listLabel: '分享给我的文档',
  loading: '正在加载分享给你的文档…',
  loadFailed: '分享给你的文档没能加载',
  empty: '还没有人单独分享文档给你。',
  /** 我对这份文档的内容权限（空间角色与授权取较高者，归档的空间里只能查看） */
  canEdit: '可以编辑',
  readOnly: '只能查看',
} as const
