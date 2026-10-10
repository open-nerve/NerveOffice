// 崩溃工具的 IndexedDB 日志（M4-P1 设计 §3.8，S9 第 5 项要用；support/leveldb-log.ts）：每次结束之后记下日志结尾的状态；往结尾补一个只有头的
// 记录，确定地造出 Chromium 删库——S7 的调查查明的缺陷：被结束在追加一条记录的两次 write 之间时结尾只剩记录头，下一次打开时这半条被悄悄丢掉、
// 数据都在，但新数据接在它后面写（reuse_logs）；再下一次打开时校验和不符，Chromium 删掉这个来源的全部 IndexedDB。
// 用页面里裸的 IndexedDB（两个库：同一个来源的全部库都会被删），不经应用的代码；登录页是同源的页面，平台不在那里用 IndexedDB。只看被测来源
// （baseURL）的那一条日志：浏览器可能给内建的来源另建 IndexedDB。
// UR-034 的前提（docs/upstream/UR-034-chromium-indexeddb-torn-log-wipe.md）：Chromium 的 IndexedDB 是 LevelDB、复用日志，补的半条记录之后新写的
// 接在它后面，再下一次打开时删掉整个来源的库。CI 装的是当时最新的稳定版 Chrome 与 Edge，前提哪天不在了，这里的用例会失败，说明以
// "UR-034 的前提不在了"开头。到时的处理：
// - 资料目录里没有这个来源的 LevelDB IndexedDB（浏览器换了后端，例如 Chromium 的 SQLite 后端）：先用 S7 调查的自然出现的循环在新后端上重查
//   崩溃之后会不会丢库、丢成什么样；不丢就把造删库的这几步改成经删库的接口造出"库没了"（同 specs/outbox/mirror.spec.ts），丢就照新的机理另造；
//   UR-034 与设计 §3.8 一并订正。
// - 补了半条记录之后没有删库（缺陷修好了）：用 UR-034 的最小复现确认是哪个版本修的，同样改用删库的接口造出"库没了"；OPFS 的冗余留不留由
//   需求方定（修好之前的 Chromium 与别的浏览器仍可能需要）。
import type { Page } from '@playwright/test'
import type { CrashReport, CrashTool, PersistentLaunch } from '../../support/browser-crash.ts'
import { expect, expectCrashed, indexedDbLogOf, test, UR034_PREMISE_GONE } from '../../support/browser-crash.ts'

/** 往库里写几条（strict，等提交） */
async function put(page: Page, database: string, entries: Record<string, string>): Promise<void> {
  await page.evaluate(async ({ database, entries }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(database, 1)
      opening.onupgradeneeded = () => opening.result.createObjectStore('s')
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error ?? new Error('打不开库'))
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('s', 'readwrite', { durability: 'strict' })
      for (const [key, value] of Object.entries(entries))
        tx.objectStore('s').put(value, key)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('事务中止'))
    })
    db.close()
  }, { database, entries })
}

/**
 * 这个来源现有的库与各自的键（库名 → 键，按字面排序）。Chromium 发现日志损坏的那一次打开报 UnknownError（随即删库重建），
 * 再问一次就是删过之后的样子：出错时记下、最多问三次
 */
async function contents(page: Page): Promise<{ readonly errors: readonly string[], readonly databases: Record<string, string[]> }> {
  const errors: string[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const databases = await page.evaluate(async () => {
        const result: Record<string, string[]> = {}
        for (const { name } of await indexedDB.databases()) {
          if (name === undefined)
            continue
          result[name] = await new Promise<string[]>((resolve, reject) => {
            const opening = indexedDB.open(name)
            opening.onerror = () => reject(opening.error ?? new Error('打不开库'))
            opening.onsuccess = () => {
              const db = opening.result
              const keys = db.transaction('s').objectStore('s').getAllKeys()
              keys.onsuccess = () => {
                db.close()
                resolve((keys.result as string[]).sort())
              }
              keys.onerror = () => reject(keys.error ?? new Error('读不出'))
            }
          })
        }
        return result
      })
      return { errors, databases }
    }
    catch (error) {
      errors.push(String(error).split('\n')[0] ?? '')
    }
  }
  throw new Error(`三次都读不出：${errors.join('；')}`)
}

