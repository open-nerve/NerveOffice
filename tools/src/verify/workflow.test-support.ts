// 工作流接线检查的共用部分：ci.yml（ci-workflow.test.ts）与 mac.yml（mac-workflow.test.ts）用同一套解析，
// 判断“哪一步执行检查”“pnpm verify 带了哪些参数”的写法一致，两边不会各自漂移。
import { parse } from 'yaml'
import { z } from 'zod'
import { readText } from '../shared/repo.ts'

/** E2E 的浏览器表（playwright.config.ts 的 BROWSERS）：本机跑前三个，CI 另加 Edge（规范 §8.2） */
export const PLAYWRIGHT_CONFIG = 'tests/e2e/playwright.config.ts'

export const stepSchema = z.object({
  'name': z.string().optional(),
  'run': z.string().optional(),
  'uses': z.string().optional(),
  'if': z.unknown().optional(),
  'env': z.record(z.string(), z.unknown()).optional(),
  'continue-on-error': z.unknown().optional(),
}).loose()
export const jobSchema = z.object({
  'name': z.string().optional(),
  'if': z.unknown().optional(),
  'env': z.record(z.string(), z.unknown()).optional(),
  'strategy': z.object({ 'fail-fast': z.boolean().optional(), 'matrix': z.record(z.string(), z.unknown()).optional() }).loose().optional(),
  'steps': z.array(stepSchema),
  'continue-on-error': z.unknown().optional(),
}).loose()
export const workflowSchema = z.object({
  env: z.record(z.string(), z.unknown()).optional(),
  on: z.object({
    push: z.object({ branches: z.array(z.string()) }).loose().optional(),
    schedule: z.array(z.object({ cron: z.string() })).optional(),
  }).loose(),
  jobs: z.record(z.string(), jobSchema),
})

export type Workflow = z.infer<typeof workflowSchema>
export type Job = z.infer<typeof jobSchema>
export type Step = z.infer<typeof stepSchema>

export function parseWorkflow(text: string): Workflow {
  return workflowSchema.parse(parse(text))
}

/** 一个 job 里执行 pnpm verify 的各步的参数（只认 run 里以 pnpm verify 开头的一行） */
export function verifyArgs(job: Job): string[][] {
  return job.steps.flatMap(step => (step.run ?? '').split('\n').map(line => line.trim().split(/\s+/)).filter(words => words[0] === 'pnpm' && words[1] === 'verify').map(words => words.slice(2)))
}

/** 在内存里改工作流的文字（不改文件）：要换掉的那一段必须恰好出现一次，否则说明工作流改了写法，用例要跟着改 */
export function workflowWith(path: string, original: string, replacement: string): string {
  const text = readText(path)
  const count = text.split(original).length - 1
  if (count !== 1)
    throw new Error(`${path} 里应恰好有一处（实际 ${count} 处）：${original}`)
  return text.replace(original, replacement)
}

/** 这一步执行检查：pnpm verify 或容器 E2E（run 里有一行以它开头） */
export function runsChecks(step: Step): boolean {
  return (step.run ?? '').split('\n').some(line => /^pnpm (?:verify|test:e2e:container)(?:\s|$)/.test(line.trim()))
}

export function stepLabel(id: string, step: Step): string {
  return `${id}：${step.name ?? step.uses ?? step.run ?? ''}`
}

/** playwright.config.ts 里浏览器表的名字：const BROWSERS … = { 名字: …, … } */
export function playwrightBrowsers(source: string): string[] {
  const block = /^const BROWSERS\b[^=]*= \{\n([\s\S]*?)^\}$/m.exec(source)?.[1]
  if (block === undefined)
    throw new Error(`${PLAYWRIGHT_CONFIG} 里找不到 const BROWSERS = { … }：改了写法，同步这里的解析`)
  return [...block.matchAll(/^ {2}(\w+): /gm)].map(match => match[1] ?? '')
}
