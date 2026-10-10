// 对仓库现状执行不依赖网络与构建产物的门禁；故事对照、产物与漏洞三个门禁的装配逻辑用样例与临时目录测试，
// runGate 的门禁表经注入的样例输入核对（每个名字接的就是对应的门禁，M2-P6 第 6 片复核第二批 M-1）。
// 前一组会执行 pnpm 的列举命令（pnpm ls、pnpm licenses list），比其他单元测试慢。
import type { CommandRunner, GateInputs } from './run.ts'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJson, REPO_ROOT } from '../shared/repo.ts'
import { parseRegistry } from '../stories/stories.ts'
import { readFixture } from './fixtures.ts'
import { ARTIFACT_POLICY } from './policy.ts'
import { artifactsGate, auditGate, budgetsGate, GATE_NAMES, runGate, storiesGate } from './run.ts'

/** runGate 的样例输入：没有注入的命令一执行就失败（装配用了真实的命令时立即发现），产物目录不存在，日期写定 */
function sampleInputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return {
    run: (command, args) => {
      throw new Error(`样例没有注入这条命令的输出：${[command, ...args].join(' ')}`)
    },
    webDist: join(tmpdir(), 'nerve-no-such-dist'),
    today: () => '2026-09-26',
    ...overrides,
  }
}

// 故事对照（stories）不在这一组：它要列举仓库里的全部用例，慢在 vitest list --json（本机单独 16.8 秒；playwright --list 只要 0.5 秒），
// 覆盖率那一轮里与全部单元测试抢 CPU 时要 34 秒。pnpm verify 与 --fast 的 static-gates 一步本来就执行它（tools/src/verify/plan.ts），
// 这里再跑一遍是重复（M2-P6 第 6 片复核 M1）；它的装配由下面的"故事对照门禁的装配"用样例核对，对照规则本身在 stories.test.ts
describe('US-M1-11 门禁对仓库现状通过', () => {
  it.each(['pins', 'config', 'migrations', 'schema', 'deps', 'licenses'] as const)('%s', (name) => {
    const outcome = runGate(name)
    expect(outcome.violations).toEqual([])
    expect(outcome.name).toBe(name)
  })
}, 120_000)

describe('US-M1-11 故事对照门禁的装配', () => {
  const registry = parseRegistry(readJson('tests/stories.json'))

  /**
   * 列举命令的样例输出：登记表里每个 active 的故事、每种验证方式各一条会执行的用例（omit 那一条除外），
   * 放在验证方式对应的位置（E2E 在 playwright 的列举里，集成测试在 tests/integration 下，自测在 tools 下）
   */
  function listing(omit?: { readonly id: string, readonly verification: string }): { run: CommandRunner, commands: string[] } {
    const commands: string[] = []
    const vitest: { name: string, file: string }[] = []
    const specs: { title: string, file: string, tests: { expectedStatus: string }[] }[] = []
    for (const [id, story] of Object.entries(registry.stories)) {
      for (const verification of story.status === 'active' ? story.verification : []) {
        if (omit?.id === id && omit.verification === verification)
          continue
        if (verification === 'e2e')
          specs.push({ title: `${id} 样例`, file: 'sample.spec.ts', tests: [{ expectedStatus: 'passed' }] })
        else
          vitest.push({ name: `${id} 样例 > 一条用例`, file: join(REPO_ROOT, verification === 'integration' ? 'tests/integration/src/sample.test.ts' : 'tools/src/sample.test.ts') })
      }
    }
    const run: CommandRunner = (command, args) => {
      commands.push([command, ...args].join(' '))
      return args.includes('vitest') ? vitest : { suites: [{ title: 'sample.spec.ts', file: 'sample.spec.ts', specs }] }
    }
    return { run, commands }
  }

  it('执行 vitest list 与 e2e 包的 list 脚本两条列举；登记表与它列出的各份总设计一致、每个 active 的故事都有对应的测试时通过', () => {
    const { run, commands } = listing()
    const outcome = storiesGate(run)
    expect(commands).toEqual(['pnpm exec vitest list --json', 'pnpm --silent --filter @nerve-office/e2e run list'])
    expect(outcome.violations).toEqual([])
    expect(outcome.notes.join('\n')).toMatch(/列举出 \d+ 个会执行的测试/)
  })

  it('列举的结果确实交给了对照：少了某个 active 故事的 E2E，报出这一条', () => {
    const [id] = Object.entries(registry.stories).find(([, story]) => story.status === 'active' && story.verification.includes('e2e')) ?? []
    expect(id).toBeDefined()
    const outcome = storiesGate(listing({ id: id ?? '', verification: 'e2e' }).run)
    expect(outcome.violations.map(v => [v.rule, v.subject])).toEqual([['stories/missing-test', id]])
  })

  /**
   * 门禁自测不再对仓库现状跑 stories（M2-P6 第 6 片复核 M1），仓库现状只由静态门禁一步核对：门禁表里 stories 换成返回空结果的壳、
   * 或者不用注入的执行器，上面的用例照样通过（复核第二批 M-1）。这里经 runGate 走一遍门禁表，确认接的就是 storiesGate
   */
  it('runGate 的 stories 就是这个门禁：用注入的执行器列举两次，对照的结果原样交出（复核第二批 M-1）', () => {
    const { run, commands } = listing()
    const outcome = runGate('stories', sampleInputs({ run }))
    expect(commands).toEqual(['pnpm exec vitest list --json', 'pnpm --silent --filter @nerve-office/e2e run list'])
    expect(outcome).toEqual(storiesGate(listing().run))
    const [id] = Object.entries(registry.stories).find(([, story]) => story.status === 'active' && story.verification.includes('e2e')) ?? []
    const missing = runGate('stories', sampleInputs({ run: listing({ id: id ?? '', verification: 'e2e' }).run }))
    expect(missing.violations.map(v => [v.rule, v.subject])).toEqual([['stories/missing-test', id]])
  })
})

