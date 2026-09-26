// CI 上把 pnpm verify 每一步的结果写成 GitHub Actions 的注解（工作流命令）。
// 注解挂在检查运行上，公开仓库不登录也能通过 API 读取；完整日志要登录才能下载。
import type { StepResult } from './plan.ts'
import { summarize } from './plan.ts'

const TITLE = 'pnpm verify'

type Level = 'error' | 'notice'

/** 每个失败的步骤一条 error 注解，最后一条 notice 注解汇总全部步骤。 */
export function githubAnnotations(results: readonly StepResult[]): string[] {
  const failed = results
    .filter(result => result.status === 'failed')
    .map(({ step }) => workflowCommand('error', `${step.id} 失败：${step.command.join(' ')}`))
  const { ok, lines } = summarize(results)
  const summary = workflowCommand('notice', [ok ? '全部通过' : '有步骤失败', ...lines].join('\n'))
  return [...failed, summary]
}

function workflowCommand(level: Level, message: string): string {
  return `::${level} title=${escapeProperty(TITLE)}::${escapeData(message)}`
}

// 转义规则与 @actions/core 一致：消息里的 %、回车、换行要编码；属性值另外编码冒号与逗号
function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}
