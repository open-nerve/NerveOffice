// Vitest：单元测试（unit、unit-web）与集成测试（integration）分成不同的项目（规范 §8）。
import { defaultClientConditions, defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

const SOURCE_CONDITION = '@nerve-office/source'

export default defineConfig({
  test: {
    projects: [
      {
        // node 环境的解析条件要写在 ssr 下：Vite 8 里顶层的 resolve.conditions 只作用于浏览器环境
        ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
        test: {
          name: 'unit',
          environment: 'node',
          // api 的装饰器元数据由 Oxc 按 apps/api/tsconfig.json 输出（ADR-004）
          include: ['packages/*/src/**/*.test.ts', 'tools/src/**/*.test.ts', 'apps/*/build/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
        },
      },
      {
        extends: './apps/web/vite.config.ts',
        resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
        test: {
          name: 'unit-web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        // node 环境的解析条件要写在 ssr 下：Vite 8 里顶层的 resolve.conditions 只作用于浏览器环境
        ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/src/**/*.test.ts'],
          setupFiles: ['tests/integration/src/setup/database.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/api/src/**', 'apps/web/src/**', 'apps/web/build/**', 'tools/src/**'],
      exclude: [
        '**/*.test.{ts,tsx}',
        // 入口文件只负责挂载，由 E2E 覆盖
        'apps/web/src/entries/**',
        // api 的进程入口与命令行入口只做组装，由进程测试覆盖（子进程不统计覆盖率）
        'apps/api/src/app/main.ts',
        'apps/api/src/cli/**',
        // 编辑器适配层以 E2E 为主（规范 §8.3）
        'apps/web/src/editor/**',
        // 命令行入口只做参数解析与输出，规则本身在各自的模块里测试
        'tools/src/**/cli.ts',
        'tools/src/**/*-cli.ts',
        'tools/src/git/commit-msg.ts',
        // 构建插件的测试样例工程
        'apps/web/build/fixtures/**',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        'packages/contracts/src/**': { lines: 90 },
        'apps/api/src/**': { lines: 80 },
        'apps/web/src/**': { lines: 70 },
        'apps/web/build/**': { lines: 80 },
        'tools/src/**': { lines: 80 },
      },
    },
  },
})
