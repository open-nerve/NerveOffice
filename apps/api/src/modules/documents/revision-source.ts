import type { RevisionRow, RevisionSource } from './document-revisions.repository.ts'

/**
 * 一次修订的来源给谁看（M3-P1 复验 C4，纵深防御）：只给保存它的那个人本人，别人看到的是 null。修订号冲突的详情与申请编辑权的响应
 * 都按这一条给出。来源是保存时页面自报的标签页与本地序号，页面拿它认出"这一版是不是本页自己一次结果未知的保存"（P4 设计 §3.5.2 的
 * 自己追自己、00 号计划书 §7.5 的续上）；服务端不核对标签页标识属于哪个登录，把别人的来源给出去，一个能编辑这份文档的人就能有意照着
 * 别人的标签页标识保存，让对方的页面误以为自己的保存成功了。本人在别的标签页保存的照样给出：页面再按标签页比较。
 * 新建、复制出来的修订本来就没有来源
 */
export function revisionSourceFor(revision: RevisionRow | undefined, userId: string): RevisionSource | null {
  return revision !== undefined && revision.savedBy === userId ? revision.source : null
}
