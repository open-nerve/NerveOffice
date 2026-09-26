// 故事清单与测试的自动对照（规范 §8.1）：当前 M 总设计里的每个用户故事都要登记；
// 状态为 active 的故事，必须有以其编号开头的测试（describe 或用例的标题都可以），而且分布在登记的验证方式对应的位置。
// 测试清单取自 Vitest 与 Playwright 自己的列举（vitest list、playwright test --list），
// 所以注释掉的、字符串里的"用例"不算；被跳过或标为 fixme 的 E2E 也不算（lint 另外禁止跳过用例）。
import type { Violation } from '../gates/types.ts'
import { relative } from 'node:path'
import { z } from 'zod'

const STORY_ID = /^US-M\d+-\d+/
const DESIGN_ROW = /^\|\s*(US-M\d+-\d+)\s*\|/gm

export type TestKind = 'e2e' | 'integration' | 'unit'

const registrySchema = z.strictObject({
  $comment: z.string().optional(),
  design: z.string().min(1),
  stories: z.record(z.string().regex(/^US-M\d+-\d+$/), z.strictObject({
    phase: z.string().regex(/^P\d+$/),
    status: z.enum(['planned', 'active']),
    // self-test 指门禁、工具自身的单元测试
    verification: z.array(z.enum(['e2e', 'integration', 'self-test'])).min(1),
  })),
})

export type StoryRegistry = z.infer<typeof registrySchema>

/** 一条会执行的测试：所在文件、类别，以及从外层 describe 到用例本身的标题。 */
export interface ListedTest {
  file: string
  kind: TestKind
  titles: string[]
}

export function parseRegistry(json: unknown): StoryRegistry {
  return registrySchema.parse(json)
}

export function parseDesignStoryIds(markdown: string): string[] {
  return [...markdown.matchAll(DESIGN_ROW)].map(match => match[1] ?? '')
}

const vitestListSchema = z.array(z.object({ name: z.string(), file: z.string(), projectName: z.string().optional() }))

/** `vitest list --json` 的输出：name 是 "describe > 用例" 形式的完整标题。 */
export function testsFromVitestList(json: unknown, repoRoot: string): ListedTest[] {
  return vitestListSchema.parse(json).map((test) => {
    const file = relative(repoRoot, test.file)
    return { file, kind: file.startsWith('tests/integration/') ? 'integration' : 'unit', titles: test.name.split(' > ') }
  })
}

interface PlaywrightSuite {
  title: string
  file?: string | undefined
  specs?: { title: string, file: string, tests: { expectedStatus: string }[] }[] | undefined
  suites?: PlaywrightSuite[] | undefined
}

const playwrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.object({
  title: z.string(),
  file: z.string().optional(),
  specs: z.array(z.object({ title: z.string(), file: z.string(), tests: z.array(z.object({ expectedStatus: z.string() })) })).optional(),
  get suites() {
    return z.array(playwrightSuiteSchema).optional()
  },
})

/** `playwright test --list --reporter=json` 的输出：最外层的套件是文件，里面是 describe；只取预期会执行的用例。 */
export function testsFromPlaywrightList(json: unknown, specRoot: string): ListedTest[] {
  const { suites } = z.object({ suites: z.array(playwrightSuiteSchema) }).parse(json)
  const tests: ListedTest[] = []
  const walk = (suite: PlaywrightSuite, titles: string[]): void => {
    for (const spec of suite.specs ?? []) {
      if (spec.tests.some(test => test.expectedStatus === 'passed'))
        tests.push({ file: `${specRoot}/${spec.file}`, kind: 'e2e', titles: [...titles, spec.title] })
    }
    for (const child of suite.suites ?? [])
      walk(child, [...titles, child.title])
  }
  for (const fileSuite of suites)
    walk(fileSuite, [])
  return tests
}

const KIND_OF: Readonly<Record<StoryRegistry['stories'][string]['verification'][number], TestKind>> = {
  'e2e': 'e2e',
  'integration': 'integration',
  'self-test': 'unit',
}

function storyIdsOf(test: ListedTest): string[] {
  return test.titles.map(title => STORY_ID.exec(title)?.[0]).filter((id): id is string => id !== undefined)
}

export function checkStories(designIds: readonly string[], registry: StoryRegistry, tests: readonly ListedTest[]): Violation[] {
  const violations: Violation[] = []
  const registered = new Set(Object.keys(registry.stories))
  for (const id of designIds) {
    if (!registered.has(id))
      violations.push({ rule: 'stories/unregistered', subject: id, detail: 'M 总设计里有这个故事，但 tests/stories.json 没有登记' })
  }
  for (const id of registered) {
    if (!designIds.includes(id))
      violations.push({ rule: 'stories/unknown', subject: id, detail: 'tests/stories.json 登记了它，但 M 总设计里没有' })
  }

  for (const [id, story] of Object.entries(registry.stories)) {
    if (story.status !== 'active')
      continue
    for (const verification of story.verification) {
      const kind = KIND_OF[verification]
      if (!tests.some(test => test.kind === kind && storyIdsOf(test).includes(id)))
        violations.push({ rule: 'stories/missing-test', subject: id, detail: `状态是 active，但没有标题以它开头、会执行的 ${verification} 测试` })
    }
  }
  const reported = new Set<string>()
  for (const test of tests) {
    for (const id of storyIdsOf(test)) {
      if (!registered.has(id) && !reported.has(id)) {
        reported.add(id)
        violations.push({ rule: 'stories/unknown-title', subject: id, detail: `${test.file} 的测试标题引用了没有登记的故事编号` })
      }
    }
  }
  return violations
}
