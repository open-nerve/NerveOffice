// 请求里有没有事务已经提交（M2-P6 第 3 片复验）：每个请求一份记录，请求之间、应用之间互不影响；不在请求里时什么也不记。
import type { Request, Response } from 'express'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { CommitLedger } from './commit-ledger.ts'

/** 在一个请求的记录里执行 work：与 HTTP 管线里同一个中间件 */
async function inRequest<T>(commits: CommitLedger, work: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined
  commits.middleware()({} as Request, {} as Response, () => {
    pending = work()
  })
  if (pending === undefined)
    throw new Error('中间件没有往下走')
  return pending
}

describe('CommitLedger', () => {
  it('请求开始时没有提交过；记一笔之后，这个请求后面的步骤（跨过 await）都看得到', async () => {
    const commits = new CommitLedger()
    const seen = await inRequest(commits, async () => {
      const before = commits.hasCommitted()
      commits.recordCommit()
      await delay(1)
      return { before, after: commits.hasCommitted() }
    })
    expect(seen).toEqual({ before: false, after: true })
  })

  it('每个请求一份：并发的两个请求互不影响，记过的请求结束之后下一个请求重新开始', async () => {
    const commits = new CommitLedger()
    const [committed, untouched] = await Promise.all([
      inRequest(commits, async () => {
        commits.recordCommit()
        await delay(5)
        return commits.hasCommitted()
      }),
      inRequest(commits, async () => {
        await delay(10)
        return commits.hasCommitted()
      }),
    ])
    expect([committed, untouched]).toEqual([true, false])
    expect(await inRequest(commits, async () => commits.hasCommitted())).toBe(false)
  })

  it('每个应用一份：同一个进程里另一个应用的请求记账，不影响这一个（不是全局单例）', async () => {
    const first = new CommitLedger()
    const second = new CommitLedger()
    const seen = await inRequest(first, async () => inRequest(second, async () => {
      second.recordCommit()
      return { first: first.hasCommitted(), second: second.hasCommitted() }
    }))
    expect(seen).toEqual({ first: false, second: true })
  })

  it('不在请求里（命令行、定时任务）：记账与查询都是空操作', () => {
    const commits = new CommitLedger()
    commits.recordCommit()
    expect(commits.hasCommitted()).toBe(false)
  })
})
