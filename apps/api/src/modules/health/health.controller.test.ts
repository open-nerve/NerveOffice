import type { DatabaseReadiness, DatabaseReadinessResult } from '../database/index.ts'
import { describe, expect, it } from 'vitest'
import { ApplicationState } from './application-state.ts'
import { HealthController } from './health.controller.ts'

function controllerWith(result: DatabaseReadinessResult): { controller: HealthController, state: ApplicationState } {
  const state = new ApplicationState()
  const database = { check: async () => result } as unknown as DatabaseReadiness
  return { controller: new HealthController(state, database), state }
}

describe('HealthController', () => {
  it('存活探针在退出过程中也返回', () => {
    const { controller, state } = controllerWith({ ready: true })
    expect(controller.live()).toEqual({ status: 'ok' })
    state.beginShutdown()
    expect(controller.live()).toEqual({ status: 'ok' })
  })

  it('就绪：接收请求中且数据库就绪', async () => {
    await expect(controllerWith({ ready: true }).controller.ready()).resolves.toEqual({ status: 'ready' })
  })

  it('数据库未就绪时 503，说明里写明原因', async () => {
    await expect(controllerWith({ ready: false, reason: '数据库不可达' }).controller.ready()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '数据库不可达' })
  })

  it('开始退出后 503，不再检查数据库', async () => {
    const { controller, state } = controllerWith({ ready: true })
    state.beginShutdown()
    await expect(controller.ready()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '正在退出' })
  })
})
