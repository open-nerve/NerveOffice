import type { TestApp } from '../support/api-app.ts'
import { healthLiveResponseSchema, healthReadyResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'

let app: TestApp

beforeAll(async () => {
  app = await startTestApp()
})

afterAll(async () => {
  await app.close()
})

describe('健康检查（进程内的真实应用）', () => {
  it('存活探针返回 200', async () => {
    const response = await fetch(`${app.baseUrl}/api/health/live`)
    expect(response.status).toBe(200)
    expect(healthLiveResponseSchema.parse(await response.json())).toEqual({ status: 'ok' })
  })

  it('就绪探针在接收请求时返回 200', async () => {
    const response = await fetch(`${app.baseUrl}/api/health/ready`)
    expect(response.status).toBe(200)
    expect(healthReadyResponseSchema.parse(await response.json())).toEqual({ status: 'ready' })
  })
})