describe('US-M1-11 门禁的快捷脚本', () => {
  it('根 package.json 为每个门禁提供 gate:<名称>，新增门禁时不会漏（审查 B23）', () => {
    const { scripts } = z.object({ scripts: z.record(z.string(), z.string()) }).parse(readJson('package.json'))
    for (const name of GATE_NAMES)
      expect(scripts[`gate:${name}`], name).toBe(`node tools/src/gates/cli.ts ${name}`)
  })
})

/** 这个用例建的产物目录：一个用例里可以建好几个，结束时全部删掉（只记最后一个会漏删前面的，复验时发现临时目录里积了几百个） */
const dists: string[] = []

afterEach(() => {
  for (const dist of dists.splice(0))
    rmSync(dist, { recursive: true, force: true })
})

const MODULE_SOURCES = '.vite/module-sources.json'

/**
 * 模块来源清单（M3-P2 复核 B2）：样例里没有给出时，按其中的脚本写一份（每个脚本一个普通的源码模块），
 * 不核对它的用例不必关心；专门核对它的用例自己给出，或者 sources: false 去掉
 */
function withSources(files: Record<string, string>): Record<string, string> {
  if (MODULE_SOURCES in files)
    return files
  const scripts = Object.keys(files).filter(path => path.endsWith('.js'))
  return { ...files, [MODULE_SOURCES]: JSON.stringify(Object.fromEntries(scripts.map(path => [path, { name: basename(path, '.js'), modules: [`src/${basename(path, '.js')}.ts`] }]))) }
}

function writeDist(files: Record<string, string>, options: { readonly sources?: boolean } = {}): string {
  const dist = mkdtempSync(join(tmpdir(), 'nerve-dist-'))
  dists.push(dist)
  for (const [path, content] of Object.entries(options.sources === false ? files : withSources(files))) {
    mkdirSync(join(dist, dirname(path)), { recursive: true })
    writeFileSync(join(dist, path), content)
  }
  return dist
}

const clean = {
  'index.html': '<!doctype html><script type="module" src="/assets/index.js"></script>',
  'assets/index.js': 'const ns="http://www.w3.org/2000/svg";',
  '.vite/manifest.json': '{}',
  '.vite/third-party-packages.json': JSON.stringify([{ name: 'react', version: '19.3.0', license: 'MIT', licenseTextSource: 'package' }]),
  'THIRD-PARTY-LICENSES.md': '## react 19.3.0（MIT）\n\nhttps://github.com/facebook/react 的许可正文里有地址，不扫描\n',
}

