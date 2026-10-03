// 每条用例之后核对：应用的一个连接上没有并发过查询（support/single-query.ts）。有就让这条用例失败，并说明是哪几条语句。
import { afterEach } from 'vitest'
import { takeConcurrentQueries, watchConcurrentQueries } from '../support/single-query.ts'

watchConcurrentQueries()

afterEach(() => {
  const found = takeConcurrentQueries()
  if (found.length > 0)
    throw new Error(`应用的一个连接上并发了查询（同一个事务或只读快照上的 Promise.all 一类，pg 9 不再排队执行，逐条 await）：${found.join(' | ')}`)
})
