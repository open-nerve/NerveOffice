// Vitest：单元测试（unit、unit-web）与集成测试（integration）分成不同的项目（规范 §8）。
import { defineConfig } from 'vitest/config'

const SOURCE_CONDITION = '@nerve-office/source'

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { conditions: [SOURCE_CONDITION] },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'tools/src/**/*.test.ts'],
        },
      },
      {
        extends: './apps/web/vite.config.ts',
        resolve: { conditions: [SOURCE_CONDITION] },
        test: {
          name: 'unit-web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/web/src/**', 'tools/src/**'],
      exclude: [
        '**/*.test.{ts,tsx}',
        // 入口文件只负责挂载，由 E2E 覆盖
        'apps/web/src/entries/**',
        // 编辑器适配层以 E2E 为主（规范 §8.3）
        'apps/web/src/editor/**',
        // 命令行入口只做参数解析与输出，规则本身在各自的模块里测试
        'tools/src/**/cli.ts',
        'tools/src/git/commit-msg.ts',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        'packages/contracts/src/**': { lines: 90 },
        'apps/web/src/**': { lines: 70 },
        'tools/src/**': { lines: 80 },
      },
    },
  },
})
