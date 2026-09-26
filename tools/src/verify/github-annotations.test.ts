import type { StepResult } from './plan.ts'
import { describe, expect, it } from 'vitest'
import { githubAnnotations } from './github-annotations.ts'

function result(id: string, status: StepResult['status'], command: string[] = ['pnpm', id]): StepResult {
  return { step: { id, command }, status, durationMs: 1500 }
}

describe('githubAnnotations', () => {
  it('全部通过时只有一条汇总注解，每一步一行', () => {
    expect(githubAnnotations([result('lint', 'passed'), result('e2e', 'passed')])).toEqual([
      '::notice title=pnpm verify::全部通过%0A✔ lint（pnpm lint）1.5 秒%0A✔ e2e（pnpm e2e）1.5 秒',
    ])
  })

  it('每个失败的步骤一条 error 注解，汇总里也列出失败与未执行的步骤', () => {
    const annotations = githubAnnotations([result('lint', 'passed'), result('unit', 'failed', ['pnpm', 'test:coverage']), result('e2e', 'skipped')])
    expect(annotations).toEqual([
      '::error title=pnpm verify::unit 失败：pnpm test:coverage',
      '::notice title=pnpm verify::有步骤失败%0A✔ lint（pnpm lint）1.5 秒%0A✖ unit（pnpm test:coverage）1.5 秒%0A- e2e（pnpm e2e）未执行',
    ])
  })

  it('消息里的 %、回车与换行按工作流命令的规则转义，不会截断注解或被当成新的命令', () => {
    const [annotation] = githubAnnotations([result('gate', 'failed', ['node', 'gate.ts', '100%', 'a\r\n::error::伪造'])])
    expect(annotation).toBe('::error title=pnpm verify::gate 失败：node gate.ts 100%25 a%0D%0A::error::伪造')
  })
})
