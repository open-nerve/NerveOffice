// 只由显式手动命令运行；不改变默认测试、覆盖率或 CI 范围。
import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ssr: { resolve: { conditions: ['@nerve-office/source', ...defaultServerConditions] } },
  test: {
    name: 'history-capacity',
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    include: ['tests/integration/src/measure/history-capacity.measure.ts'],
    setupFiles: ['tests/integration/src/setup/database.ts', 'tests/integration/src/setup/single-query.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
})
