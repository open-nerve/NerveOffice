// 这份文档这次以什么方式打开（M2-P3 设计 §3.1）：由编辑器页按服务端给出的权限（DocumentDetail.permissions.canEdit）决定，
// 创建编辑器时给定，之后不变（M3 的原地切换另加运行时的接口）。
// 适配层不知道"查看者""归档"这些业务概念，只知道能不能编辑：授权服务、只读守卫与界面配置都按它组合
export type EditorAccess = 'edit' | 'read'
