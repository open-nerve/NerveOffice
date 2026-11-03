import { expect, it } from 'vitest'
import { startTargetServer } from './servers.ts'

it('CSP 目标端保留全部实际到达的请求，图标与未知路径不能从计数或诊断中被过滤', async () => {
  const target = await startTargetServer()
  try {
    for (const path of ['/probe', '/probe', '/new-page', '/favicon.ico', '/unexpected?source=test']) {
      const response = await fetch(`${target.origin}${path}`)
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(target.hits()).toBe(5)
    expect(target).toHaveProperty('requests', expect.any(Function))
    expect(target.requests()).toEqual(['/probe', '/probe', '/new-page', '/favicon.ico', '/unexpected?source=test'])
  }
  finally {
    await target.close()
  }
})

it('CSP 到达诊断有界，超出样本上限的真实请求仍计入总数', async () => {
  const target = await startTargetServer()
  try {
    for (let index = 0; index < 34; index += 1) {
      const response = await fetch(`${target.origin}/probe?index=${index}`)
      await response.text()
    }
    expect(target.hits()).toBe(34)
    expect(target).toHaveProperty('requests', expect.any(Function))
    expect(target.requests()).toHaveLength(32)
    expect(target.requests()[0]).toBe('/probe?index=0')
    expect(target.requests()[31]).toBe('/probe?index=31')
  }
  finally {
    await target.close()
  }
})
