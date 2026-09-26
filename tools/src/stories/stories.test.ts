import type { StoryRegistry, TestTitle } from './stories.ts'
import { describe, expect, it } from 'vitest'
import { checkStories, extractTitles, parseDesignStoryIds, parseRegistry } from './stories.ts'

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

const covered: TestTitle[] = [
  { file: 'tests/integration/src/a.test.ts', kind: 'integration', title: 'US-M1-01 命令行初始化管理员' },
  { file: 'tests/e2e/specs/accounts/a.spec.ts', kind: 'e2e', title: 'US-M1-01 用初始化的账户登录' },
]

describe('parseDesignStoryIds', () => {
  it('从 M 总设计的故事表格中取出编号', () => {
    expect(parseDesignStoryIds(design)).toEqual(['US-M1-01', 'US-M1-02'])
  })
})

describe('extractTitles', () => {
  it('取出 test、it、describe 以及参数化用例的标题', () => {
    const source = [
      'test(\'US-M1-05 保存\', async () => {})',
      'test.describe("US-M1-06 重开", () => {})',
      'describe(`US-M1-11 A01`, () => {})',
      'it.each([[1, 2]])(\'US-M1-07 冲突 %s\', () => {})',
      'it(\'普通用例\', () => {})',
    ].join('\n')
    expect(extractTitles(source)).toEqual(['US-M1-05 保存', 'US-M1-06 重开', 'US-M1-11 A01', 'US-M1-07 冲突 %s', '普通用例'])
  })
})

describe('parseRegistry', () => {
  it('拒绝结构不对的登记表', () => {
    expect(() => parseRegistry({ design: 'x', stories: { 'US-M1-01': { phase: 'P3', status: 'done', verification: [] } } })).toThrow()
  })
})

describe('US-M1-11 故事对照', () => {
  it('合规：登记表与总设计一致，active 的故事有对应的测试', () => {
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

  it('违规：E2E 故事的用例不在 tests/e2e 下，不算数', () => {
    const misplaced: TestTitle[] = [covered[0]!, { file: 'apps/web/src/a.test.ts', kind: 'unit', title: 'US-M1-01 登录' }]
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, misplaced).map(v => v.rule)).toEqual(['stories/missing-test'])
  })

  it('违规：测试标题引用了不存在的故事编号', () => {
    const typo: TestTitle[] = [...covered, { file: 'tests/e2e/specs/x.spec.ts', kind: 'e2e', title: 'US-M1-99 不存在' }]
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, typo).map(v => `${v.rule} ${v.subject}`)).toEqual(['stories/unknown-title US-M1-99'])
  })

  it('合规：planned 的故事可以还没有测试，也可以已经有测试', () => {
    const early: TestTitle[] = [...covered, { file: 'tests/e2e/specs/b.spec.ts', kind: 'e2e', title: 'US-M1-02 登录' }]
    expect(checkStories(['US-M1-01', 'US-M1-02'], registry, early)).toEqual([])
  })
})
