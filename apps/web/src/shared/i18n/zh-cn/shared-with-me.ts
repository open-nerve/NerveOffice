// "与我共享"页的文案（M2-P5）：只由按需加载的"与我共享"页（features/shared-with-me）引用，不进平台页面的首屏（lint 的模块边界限定）。
// 左侧导航里的入口文字在 messages.ts（spaces.sharedWithMe）
export const sharedWithMeMessages = {
  // 这一页包括我在那个空间里也有角色的文档：分享只给文档本身，那个角色照样有效（M2-P5 审查 B 的 S4）
  description: '别人单独分享给你的文档。分享只给这些文档本身，不给它们所在空间里的其他内容；你在那个空间里另有角色的，照样按那个角色访问。',
  listLabel: '分享给我的文档',
  loading: '正在加载分享给你的文档…',
  loadFailed: '分享给你的文档没能加载',
  empty: '还没有人单独分享文档给你。',
  /** 我对这份文档的内容权限（空间角色与授权取较高者，归档的空间里只能查看） */
  canEdit: '可以编辑',
  readOnly: '只能查看',
} as const
