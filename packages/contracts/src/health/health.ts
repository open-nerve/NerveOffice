import { z } from 'zod'

/** 存活探针：进程在运行就返回（P2 设计 §3.9）。 */
export const healthLiveResponseSchema = z.strictObject({ status: z.literal('ok') })

/** 就绪探针：可以接收请求时返回；不满足时返回 503 与统一的错误响应。 */
export const healthReadyResponseSchema = z.strictObject({ status: z.literal('ready') })

export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>
