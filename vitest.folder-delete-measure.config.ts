// 只由显式手动命令运行（M5-P7 Q-03）；不改变默认测试、覆盖率或 CI 范围。
import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ssr: { resolve: { conditions: ['@nerve-office/source', ...defaultServerConditions] } },
  test: {
    name: 'folder-delete-capacity',
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    include: ['tests/integration/src/measure/folder-delete.measure.ts'],
    setupFiles: ['tests/integration/src/setup/database.ts', 'tests/integration/src/setup/single-query.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
})
