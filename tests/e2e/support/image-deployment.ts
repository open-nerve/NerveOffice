// 只用于部署验收：读取固定测试材料和实际容器指标，不进入应用产物。
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { ASSET_MIME_TYPES, assetExtensionSchema } from '@nerve-office/contracts'
import { z } from 'zod'
import { compose } from './compose.ts'
import { expect } from './fixtures.ts'

const fixtureSchema = z.object({
  id: z.string(),
  file: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  declaredType: z.enum(ASSET_MIME_TYPES),
  extension: assetExtensionSchema,
  generated: z.object({ source: z.string(), bytes: z.number() }).optional(),
  expected: z.object({ status: z.enum(['accept', 'reject']), reason: z.string().optional(), rule: z.string().optional(), width: z.number().optional(), height: z.number().optional(), frames: z.number().optional() }),
})
const directory = new URL('../../../apps/api/src/modules/assets/testdata/', import.meta.url)
export const deploymentImageFixtures = z.object({ cases: z.array(fixtureSchema) }).parse(JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))).cases

export function deploymentImageBytes(fixture: z.infer<typeof fixtureSchema>): Buffer {
  const bytes = fixture.generated === undefined ? readFileSync(new URL(fixture.file, directory)) : Buffer.alloc(fixture.generated.bytes)
  if (fixture.generated !== undefined)
    readFileSync(new URL(fixture.generated.source, directory)).copy(bytes)
  if (bytes.length !== fixture.bytes || createHash('sha256').update(bytes).digest('hex') !== fixture.sha256)
    throw new Error(`部署样本大小或摘要不符：${fixture.id}`)
  return bytes
}

const metricsSchema = z.object({ platform: z.literal('linux'), arch: z.enum(['arm64', 'x64']), memoryMax: z.number().int().positive(), memoryPeak: z.number().int().positive(), memoryCurrent: z.number().int().positive(), oom: z.number().int().nonnegative(), oomKill: z.number().int().nonnegative() })
export type ImageContainerMetrics = z.infer<typeof metricsSchema>

/** cgroup 的整容器峰值（含 API/快照/图片进程），不冒充单图片 RSS 或本轮新增峰值。 */
export function imageContainerMetrics(): ImageContainerMetrics | undefined {
  if (process.env.E2E_BASE_URL === undefined)
    return undefined
  const script = 'const fs=require("node:fs"); const n=p=>Number(fs.readFileSync("/sys/fs/cgroup/"+p,"utf8").trim()); const e=Object.fromEntries(fs.readFileSync("/sys/fs/cgroup/memory.events","utf8").trim().split("\\n").map(s=>s.split(" "))); console.log(JSON.stringify({platform:process.platform,arch:process.arch,memoryMax:n("memory.max"),memoryPeak:n("memory.peak"),memoryCurrent:n("memory.current"),oom:Number(e.oom),oomKill:Number(e.oom_kill)}))'
  return metricsSchema.parse(JSON.parse(compose(['exec', '-T', 'app', 'node', '-e', script])))
}

export function expectHealthyImageContainer(metrics: ImageContainerMetrics | undefined): void {
  // 本机 E2E 没有容器；公开协议故事照常执行，不拿宿主指标冒充 cgroup。
  if (metrics === undefined)
    return
  expect(metrics.memoryMax).toBe(4 * 1024 ** 3)
  expect(metrics.oom).toBe(0)
  expect(metrics.oomKill).toBe(0)
  expect(metrics.memoryPeak).toBeLessThan(metrics.memoryMax)
}
