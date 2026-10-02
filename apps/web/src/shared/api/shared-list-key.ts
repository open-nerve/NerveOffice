// "与我共享"（GET /api/shared，M2-P5）在请求缓存里的键：页面（features/shared-with-me）按它取；分享对话框（features/sharing）的
// 写操作之后按它刷新（取消的可能是我自己的那条授权；结果未知与被拒绝之后与授权列表、文档详情一起刷新）。
// 两个功能都按需加载、互相引用不到，键放在这里；不经 shared/api/index.ts 转出（那里随两个入口的首屏一起加载）。

export const SHARED_LIST_QUERY_KEY = ['shared'] as const