/** 以同一个目录重开、打开同源的登录页 */
async function relaunched(crashTool: CrashTool, launch: PersistentLaunch, report: CrashReport): Promise<PersistentLaunch> {
  const next = await crashTool.relaunch(launch, report, { cookies: 'restore' })
  await next.page.goto('/login')
  return next
}

/** 起一次、写一条、空闲时结束 */
async function crashAfterWrite(crashTool: CrashTool): Promise<{ readonly launch: PersistentLaunch, readonly report: CrashReport }> {
  const launch = await crashTool.launch()
  await launch.page.goto('/login')
  await put(launch.page, 'nerve-crash-log-a', { k1: 'one' })
  const report = await crashTool.crash(launch)
  expectCrashed(report)
  return { launch, report }
}

test.describe('崩溃工具：IndexedDB 的日志', () => {
  test('Chromium 系：每次结束之后记下被测来源的日志结尾的状态，空闲时结束是完整的', async ({ crashTool, browserName, baseURL }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 的 IndexedDB 是 SQLite，没有 LevelDB 的日志（下一条用例核对它为空）
    test.skip(browserName === 'webkit', 'WebKit 的 IndexedDB 是 SQLite')
    const { report } = await crashAfterWrite(crashTool)
    expect(indexedDbLogOf(report, baseURL).tail.status).toBe('clean')
  })

  test('WebKit：IndexedDB 是 SQLite，结束之后没有日志可记，也不能补', async ({ crashTool, browserName }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- 只核对 WebKit：Chromium 系由上一条用例核对
    test.skip(browserName !== 'webkit', '只核对 WebKit')
    const { launch, report } = await crashAfterWrite(crashTool)
    expect(report.indexedDbLogs).toEqual([])
    expect(() => crashTool.tearIndexedDbLog(launch, report)).toThrow(/Chromium/)
  })

  test('补一个只有头的记录：下一次打开数据都在、照常写；再下一次打开这个来源的全部 IndexedDB 被删（Chromium 系）', async ({ crashTool, browserName, baseURL }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 的 IndexedDB 是 SQLite，没有这个缺陷（S7 的调查：290 次强制结束没有丢失）
    test.skip(browserName === 'webkit', 'WebKit 的 IndexedDB 是 SQLite，没有这个缺陷')
    let launch = await crashTool.launch()
    await launch.page.goto('/login')
    await put(launch.page, 'nerve-crash-log-a', { k1: 'one', k2: 'two' })
    await put(launch.page, 'nerve-crash-log-b', { other: 'kept?' })
    let report = await crashTool.crash(launch)
    expectCrashed(report)
    const torn = crashTool.tearIndexedDbLog(launch, report)
    expect(torn.tail.status).toBe('torn-payload')
    expect(torn.record.declaredLength).toBe(64)

    // 下一次打开：那半条被悄悄丢掉，数据都在；接着写一条（提交了），新数据接在那半条后面
    launch = await relaunched(crashTool, launch, report)
    expect(await contents(launch.page)).toEqual({ errors: [], databases: { 'nerve-crash-log-a': ['k1', 'k2'], 'nerve-crash-log-b': ['other'] } })
    await put(launch.page, 'nerve-crash-log-a', { k3: 'x'.repeat(200) })
    report = await crashTool.crash(launch)
    expectCrashed(report)
    const log = indexedDbLogOf(report, baseURL)
    expect(log.tail.status, `${UR034_PREMISE_GONE}：补的半条记录之后新写的没有接在它后面（LevelDB 不再复用日志？）：${JSON.stringify(log.tail)}`).toBe('corrupt')
    expect(log.tail.detail).toContain('checksum mismatch')

    // 再下一次打开：第一次问报错，之后这个来源一个库都没有（两个库都被删）
    launch = await relaunched(crashTool, launch, report)
    const after = await contents(launch.page)
    expect(after.databases, `${UR034_PREMISE_GONE}：补了半条记录、之后写过一次，再打开时没有删库（缺陷修好了？）`).toEqual({})
    expect(after.errors).toHaveLength(1)
    expect(after.errors[0]).toContain('UnknownError')
  })
})