describe('US-M1-11 产物门禁的装配', () => {
  it('合规：干净的产物', () => {
    expect(artifactsGate(writeDist(clean)).violations).toEqual([])
  })

  it('违规：没有构建产物', () => {
    expect(artifactsGate(join(tmpdir(), 'nerve-no-such-dist')).violations.map(v => v.rule)).toEqual(['artifacts/missing-build'])
  })

  it('违规：产物里没有随部署分发的许可正文，或者正文与清单对不上（Codex 评审 CX9：原来只看清单，删掉正文门禁照样通过）', () => {
    const { 'THIRD-PARTY-LICENSES.md': _text, ...withoutText } = clean
    expect(artifactsGate(writeDist(withoutText)).violations.map(v => v.rule)).toEqual(['license-bundle/missing-text-file'])
    expect(artifactsGate(writeDist({ ...clean, 'THIRD-PARTY-LICENSES.md': '' })).violations.map(v => v.rule)).toEqual(['license-bundle/missing-text-file'])
    expect(artifactsGate(writeDist({ ...clean, 'THIRD-PARTY-LICENSES.md': '## react 18.3.1（MIT）\n\nMIT License\n' })).violations.map(v => v.rule))
      .toEqual(['license-bundle/text-mismatch', 'license-bundle/text-mismatch'])
    // 清单也没有时，只核对正文的文件还在
    const { '.vite/third-party-packages.json': _bundle, ...neither } = withoutText
    expect(artifactsGate(writeDist(neither)).violations.map(v => v.rule)).toEqual(['license-bundle/missing-file', 'license-bundle/missing-text-file'])
  })

  it('违规：编辑器的 E2E 探针进了生产构建：探针的分块与它挂在 window 上的名字都报出；并进别的分块时名字照样报出（M2-P3 设计 §3.7）', () => {
    // 测试构建（dist-e2e）里探针分块的原样
    const probe = 'function e(e,t){let n={univerAPI:e,snapshot:()=>JSON.stringify(t.save())};return window.__nerveEditorProbe=n,()=>{window.__nerveEditorProbe===n&&delete window.__nerveEditorProbe}}export{e as installEditorProbe};'
    const chunk = artifactsGate(writeDist({ ...clean, 'assets/e2e-probe-CC7cG7BE.js': probe }))
    expect(chunk.violations.map(v => [v.rule, v.subject]).sort()).toEqual([['artifacts/keyword', '__nerveEditorProbe'], ['artifacts/test-only', 'assets/e2e-probe-CC7cG7BE.js']])
    const inlined = artifactsGate(writeDist({ ...clean, 'assets/index.js': `${clean['assets/index.js']}${probe}` }))
    expect(inlined.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', '__nerveEditorProbe']])
  })

  it('违规：页面自检进了生产构建：入口页与分块报出，并进别的分块时结果的格式标识照样报出（M3-P2 设计 §3.5）', () => {
    // 测试构建（dist-e2e）里自检模块的写法（节选）
    const selftest = 'const e="nerve-office.editor-selftest.v1";async function t(n){return{format:e,scenario:n.scenario,checks:[]}}export{t as runSelftestAndReport};'
    const chunk = artifactsGate(writeDist({ ...clean, 'selftest.html': '<!doctype html><title>页面自检</title>', 'assets/selftest-DF73r1gg.js': selftest }))
    expect(chunk.violations.map(v => [v.rule, v.subject]).sort()).toEqual([
      ['artifacts/keyword', 'nerve-office.editor-selftest'],
      ['artifacts/test-only', 'assets/selftest-DF73r1gg.js'],
      ['artifacts/test-only', 'selftest.html'],
    ])
    const inlined = artifactsGate(writeDist({ ...clean, 'assets/index.js': `${clean['assets/index.js']}${selftest}` }))
    expect(inlined.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', 'nerve-office.editor-selftest']])
  })

  it('违规：生产代码直接动态引入了测试专用的模块（分块名、关键字都看不出来）：按模块来源认出；并进入口块的同样认出（M3-P2 复核 B2）', () => {
    const index = { name: 'index', modules: ['index.html', 'src/entries/platform/main.ts'] }
    const timing = { name: 'timing', modules: ['src/editor/testing/switch-timing.ts'] }
    const separate = artifactsGate(writeDist({ ...clean, 'assets/timing-x1Y2z3A4.js': 'export const t=1', [MODULE_SOURCES]: JSON.stringify({ 'assets/index.js': index, 'assets/timing-x1Y2z3A4.js': timing }) }))
    expect(separate.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/test-only-source', 'assets/timing-x1Y2z3A4.js']])
    const merged = artifactsGate(writeDist({ ...clean, [MODULE_SOURCES]: JSON.stringify({ 'assets/index.js': { ...index, modules: [...index.modules, ...timing.modules] } }) }))
    expect(merged.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/test-only-source', 'assets/index.js']])
    // 计时挂在 window 上的名字另由禁用关键字兜底
    const named = artifactsGate(writeDist({ ...clean, 'assets/index.js': 'window.__nerveSwitchTiming={marks:[]}' }))
    expect(named.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', '__nerveSwitchTiming']])
  })

  it('违规：交接日志（M3-P5 设计 §3.13 的观察钩子）进了生产构建：分块名、按来源都认得出，并进别的分块时挂在 window 上的名字照样报出', () => {
    // 测试构建（dist-e2e）里交接日志的写法（节选）
    const log = 'const e="__nerveHandoverLog";function t(n){const r=[];return n[e]={log:()=>r.slice()},{observe:o=>r.push(o)}}export{t as installHandoverLog};'
    const index = { name: 'index', modules: ['index.html', 'src/entries/platform/main.ts'] }
    const handover = { name: 'handover-log', modules: ['src/editor/testing/handover-log.ts'] }
    const chunk = artifactsGate(writeDist({ ...clean, 'assets/handover-log-zZeb8RYs.js': log, [MODULE_SOURCES]: JSON.stringify({ 'assets/index.js': index, 'assets/handover-log-zZeb8RYs.js': handover }) }))
    expect(chunk.violations.map(v => [v.rule, v.subject]).sort()).toEqual([
      ['artifacts/keyword', '__nerveHandoverLog'],
      ['artifacts/test-only', 'assets/handover-log-zZeb8RYs.js'],
      ['artifacts/test-only-source', 'assets/handover-log-zZeb8RYs.js'],
    ])
    const inlined = artifactsGate(writeDist({ ...clean, 'assets/index.js': `${clean['assets/index.js']}${log}` }))
    expect(inlined.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', '__nerveHandoverLog']])
  })

  it('违规：发件箱的浏览器层探针（M4-P1 设计 §3.1）进了生产构建：分块名、按来源都认得出，并进别的分块时挂在 window 上的名字照样报出', () => {
    // 测试构建（dist-e2e）里探针的写法（节选）
    const probe = 'const e="__nerveOutboxProbe";function t(n){const r={names:{}};return n[e]=r,r}export{t as installOutboxProbe};'
    const index = { name: 'index', modules: ['index.html', 'src/entries/platform/main.ts'] }
    const outbox = { name: 'outbox-probe', modules: ['src/features/sheet-editor/outbox/testing/outbox-probe.ts', 'src/shared/outbox/draft-store.ts'] }
    const chunk = artifactsGate(writeDist({ ...clean, 'assets/outbox-probe-Q1w2E3r4.js': probe, [MODULE_SOURCES]: JSON.stringify({ 'assets/index.js': index, 'assets/outbox-probe-Q1w2E3r4.js': outbox }) }))
    expect(chunk.violations.map(v => [v.rule, v.subject]).sort()).toEqual([
      ['artifacts/keyword', '__nerveOutboxProbe'],
      ['artifacts/test-only', 'assets/outbox-probe-Q1w2E3r4.js'],
      ['artifacts/test-only-source', 'assets/outbox-probe-Q1w2E3r4.js'],
    ])
    const inlined = artifactsGate(writeDist({ ...clean, 'assets/index.js': `${clean['assets/index.js']}${probe}` }))
    expect(inlined.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', '__nerveOutboxProbe']])
  })

  it('违规：崩溃用例的探针（M4-P1 设计 §3.7）进了生产构建：分块名、按来源都认得出，并进别的分块时挂在 window 上的名字照样报出', () => {
    // 测试构建（dist-e2e）里探针的写法（节选）
    const probe = 'const e="__nerveCrashProbe";function t(n){const r={last:()=>{}};return n[e]=r,r}export{t as installCrashProbe};'
    const index = { name: 'index', modules: ['index.html', 'src/entries/platform/main.ts'] }
    const crash = { name: 'crash-probe', modules: ['src/features/sheet-editor/outbox/testing/crash-probe.ts'] }
    const chunk = artifactsGate(writeDist({ ...clean, 'assets/crash-probe-Q1w2E3r4.js': probe, [MODULE_SOURCES]: JSON.stringify({ 'assets/index.js': index, 'assets/crash-probe-Q1w2E3r4.js': crash }) }))
    expect(chunk.violations.map(v => [v.rule, v.subject]).sort()).toEqual([
      ['artifacts/keyword', '__nerveCrashProbe'],
      ['artifacts/test-only', 'assets/crash-probe-Q1w2E3r4.js'],
      ['artifacts/test-only-source', 'assets/crash-probe-Q1w2E3r4.js'],
    ])
    const inlined = artifactsGate(writeDist({ ...clean, 'assets/index.js': `${clean['assets/index.js']}${probe}` }))
    expect(inlined.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', '__nerveCrashProbe']])
  })

  it('违规：没有模块来源清单、产物里有清单没记下的脚本（按来源的核对看不到它们）', () => {
    expect(artifactsGate(writeDist(clean, { sources: false })).violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/missing-module-sources', MODULE_SOURCES]])
    const unlisted = artifactsGate(writeDist({ ...clean, 'assets/extra-a1.js': 'export {}', [MODULE_SOURCES]: JSON.stringify({ 'assets/index.js': { name: 'index', modules: ['index.html'] } }) }))
    expect(unlisted.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/unlisted-script', 'assets/extra-a1.js']])
  })

  it('违规：产物里的动态代码、.json 里的外部地址、未登记的文件类型、缺少许可清单', () => {
    const { '.vite/third-party-packages.json': _omitted, ...withoutBundle } = clean
    const outcome = artifactsGate(writeDist({ ...withoutBundle, 'assets/w.js': 'self.eval(x)', 'config.json': '{"endpoint":"https://evil.example.com"}', 'notes.md': '说明' }))
    expect(outcome.violations.map(v => v.rule).sort()).toEqual(['artifacts/address', 'artifacts/dynamic-code', 'artifacts/file-type', 'license-bundle/missing-file'])
  })

  it('说明列出出现的主机、主机在运行时拼出的地址、允许清单里这次没出现的地址与已登记的动态代码', () => {
    // eslint-disable-next-line no-template-curly-in-string -- 样例是产物里的模板字符串原文，不是要插值
    const outcome = artifactsGate(writeDist({ ...clean, 'assets/index.js': 'const ns="http://www.w3.org/2000/svg";const u=`http://[${e}]`' }))
    expect(outcome.violations).toEqual([])
    expect(outcome.notes).toEqual(expect.arrayContaining([
      '出现的主机：www.w3.org×1；主机在运行时拼出的地址 1 处（由 CSP 兜底）',
      '已登记的动态代码（出现次数为 0 的登记已经过时，核对后删除）：zod 的 JIT 探测×0、zod 的 JIT 编译器×0；全局对象探测 0 处（上限 2）',
    ]))
    expect(outcome.notes.find(note => note.startsWith('允许清单里这次没出现的地址'))).toContain('http://localhost')
  })

  it('说明：没有出现地址时，主机写"无"', () => {
    const outcome = artifactsGate(writeDist({ ...clean, 'assets/index.js': 'export const x = 1' }))
    expect(outcome.notes).toContain('出现的主机：无；主机在运行时拼出的地址 0 处（由 CSP 兜底）')
  })

  /** 两个入口：平台页面与编辑器页（编辑器页创建公式 Worker、有一个动态加载的块；Worker 动态加载一个块） */
  function withEditor(files: Record<string, string>, manifest: Record<string, unknown> = {}): Record<string, string> {
    return {
      ...clean,
      '.vite/manifest.json': JSON.stringify({
        'index.html': { file: 'assets/index.js', isEntry: true },
        'editor.html': { file: 'assets/editor.js', isEntry: true, dynamicImports: ['src/lazy.ts'], assets: ['assets/formula.worker-a1b2c3d4.js'] },
        'src/lazy.ts': { file: 'assets/lazy.js' },
        ...manifest,
      }),
      'editor.html': '<!doctype html><script type="module" src="/assets/editor.js"></script>',
      'assets/editor.js': 'new Worker(new URL(`/assets/formula.worker-a1b2c3d4.js`,``+import.meta.url),{type:`module`})',
      'assets/formula.worker-a1b2c3d4.js': 'self.onmessage=()=>import("./worker-lazy-b2.js")',
      'assets/worker-lazy-b2.js': 'export const y=2',
      'assets/lazy.js': 'export const x=1',
      ...files,
    }
  }

  it('说明：允许清单里的地址都出现时（前缀的登记出现在编辑器的产物里），没出现的地址写"无"', () => {
    const exact = ARTIFACT_POLICY.allowedAddresses.filter(entry => entry.prefix !== true).map(entry => JSON.stringify(entry.address)).join(',')
    const prefixed = ARTIFACT_POLICY.allowedAddresses.filter(entry => entry.prefix === true).map(entry => JSON.stringify(`${entry.address}sample`)).join(',')
    const outcome = artifactsGate(writeDist(withEditor({ 'assets/index.js': `export const addresses = [${exact}]`, 'assets/lazy.js': `export const links = [${prefixed}]` })))
    expect(outcome.violations).toEqual([])
    expect(outcome.notes).toContain('允许清单里这次没出现的地址（核对后删除）：无')
  })

  it('前缀的登记只适用于编辑器页能加载到的产物与它创建的 Worker；平台页面与其他文件只按具体地址（审查 A 路建议 B1）', () => {
    const link = JSON.stringify(`${ARTIFACT_POLICY.allowedAddresses.find(entry => entry.prefix === true)?.address ?? ''}sample`)
    for (const file of ['assets/editor.js', 'assets/lazy.js', 'assets/formula.worker-a1b2c3d4.js', 'assets/worker-lazy-b2.js']) {
      const outcome = artifactsGate(writeDist(withEditor({ [file]: `${withEditor({})[file] ?? ''};export const link=${link}` })))
      expect(outcome.violations, file).toEqual([])
    }
    for (const file of ['assets/index.js', 'assets/other.js']) {
      const outcome = artifactsGate(writeDist(withEditor({ [file]: `export const link=${link}` })))
      expect(outcome.violations.map(v => v.rule), file).toEqual(['artifacts/address'])
    }
    // 找不到构建清单时一律只按具体地址
    const noManifest = artifactsGate(writeDist({ ...withEditor({ 'assets/editor.js': `export const link=${link}` }), '.vite/manifest.json': '{}' }))
    expect(noManifest.violations.map(v => v.rule)).toEqual(['artifacts/address'])
  })

  it('前缀的登记：平台页面也能加载到的块（例如两边共用的动态块）、清单里没有编辑器入口时的编辑器页，只按具体地址（复验 RA8）', () => {
    const link = JSON.stringify(`${ARTIFACT_POLICY.allowedAddresses.find(entry => entry.prefix === true)?.address ?? ''}sample`)
    const shared = artifactsGate(writeDist(withEditor({ 'assets/lazy.js': `export const link=${link}` }, {
      'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: ['src/lazy.ts'] },
    })))
    expect(shared.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    const noEditorEntry = artifactsGate(writeDist({
      ...withEditor({ 'editor.html': `<!doctype html><a href=${link}>帮助</a>` }),
      '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js', isEntry: true } }),
    }))
    expect(noEditorEntry.violations.map(v => v.rule)).toEqual(['artifacts/address'])
  })
})

describe('US-M1-11 体积预算门禁的装配', () => {
  /** 两个入口与编辑器页创建的公式、本机草稿 Worker。与当前生产入口的预算登记一致。 */
  function dist(indexContent: string): string {
    return writeDist({
      '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js', isEntry: true }, 'editor.html': { file: 'assets/editor.js', isEntry: true, assets: ['assets/formula.worker-a1b2c3d4.js', 'assets/outbox.worker-b2c3d4e5.js'] } }),
      'assets/index.js': indexContent,
      'assets/editor.js': 'new Worker(new URL(`/assets/formula.worker-a1b2c3d4.js`,``+import.meta.url),{type:`module`});new Worker(new URL(`/assets/outbox.worker-b2c3d4e5.js`,``+import.meta.url),{type:`module`})',
      'assets/formula.worker-a1b2c3d4.js': 'self.onmessage=()=>{}',
      'assets/outbox.worker-b2c3d4e5.js': 'self.onmessage=()=>{}',
    })
  }

  it('按构建清单与产物文件计算：小的产物通过；平台页面超出预算时违规', () => {
    expect(budgetsGate(dist('console.log(1)')).violations).toEqual([])
    // 随机数据几乎压缩不了：200 KiB 随机字节的 base64（约 273 KiB 文本）gzip 之后仍超过 180 KiB 的预算
    const random = randomBytes(200 * 1024).toString('base64')
    expect(budgetsGate(dist(random)).violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('编辑器页的入口没有引用应登记的 Worker：公式与本机草稿分别违规', () => {
    const noWorker = writeDist({
      '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js', isEntry: true }, 'editor.html': { file: 'assets/editor.js', isEntry: true } }),
      'assets/index.js': 'console.log(1)',
      'assets/editor.js': 'console.log(2)',
    })
    expect(budgetsGate(noWorker).violations.map(({ rule, subject }) => ({ rule, subject }))).toEqual([
      { rule: 'budgets/missing-worker', subject: 'formula.worker' },
      { rule: 'budgets/missing-worker', subject: 'outbox.worker' },
    ])
  })

  it('违规：没有构建清单', () => {
    expect(budgetsGate(join(tmpdir(), 'nerve-no-such-dist')).violations.map(v => v.rule)).toEqual(['budgets/missing-build'])
  })
})

describe('US-M1-11 漏洞门禁的装配', () => {
  it('生产依赖的漏洞失败，全部依赖的计数写进说明（真实输出）', () => {
    const report = readFixture('pnpm-12/audit-with-advisories.json')
    const outcome = auditGate(() => report, '2026-09-26')
    expect(outcome.violations.map(v => v.rule)).toEqual(['audit/advisory', 'audit/advisory', 'audit/advisory'])
    expect(outcome.notes[0]).toContain('critical 1')
  })

  it('pnpm 的输出结构不对时直接报错，不当作没有漏洞', () => {
    expect(() => auditGate(() => ({ advisories: {} }), '2026-09-26')).toThrow()
  })

  // 2026-10-03 合并 M2-P5 之后的 CI：开发依赖里出现一条还没有修复版本的高危公告（braces，经 eslint-plugin-boundaries），
  // pnpm audit 的输出里 patched_versions 是 null，原来的结构要求字符串，门禁在解析全部依赖的报告时直接崩溃
  it('全部依赖里有还没有修复版本的公告（真实输出：patched_versions 为 null）：照常解析；只在开发依赖里时不失败，计数写进说明', () => {
    const unpatched = readFixture('pnpm-12/audit-unpatched-advisory.json')
    const empty = { advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }
    const outcome = auditGate((_command, args) => (args.includes('--prod') ? empty : unpatched), '2026-10-03')
    expect(outcome.violations).toEqual([])
    expect(outcome.notes[0]).toContain('high 1')
  })
})

describe('US-M1-11 runGate 的门禁表按注入的输入装配（M2-P6 第 6 片复核第二批 M-1）', () => {
  it('artifacts 与 budgets 用注入的产物目录，audit 用注入的执行器', () => {
    const dist = writeDist(clean)
    expect(runGate('artifacts', sampleInputs({ webDist: dist }))).toEqual(artifactsGate(dist))
    expect(runGate('budgets', sampleInputs({ webDist: dist }))).toEqual(budgetsGate(dist))
    const report = readFixture('pnpm-12/audit-with-advisories.json')
    expect(runGate('audit', sampleInputs({ run: () => report }))).toEqual(auditGate(() => report, '2026-09-26'))
  })
})
