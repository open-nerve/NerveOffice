// 读取内容的条件请求（M3-P2 设计 §3.2，DEF-017）：阅读页每 30 秒看一次编辑状态，有新版本、点了"刷新"才取内容，
// 取的时候带上 If-None-Match（手里那一份的 ETag，也就是修订号）；修订号没变就回 304，不传内容。
// 规范不允许 @Headers()（不经校验）：这个参数装饰器自己解析（写法同 @EditLeaseToken()），全局的校验管道不校验自己写的参数装饰器。
import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { revisionFromEtag } from '@nerve-office/contracts'
import { createParamDecorator } from '@nestjs/common'

/**
 * If-None-Match 的条件（RFC 9110 §13.1.2）：'*' 表示任何现有的版本都算匹配；否则是列出的实体标签里认得出的修订号
 * （contracts 的 revisionFromEtag：强校验器 "n" 与弱校验器 W/"n" 都认，反向代理改了编码会把它标成弱的，修订号不变；
 * If-None-Match 本来就按弱比较）。认不出的标签（不是本平台给的、格式不对）不算匹配，照样给内容——缓存的校验器认不出就是"不新鲜"，
 * 不是请求不合法，所以不回 400（与令牌的请求头不同：令牌格式不对说明客户端写错了）
 */
export type RevisionNoneMatch = '*' | readonly number[]

/** 一个实体标签：可选的弱标记 W/ 加一段带引号、不含引号的文字（RFC 9110 §8.8.3）。逗号可以出现在引号里，所以不按逗号拆 */
const ENTITY_TAG = /(?:W\/)?"[^"]*"/g

/**
 * 请求带来的条件：没带这个请求头时为 undefined（不是条件请求）。重复的请求头由 Node 用逗号合成一串，照样按列表解析
 */
export function noneMatchOf(request: Request): RevisionNoneMatch | undefined {
  const value = request.headers['if-none-match']
  if (value === undefined)
    return undefined
  if (value.trim() === '*')
    return '*'
  return [...value.matchAll(ENTITY_TAG)].flatMap(([tag]) => revisionFromEtag(tag) ?? [])
}

/** 当前修订是不是条件里的那一个（是就回 304） */
export function matchesNoneMatch(condition: RevisionNoneMatch, revision: number): boolean {
  return condition === '*' || condition.includes(revision)
}

/** 控制器的参数装饰器：`read(@IfNoneMatch() noneMatch: RevisionNoneMatch | undefined)` */
export const IfNoneMatch = createParamDecorator((_data: unknown, context: ExecutionContext): RevisionNoneMatch | undefined =>
  noneMatchOf(context.switchToHttp().getRequest<Request>()))
