// 应用的一个连接上同时只有一条查询（M2 Codex 评审的后端修复时发现）：pg 在一个连接上排队执行查询的做法已经弃用（pg 9 去掉），
// 同一个事务（或者只读快照）上用 Promise.all 并发两条语句就是这样——永久删除时数删除单元里的行原来这样写，只读快照里的审计查询也一样。
// 做法：在测试进程里包装 pg.Client.prototype.query（应用与测试在同一个进程里运行，用的是同一个 pg 模块），
// 只看应用自己的连接（application_name 是应用的连接池的名字，与 statement-capture.ts 相同）：这个连接上还有查询在执行或排队时
// 又发出查询，记下这条语句。集成测试的设置文件（setup/single-query.ts）在每条用例之后取出记录，有就让用例失败。
// 判断用的是 pg 8 的内部字段（_activeQuery、_queryQueue）：pg 改了它们时，自测（single-query.test.ts）会失败，不会悄悄失效。
// 应用的连接按 apps/api 的 APPLICATION_NAME 认（连接池的 application_name），引用它而不写死：改名时核对跟着走（M2 Codex 评审复验的建议 2）。
import { APPLICATION_NAME } from '@nerve-office/api/testing'
import pg from 'pg'

interface ClientInternals {
  readonly connectionParameters?: { readonly application_name?: string }
  readonly _activeQuery?: unknown
  readonly _queryQueue?: readonly unknown[]
}

/** 语句文本：query(text, …) 与 query({ text, … }) 两种写法 */
function textOf(first: unknown): string {
  if (typeof first === 'string')
    return first
  if (typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string')
    return first.text
  return '<无法识别的语句>'
}

const concurrent: string[] = []
let installed = false

/** 开始记下（设置文件调用一次；重复调用不重复包装） */
export function watchConcurrentQueries(): void {
  if (installed)
    return
  installed = true
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }
  const original = prototype.query
  prototype.query = function query(this: ClientInternals, ...args: unknown[]): unknown {
    const busy = this._activeQuery !== null && this._activeQuery !== undefined
    if (this.connectionParameters?.application_name === APPLICATION_NAME && (busy || (this._queryQueue?.length ?? 0) > 0))
      concurrent.push(textOf(args[0]).replace(/\s+/g, ' ').trim())
    return original.apply(this, args)
  }
}

/** 取出并清空记下的语句：应用的一个连接上，前一条还没结束就发出的那些 */
export function takeConcurrentQueries(): string[] {
  return concurrent.splice(0)
}
