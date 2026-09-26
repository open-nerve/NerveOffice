import type { ListedTest, StoryRegistry } from './stories.ts'
import { describe, expect, it } from 'vitest'
import { readFixture } from '../gates/fixtures.ts'
import { checkStories, parseDesignStoryIds, parseRegistry, testsFromPlaywrightList, testsFromVitestList } from './stories.ts'

const design = `
| 编号 | 角色 | 故事 | 验收 |
|---|---|---|---|
| US-M1-01 | 运维人员 | 初始化管理员 | … |
| US-M1-02 | 成员 | 登录 | … |
`

const registry: StoryRegistry = {
  design: 'docs/x.md',
  stories: {
    'US-M1-01': { phase: 'P3', status: 'active', verification: ['integration', 'e2e'] },
    'US-M1-02': { phase: 'P3', status: 'planned', verification: ['e2e'] },
  },
}

const covered: ListedTest[] = [
  { file: 'tests/integration/src/a.test.ts', kind: 'integration', titles: ['US-M1-01 命令行初始化管理员', '已有管理员时拒绝'] },
  { file: 'tests/e2e/specs/accounts/a.spec.ts', kind: 'e2e', titles: ['US-M1-01 用初始化的账户登录'] },
]

describe('parseDesignStoryIds', () => {
  it('从 M 总设计的故事表格中取出编号', () => {
    expect(parseDesignStoryIds(design)).toEqual(['US-M1-01', 'US-M1-02'])
  })
})

describe('测试清单的解析（真实输出）', () => {
  it('Vitest：按文件位置区分单元与集成，标题按 describe 拆开', () => {
    const tests = testsFromVitestList(readFixture('vitest/list.json'), '/repo')
    expect(tests.find(t => t.file === 'tools/src/gates/pins.test.ts')).toMatchObject({ kind: 'unit', titles: ['US-M1-11 A01 精确版本', '合规：外部依赖都经目录引用，内部包用 workspace:*'] })
    expect(tests.filter(t => t.kind === 'integration').map(t => t.file)).toEqual(['tests/integration/src/database-environment.test.ts', 'tests/integration/src/accounts/admin-init.test.ts'])
  })

  it('Playwright：只取会执行的用例；跳过的、fixme 的、注释掉的都不算，describe 的标题一并保留', () => {
    const tests = testsFromPlaywrightList(readFixture('playwright/list-with-skips.json'), 'tests/e2e/specs')
    expect(tests.map(t => t.titles.join(' > ')).sort()).toEqual([
      'US-M1-05 保存到云端 > 显示已保存到云端',
      'US-M1-05 保存到云端 > 显示已保存到云端',
      'US-M1-06 重新打开',
      'US-M1-06 重新打开',
    ])
    expect(tests[0]?.file).toBe('tests/e2e/specs/sheet/save.spec.ts')
  })
})

describe('parseRegistry', () => {
  it('拒绝结构不对的登记表', () => {
    expect(() => parseRegistry({ design: 'x', stories: { 'US-M1-01': { phase: 'P3', status: 'done', verification: [] } } })).toThrow()
  })
})

describe('US-M1-11 故事对照', () => {
  it('合规：登记表与总设计一致，active 的故事有对应的测试（标题在 describe 或用例上都可以）', () => {
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, covered)).toEqual([])
  })

  it('违规：总设计里的故事没有登记', () => {
    expect(checkStories(['US-M1-01', 'US-M1-02', 'US-M1-03'], registry, covered).map(v => `${v.rule} ${v.subject}`)).toEqual(['stories/unregistered US-M1-03'])
  })

  it('违规：登记表里有总设计没有的故事', () => {
    expect(checkStories(['US-M1-01'], registry, covered).map(v => `${v.rule} ${v.subject}`)).toEqual(['stories/unknown US-M1-02'])
  })

  it('违规：active 的故事缺少某一类测试', () => {
    const onlyE2e = covered.filter(t => t.kind === 'e2e')
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, onlyE2e).map(v => `${v.rule} ${v.subject}`)).toEqual(['stories/missing-test US-M1-01'])
  })

  it('违规：E2E 故事的用例只以跳过或 fixme 的形式存在（真实输出）', () => {
    const skipped: StoryRegistry = { design: 'x', stories: { 'US-M1-07': { phase: 'P4', status: 'active', verification: ['e2e'] }, 'US-M1-08': { phase: 'P4', status: 'active', verification: ['e2e'] }, 'US-M1-10': { phase: 'P5', status: 'active', verification: ['e2e'] } } }
    const tests = testsFromPlaywrightList(readFixture('playwright/list-with-skips.json'), 'tests/e2e/specs')
    expect(checkStories(['US-M1-07', 'US-M1-08', 'US-M1-10'], skipped, tests).map(v => `${v.rule} ${v.subject}`).sort()).toEqual([
      'stories/missing-test US-M1-07',
      'stories/missing-test US-M1-08',
      'stories/missing-test US-M1-10',
      'stories/unknown-title US-M1-05',
      'stories/unknown-title US-M1-06',
    ])
  })

  it('违规：E2E 故事的用例不在 tests/e2e 下，不算数', () => {
    const misplaced: ListedTest[] = [covered[0]!, { file: 'apps/web/src/a.test.ts', kind: 'unit', titles: ['US-M1-01 登录'] }]
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, misplaced).map(v => v.rule)).toEqual(['stories/missing-test'])
  })

  it('违规：测试标题引用了不存在的故事编号', () => {
    const typo: ListedTest[] = [...covered, { file: 'tests/e2e/specs/x.spec.ts', kind: 'e2e', titles: ['US-M1-99 不存在'] }]
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, typo).map(v => `${v.rule} ${v.subject}`)).toEqual(['stories/unknown-title US-M1-99'])
  })

  it('合规：planned 的故事可以还没有测试，也可以已经有测试', () => {
    const early: ListedTest[] = [...covered, { file: 'tests/e2e/specs/b.spec.ts', kind: 'e2e', titles: ['US-M1-02 登录'] }]
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, early)).toEqual([])
  })
})
