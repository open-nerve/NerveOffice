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
          // tests/e2e/support 里的纯函数（例如页面错误里哪些是浏览器的通知）与真实 Safari 自检的驱动脚本（tests/e2e/safari）里的纯函数
          // 也在这里测，不用起浏览器；E2E 与集成测试共用的测试辅助（tests/shared，例如测试库的命名）同样
          include: ['packages/*/src/**/*.test.ts', 'tools/src/**/*.test.ts', 'apps/*/build/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'tests/e2e/support/**/*.test.ts', 'tests/e2e/safari/**/*.test.ts', 'tests/shared/**/*.test.ts'],
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
          // 每个测试文件一个进程（vitest 的默认，这里写明）：登录耗时的测试按这个进程的 CPU 时间量哈希的计算量（auth/login-timing.test.ts），
          // 换成线程池时别的测试文件的 CPU 时间也会算进来
          pool: 'forks',
          include: ['tests/integration/src/**/*.test.ts'],
          // single-query：每条用例之后核对应用的一个连接上没有并发过查询（support/single-query.ts）
          setupFiles: ['tests/integration/src/setup/database.ts', 'tests/integration/src/setup/single-query.ts'],
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
        // 测试辅助（*.test-support.ts、*.test-support.tsx）只被测试引用（lint 规则 nerve/test-code-only-in-tests 保证），不进构建产物
        '**/*.test-support.{ts,tsx}',
        // 入口文件只负责挂载，由 E2E 覆盖
        'apps/web/src/entries/**',
        // api 的进程入口与命令行入口只做组装，由进程测试覆盖（子进程不统计覆盖率）
        'apps/api/src/app/main.ts',
        'apps/api/src/cli/**',
        // 迁移是 SQL 与 JSON，不是代码
        'apps/api/src/db/migrations/**',
        // 编辑器适配层以 E2E 为主（规范 §8.3）
        'apps/web/src/editor/**',
        // 本机发件箱的 IndexedDB 接线（库的打开与升级、存储的事务、列表的索引）：jsdom 与 Node 都没有 IndexedDB，也不引入 fake-indexeddb
        // （它模拟不了配额与"事务里 await 别的异步就自动提交"），由三个浏览器的浏览器层用例覆盖（tests/e2e/specs/outbox，M4-P1 设计 §1 偏差 8）；
        // 判定都是纯函数，在单元测试里测：栅栏、恢复与保留期（writer-fence.ts），记录与提示的读法（draft-record.ts、recovery-notice.ts），
        // 能不能封草稿（draft-codec.ts 的 canSealDrafts）
        'apps/web/src/shared/outbox/database.ts',
        'apps/web/src/shared/outbox/draft-store.ts',
        'apps/web/src/shared/outbox/draft-index.ts',
        // 发件箱 Worker 的入口只做组装（接上处理、存储与空定时器），由浏览器层用例覆盖；处理、客户端与管道在单元测试里测
        'apps/web/src/features/sheet-editor/outbox/outbox.worker.ts',
        // 编辑器页测试构建里的探针：只在测试构建里，浏览器层用例经它调用生产代码
        'apps/web/src/features/sheet-editor/outbox/testing/**',
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
