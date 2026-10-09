// 收下页面自检交回的结果的本机 HTTP 服务（selftest-collector.ts，M4-P1 复核 B5）：按标记对上每一次交回，重复、认不出的答 404，到点没交回就失败
import type { ResultCollector } from './selftest-collector.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { COLLECTOR_REPORT_PATH, COLLECTOR_TOKEN_PARAM, startResultCollector } from './selftest-collector.ts'

let collector: ResultCollector | undefined

afterEach(async () => {
  await collector?.close()
  collector = undefined
})

describe('自检结果的收集端', () => {
  it('next 是本机的源上的地址、带着这一次的标记；页面把结果加在查询参数上跳过来，delivered 交回整个地址，页面看到"已收到"', async () => {
    collector = await startResultCollector()
    const { next, delivered } = collector.expect(5_000)
    const url = new URL(next)
    expect([url.protocol, url.hostname, url.pathname, url.searchParams.get(COLLECTOR_TOKEN_PARAM)]).toEqual(['http:', '127.0.0.1', COLLECTOR_REPORT_PATH, '1'])
    url.searchParams.set('result', 'abc')
    const response = await fetch(url)
    expect([response.status, await response.text()]).toEqual([200, '自检的结果已收到'])
    expect(new URL(await delivered).searchParams.get('result')).toBe('abc')
  })

  it('每次等交回用新的标记：先后两次各收各的；同一个标记再交回一次、认不出的标记与路径答 404', async () => {
    collector = await startResultCollector()
    const first = collector.expect(5_000)
    const second = collector.expect(5_000)
    expect(first.next).not.toBe(second.next)
    expect((await fetch(`${second.next}&result=2`)).status).toBe(200)
    expect((await fetch(`${first.next}&result=1`)).status).toBe(200)
    expect([new URL(await first.delivered).searchParams.get('result'), new URL(await second.delivered).searchParams.get('result')]).toEqual(['1', '2'])
    expect((await fetch(`${first.next}&result=again`)).status, '同一个标记再交回一次').toBe(404)
    expect((await fetch(`${collector.origin}${COLLECTOR_REPORT_PATH}?${COLLECTOR_TOKEN_PARAM}=99`)).status, '没发过的标记').toBe(404)
    expect((await fetch(`${collector.origin}/favicon.ico`)).status, '别的路径').toBe(404)
  })

  it('到点没有交回：delivered 失败，之后迟到的交回答 404', async () => {
    collector = await startResultCollector()
    const late = collector.expect(50)
    await expect(late.delivered).rejects.toThrow('秒内自检没有把结果交回')
    expect((await fetch(`${late.next}&result=late`)).status).toBe(404)
  })

  it('长的结果（几百 KiB 的查询参数）也收得下', async () => {
    collector = await startResultCollector()
    const { next, delivered } = collector.expect(5_000)
    const long = 'x'.repeat(300 * 1024)
    expect((await fetch(`${next}&result=${long}`)).status).toBe(200)
    expect(new URL(await delivered).searchParams.get('result')).toHaveLength(long.length)
  })
})
