// 故事清单与测试的自动对照（规范 §8.1）：当前 M 总设计里的每个用户故事都要登记；
// 状态为 active 的故事，必须有以其编号开头的测试标题，而且分布在登记的验证方式对应的位置。
import type { Violation } from '../gates/types.ts'
import { z } from 'zod'

const STORY_ID = /US-M\d+-\d+/
const DESIGN_ROW = /^\|\s*(US-M\d+-\d+)\s*\|/gm
const TITLE = /(?:\b(?:test|it|describe)(?:\.\w+)*|\))\s*\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g

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

export interface TestTitle {
  file: string
  kind: TestKind
  title: string
}

export function parseRegistry(json: unknown): StoryRegistry {
  return registrySchema.parse(json)
}

export function parseDesignStoryIds(markdown: string): string[] {
  return [...markdown.matchAll(DESIGN_ROW)].map(match => match[1] ?? '')
}

/** 取出测试文件里 test、it、describe 的字面量标题（故事编号必须写在字面量标题的开头）。 */
export function extractTitles(source: string): string[] {
  return [...source.matchAll(TITLE)].map(match => match[2] ?? '')
}

const KIND_OF: Readonly<Record<StoryRegistry['stories'][string]['verification'][number], TestKind>> = {
  'e2e': 'e2e',
  'integration': 'integration',
  'self-test': 'unit',
}

export function checkStories(designIds: readonly string[], registry: StoryRegistry, titles: readonly TestTitle[]): Violation[] {
  const violations: Violation[] = []
  const registered = new Set(Object.keys(registry.stories))
  for (const id of designIds) {
    if (!registered.has(id))
      violations.push({ rule: 'stories/unregistered', subject: id, detail: `M 总设计里有这个故事，但 tests/stories.json 没有登记` })
  }
  for (const id of registered) {
    if (!designIds.includes(id))
      violations.push({ rule: 'stories/unknown', subject: id, detail: `tests/stories.json 登记了它，但 M 总设计里没有` })
  }

  const titleIds = titles.map(t => ({ ...t, id: STORY_ID.exec(t.title)?.[0], leading: new RegExp(`^${STORY_ID.source}\\b`).test(t.title) }))
  for (const [id, story] of Object.entries(registry.stories)) {
    if (story.status !== 'active')
      continue
    for (const verification of story.verification) {
      const kind = KIND_OF[verification]
      if (!titleIds.some(t => t.leading && t.id === id && t.kind === kind))
        violations.push({ rule: 'stories/missing-test', subject: id, detail: `状态是 active，但没有以它开头的 ${verification} 测试` })
    }
  }
  for (const title of titleIds) {
    if (title.leading && title.id !== undefined && !registered.has(title.id))
      violations.push({ rule: 'stories/unknown-title', subject: title.id, detail: `${title.file} 的测试标题引用了没有登记的故事编号` })
  }
  return violations
}
