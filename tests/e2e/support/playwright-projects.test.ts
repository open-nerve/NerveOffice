// 实际导入配置，核对生产部署与默认门禁选到的文件及依赖；不复制项目生成逻辑。
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

interface Project {
  readonly name: string
  readonly dependencies: readonly string[]
  readonly workers?: number
  readonly timeout?: number
  readonly productionCrash: boolean
  readonly probeCrash: boolean
  readonly editor: boolean
  readonly restart: boolean
}

function projects(external: boolean, browsers: string): Project[] {
  const source = `
    import config from ${JSON.stringify(new URL('../playwright.config.ts', import.meta.url).href)};
    const accepts = (project, file) => {
      const matches = rule => (Array.isArray(rule) ? rule : [rule]).some(pattern => pattern.test(file));
      return (project.testMatch === undefined || matches(project.testMatch)) &&
        (project.testIgnore === undefined || !matches(project.testIgnore));
    };
    process.stdout.write(JSON.stringify(config.projects.map(project => ({
      name: project.name,
      dependencies: project.dependencies ?? [],
      workers: project.workers,
      timeout: project.timeout,
      productionCrash: accepts(project, '/specs/crash/production-recovery.spec.ts'),
      probeCrash: accepts(project, '/specs/crash/editor-recovery.spec.ts'),
      editor: accepts(project, '/specs/editor/conflict.spec.ts'),
      restart: accepts(project, '/specs/deploy/restart.spec.ts'),
    }))));
  `
  // 只读配置检查显式走列举路径，不借用外层 coverage 的受管资源。
  return JSON.parse(execFileSync(process.execPath, ['--conditions=@nerve-office/source', '--input-type=module', '-e', source, '--', '--list'], {
    env: {
      ...process.env,
      NERVE_TEST_RUN_ID: undefined,
      NERVE_TEST_SCRATCH: undefined,
      NERVE_TEST_OUTPUT_DIR: undefined,
      CI: 'false',
      E2E_BROWSERS: browsers,
      E2E_PORT: '48123',
      E2E_BASE_URL: external ? 'https://production.test' : undefined,
      E2E_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/config_only',
    },
    encoding: 'utf8',
    timeout: 10_000,
  })) as Project[]
}

describe('Playwright 生产崩溃项目的实际配置', () => {
  it('生产 Chromium 收到生产恢复文件，排除探针；后端重启等真实崩溃完成', () => {
    const actual = projects(true, 'chromium')
    expect(actual.map(project => project.name)).toEqual(['chromium', 'crash-chromium', 'restart'])
    expect(actual[0]).toMatchObject({ productionCrash: false, probeCrash: false, editor: true, restart: false })
    expect(actual[1]).toMatchObject({ productionCrash: true, probeCrash: false, editor: false, restart: false, dependencies: ['chromium'], workers: 1, timeout: 300_000 })
    expect(actual[2]).toMatchObject({ productionCrash: false, probeCrash: false, editor: false, restart: true, dependencies: ['chromium', 'crash-chromium'] })
  })

  it('默认三浏览器继续收到全部崩溃文件，原顺序与预算保留', () => {
    const browsers = ['chromium', 'chrome', 'webkit']
    const actual = projects(false, browsers.join(','))
    expect(actual.map(project => project.name)).toEqual([...browsers, 'crash-chromium', 'crash-chrome', 'crash-webkit', 'restart'])
    for (const browser of browsers) {
      expect(actual.find(project => project.name === browser)).toMatchObject({ productionCrash: false, probeCrash: false, editor: true })
      expect(actual.find(project => project.name === `crash-${browser}`)).toMatchObject({ productionCrash: true, probeCrash: true, editor: false, restart: false, dependencies: browsers, workers: 1, timeout: 300_000 })
    }
    expect(actual.at(-1)?.dependencies).toEqual([...browsers, 'crash-chromium', 'crash-chrome', 'crash-webkit'])
  })

  it('外部非 Chromium 分片仍跑生产恢复，但不重复重启后端', () => {
    const actual = projects(true, 'chrome,webkit')
    expect(actual.map(project => project.name)).toEqual(['chrome', 'webkit', 'crash-chrome', 'crash-webkit'])
    for (const project of actual.filter(project => project.name.startsWith('crash-')))
      expect(project).toMatchObject({ productionCrash: true, probeCrash: false, dependencies: ['chrome', 'webkit'] })
  })
})
