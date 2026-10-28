import process from 'node:process'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { commandText } from '../shared/repo.ts'

function coverageDirectory(directory?: string): string {
  const env = { ...process.env }
  delete env.NERVE_TEST_COVERAGE_DIR
  if (directory !== undefined)
    env.NERVE_TEST_COVERAGE_DIR = directory
  // 每次在新进程读取实际配置，避免模块缓存把另一轮的输出目录带进来；不启动 Vitest 测试。
  const output = commandText(process.execPath, [
    '--input-type=module',
    '--eval',
    'import config from "./vitest.config.ts"; process.stdout.write(JSON.stringify(config.test.coverage.reportsDirectory))',
  ], { env })
  return z.string().parse(JSON.parse(output))
}

it('未设置受管覆盖率目录时保留本机 coverage 路径', () => {
  expect(coverageDirectory()).toBe('coverage')
})

it('覆盖率写入运行器给出的本轮目录，进入后续稳定导出而不污染仓库固定路径', () => {
  expect(coverageDirectory('/owned/run-one/output/coverage')).toBe('/owned/run-one/output/coverage')
  expect(coverageDirectory('/owned/run-two/output/coverage')).toBe('/owned/run-two/output/coverage')
})
