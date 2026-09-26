import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { ApplicationState } from './application-state.ts'
import { HealthController } from './health.controller.ts'
import { HealthModule } from './health.module.ts'

describe('HealthController', () => {
  // 控制器的构造参数只按类型声明，能取到实例说明装饰器元数据已经输出（ADR-004 的验证项）
  it('经依赖注入取得，与模块共用同一个运行状态', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile()
    const controller = moduleRef.get(HealthController)
    const state = moduleRef.get(ApplicationState)

    expect(controller.live()).toEqual({ status: 'ok' })
    expect(controller.ready()).toEqual({ status: 'ready' })

    state.beginShutdown()
    expect(controller.live()).toEqual({ status: 'ok' })
    expect(() => controller.ready()).toThrow('正在退出')
  })
})
