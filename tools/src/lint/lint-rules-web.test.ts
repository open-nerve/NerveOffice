// lint 规则的自测（平台页面）：前端的模块边界与入口、按需加载与平台页面的首屏、Radix 的弹窗原语、人名的拼法、读屏用的状态区。
// 共用的准备与时限见 lint-harness.test-support.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'
import {
  LINT_TIMEOUT,
  PLATFORM_ENTRY,
  prepareLint,
  PROBE,
  PROBE_FILES,
  RADIX_DIALOG_MESSAGE,
  restrictedSyntaxSelectors,
  severity,
  WEB_FEATURE_FILE,
  WEB_FILE,
  WEB_SHARED_FILE,
  WEB_TEST_FILE,
  WEB_TEST_SUPPORT,
} from './lint-harness.test-support.ts'

const { lint, rulesFor, lintAtProbe, configFor } = prepareLint({ warmUp: [WEB_FILE], probes: true })

const ROUTES_FILE = 'apps/web/src/app/routes.ts'
const dynamicImport = (path: string): string => `export async function pages() {\n  return import('${path}')\n}\n`

describe('US-M1-11 lint 规则的自测：平台页面的模块边界与入口', () => {
  it('跨越模块边界的引用会失败（平台代码引用仓库工具）', async () => {
    const code = 'import { stripAiTrailers } from \'../../../../tools/src/git/strip-ai-trailers.ts\'\nexport const f = stripAiTrailers\n'
    expect(await rulesFor(code, WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('平台页面的入口不能引用编辑器', async () => {
    const report = await lint(`import { probe } from '../../editor/${PROBE}/editor-part.ts'\nexport const p = probe\n`, PLATFORM_ENTRY)
    expect(report.rules).toContain('boundaries/dependencies')
    expect(report.messages.join('\n')).toContain('平台页面的入口不得引用编辑器')
  })

  it('应用的入口只写副作用导入，第一个是 zod-jitless（ADR-008，审查 B1）', async () => {
    const valid = 'import \'../../shared/lib/zod-jitless.ts\'\nimport \'../../app/styles.css\'\nimport \'./mount.tsx\'\n'
    expect(await rulesFor(valid, PLATFORM_ENTRY)).toEqual([])
    const wrongOrder = 'import \'../../app/styles.css\'\nimport \'../../shared/lib/zod-jitless.ts\'\nimport \'./mount.tsx\'\n'
    const reordered = await lint(wrongOrder, PLATFORM_ENTRY)
    expect(reordered.rules).toContain('no-restricted-syntax')
    expect(reordered.messages.join('\n')).toContain('第一个导入 shared/lib/zod-jitless.ts')
    const withCode = 'import \'../../shared/lib/zod-jitless.ts\'\nimport { createAppRuntime } from \'../../app/runtime.ts\'\n\ncreateAppRuntime()\n'
    const mixed = await lint(withCode, PLATFORM_ENTRY)
    expect(mixed.rules.filter(rule => rule === 'no-restricted-syntax')).toHaveLength(2)
    expect(mixed.messages.join('\n')).toContain('只写副作用导入')
  })

  it('写成 main.ts 的入口同样受约束；CSP 阳性对照与页面自检的入口页除外（复验 R7；M3-P2 复核 B4）', async () => {
    const config = await configFor('apps/web/src/entries/editor/main.ts')
    const syntax = config.rules?.['no-restricted-syntax']
    expect(JSON.stringify(syntax)).toContain('zod-jitless')
    const probe = await configFor('apps/web/src/entries/csp-probe/main.ts')
    expect(JSON.stringify(probe.rules?.['no-restricted-syntax'])).not.toContain('zod-jitless')
    const selftest = await configFor('apps/web/src/entries/selftest/main.ts')
    expect(JSON.stringify(selftest.rules?.['no-restricted-syntax'])).not.toContain('zod-jitless')
  })

  it('每个页面（apps/web/*.html）引用的入口脚本都受入口规则约束：CSP 阳性对照除外，页面自检的入口页改受"自给自足"的规则约束；入口换了名字或写法也不会漏掉（复验 S7；M3-P2 复核 B4）', async () => {
    const pages = readdirSync(join(REPO_ROOT, 'apps/web')).filter(name => name.endsWith('.html'))
    expect(pages).toContain('index.html')
    for (const page of pages) {
      const html = readFileSync(join(REPO_ROOT, 'apps/web', page), 'utf8')
      const scripts = [...html.matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)].map(match => `apps/web/${match[1] ?? ''}`)
      expect(scripts, page).not.toEqual([])
      for (const script of scripts) {
        const config = await configFor(script)
        const syntax = JSON.stringify(config.rules?.['no-restricted-syntax'])
        if (page === 'csp-probe.html') {
          expect(syntax, script).not.toContain('zod-jitless')
        }
        else if (page === 'selftest.html') {
          expect(syntax, script).not.toContain('zod-jitless')
          expect(JSON.stringify(config.rules?.['ts/no-restricted-imports']), script).toContain('selftest-report')
        }
        else {
          expect(syntax, script).toContain('zod-jitless')
        }
      }
    }
  })

  it('页面自检的入口页（只在测试构建里）只许引用自己目录里的文件与结果的格式：平台页面与编辑器页共用的模块（contracts、shared、zod-jitless）一概不许（M3-P2 复核 B4）', async () => {
    const signIn = 'apps/web/src/entries/selftest/sign-in.ts'
    expect(await rulesFor('import \'./sign-in.ts\'\n', 'apps/web/src/entries/selftest/main.ts')).toEqual([])
    expect(await rulesFor('import { NEXT_PARAM } from \'../../editor/testing/selftest-report.ts\'\n\nexport const next = NEXT_PARAM\n', signIn)).toEqual([])
    for (const code of [
      'import { documentPagePath } from \'@nerve-office/contracts\'\n\nexport const path = documentPagePath\n',
      'import { apiRequest } from \'../../shared/api/index.ts\'\n\nexport const request = apiRequest\n',
      'import \'../../shared/lib/zod-jitless.ts\'\n',
    ]) {
      const report = await lint(code, signIn)
      expect(report.rules, code).toContain('ts/no-restricted-imports')
      expect(report.messages.join('\n'), code).toContain('页面自检的入口页只引用自己目录里的文件与结果的格式')
    }
  })

  it('页面自检的入口页里动态 import() 一律报错（复验 C3：受限导入只看声明，复验者动态引入 shared/api 时 lint 放行、入口块照样与生产的不同）：共用的模块、自己目录里的文件、结果的格式都算；在 web 的整组限制之上只加了这一条', async () => {
    const signIn = 'apps/web/src/entries/selftest/sign-in.ts'
    const load = (source: string): string => `export async function load(): Promise<unknown> {\n  return import('${source}')\n}\n`
    for (const source of ['../../shared/api/index.ts', '@nerve-office/contracts', '../../shared/lib/zod-jitless.ts', './helper.ts', '../../editor/testing/selftest-report.ts']) {
      const report = await lint(load(source), signIn)
      expect(report.rules, source).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), source).toContain('页面自检的入口页不用动态 import()')
    }
    for (const entry of [signIn, 'apps/web/src/entries/selftest/main.ts'])
      expect(restrictedSyntaxSelectors(await configFor(entry)), entry).toEqual([...restrictedSyntaxSelectors(await configFor(WEB_SHARED_FILE)), 'ImportExpression'])
  })

  it('不能借"无主"文件中转绕过边界', async () => {
    expect(await rulesFor(`import { probe } from '../../${PROBE}.ts'\nexport const p = probe\n`, PLATFORM_ENTRY)).toContain('boundaries/no-unknown-dependencies')
    const config = await configFor('apps/web/src/stray.ts')
    expect(severity(config.rules?.['boundaries/no-unknown-files'])).toBe(2)
  })

  it('跨元素只能引用公开入口', async () => {
    expect(await rulesFor('import { errorResponseSchema } from \'../../../../packages/contracts/src/errors/error-response.ts\'\nexport const s = errorResponseSchema\n', WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('前端分层：共享层不能引用应用层；功能模块之间只经对方的公开入口（审查 B23）', async () => {
    expect(await rulesFor('import { createAppRuntime } from \'../../app/runtime.ts\'\nexport const f = createAppRuntime\n', WEB_SHARED_FILE)).toContain('boundaries/dependencies')
    expect(await rulesFor('import { fetchPersonalDocuments } from \'../documents/documents-api.ts\'\nexport const f = fetchPersonalDocuments\n', WEB_FEATURE_FILE)).toContain('boundaries/dependencies')
    expect(await rulesFor('import { DocumentListPage } from \'../documents/index.ts\'\nexport const f = DocumentListPage\n', WEB_FEATURE_FILE)).not.toContain('boundaries/dependencies')
  })

  it('平台的应用层、其他入口与其他功能不能引用编辑器页；编辑器页自己内部的引用不受影响', async () => {
    const importPart = (path: string): string => `import { probe } from '${path}'\n\nexport const p = probe\n`
    const part = `${PROBE}-part.ts`
    for (const [file, path] of [[WEB_FILE, `../features/sheet-editor/${part}`], [WEB_FEATURE_FILE, `../sheet-editor/${part}`], ['apps/web/src/entries/platform/mount.tsx', `../../features/sheet-editor/${part}`]] as const) {
      const report = await lint(importPart(path), file)
      expect(report.rules, file).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('只由编辑器页的入口引用')
    }
    expect((await lintAtProbe(importPart(`./${part}`), PROBE_FILES.sheetEditor)).rules).not.toContain('boundaries/dependencies')
    // 编辑器页的入口不受这条限制（它照常只能经公开入口引用编辑器页）
    const fromEntry = await lintAtProbe(importPart(`../../features/sheet-editor/${part}`), PROBE_FILES.editorEntry)
    expect(fromEntry.messages.join('\n')).not.toContain('只由编辑器页的入口引用')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：按需加载的页面不进平台页面的首屏', () => {
  describe('管理界面按需加载（M2-P1 审查 B2）', () => {
    it('只有路由表能动态 import() 它的公开入口；静态引用、类型引用、再导出、别处的动态引用都不行', async () => {
      expect(await rulesFor(dynamicImport('../features/admin/index.ts'), ROUTES_FILE)).not.toContain('boundaries/dependencies')
      const violations: [string, string][] = [
        // 路由表：静态引用、动态引用内部文件
        [`import { AdminLayout } from '../features/admin/index.ts'\n\nexport const layout = AdminLayout\n`, ROUTES_FILE],
        [dynamicImport('../features/admin/users-page.tsx'), ROUTES_FILE],
        // 应用层的其他文件、功能模块、入口
        [dynamicImport('../features/admin/index.ts'), WEB_FILE],
        [`import type { AdminLayout } from '../admin/index.ts'\n\nexport type Layout = typeof AdminLayout\n`, WEB_FEATURE_FILE],
        [`export { AdminLayout } from '../../features/admin/index.ts'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of violations) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain('管理界面（features/admin）按需加载')
      }
      // 管理界面自己内部的引用不受影响
      expect(await rulesFor('import { ADMIN_QUERY_KEY } from \'./admin-api.ts\'\n\nexport const key = ADMIN_QUERY_KEY\n', 'apps/web/src/features/admin/users-page.tsx')).not.toContain('boundaries/dependencies')
    })

    it('弹窗不经 shared 的任何文件转出：Radix Dialog 会随桶文件进首屏（复验 N2）。按解析之后的路径判断，中转与换写法都拦得住（复验 X6）', async () => {
      const BARREL = 'apps/web/src/shared/ui/index.ts'
      const relayed: [string, string][] = [
        [`export { Dialog } from './dialog.tsx'\n`, BARREL],
        [`export * from './dialog.tsx'\n`, BARREL],
        [`export { Dialog } from '../ui/dialog.tsx'\n`, BARREL],
        [`export { Dialog } from './dialog.js'\n`, BARREL],
        [`export { Dialog } from './dialog'\n`, BARREL],
        [`export type { DialogContent } from './dialog.tsx'\n`, BARREL],
        // shared 里别的文件中转
        [`export { Dialog } from '../ui/dialog.tsx'\n`, WEB_SHARED_FILE],
      ]
      for (const [code, file] of relayed) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('import-x/no-restricted-paths')
        expect(report.messages.join('\n'), code).toContain('弹窗（shared/ui/dialog.tsx，Radix Dialog）不经 shared 的其他文件转出')
      }
      expect(await rulesFor(`export { Button } from './button.tsx'\n`, BARREL)).not.toContain('import-x/no-restricted-paths')
    })

    it('shared 的其他文件直接从 radix-ui 引入弹窗原语同样拦下；别的原语与弹窗自己的文件不受影响；用到弹窗的功能模块直接引用它', async () => {
      const BARREL = 'apps/web/src/shared/ui/index.ts'
      const radixDialog = 'import { Dialog } from \'radix-ui\'\n\nexport const Root = Dialog.Root\n'
      expect((await lint(radixDialog, WEB_SHARED_FILE)).messages.join('\n')).toContain('弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入')
      expect((await lint(`export { AlertDialog } from 'radix-ui'\n`, BARREL)).messages.join('\n')).toContain('弹窗类的 Radix 原语')
      expect((await lint('import { Label } from \'radix-ui\'\n\nexport const Root = Label.Root\n', 'apps/web/src/shared/ui/label.tsx')).messages.join('\n')).not.toContain('弹窗类的 Radix 原语')
      expect((await lint(radixDialog, 'apps/web/src/shared/ui/dialog.tsx')).messages.join('\n')).not.toContain('弹窗类的 Radix 原语')
      // 用到弹窗的功能模块（确认的弹窗、按需加载的管理界面）直接引用它
      expect(await rulesFor('import { DialogContent } from \'../../shared/ui/dialog.tsx\'\n\nexport const content = DialogContent\n', 'apps/web/src/features/confirmation/confirm-dialog.tsx')).not.toContain('import-x/no-restricted-paths')
    })
  })

  describe('成员页按需加载；确认的弹窗只由按需加载的功能引用（M2-P2 设计 §3.10）', () => {
    const importConfirm = (path: string): string => `import { ConfirmDialog } from '${path}'\n\nexport const dialog = ConfirmDialog\n`

    it('成员页：只有路由表能动态 import() 它的公开入口', async () => {
      expect(await rulesFor(dynamicImport('../features/members/index.ts'), ROUTES_FILE)).not.toContain('boundaries/dependencies')
      const members: [string, string][] = [
        // 路由表：静态引用、动态引用内部文件
        [`import { MembersPage } from '../features/members/index.ts'\n\nexport const page = MembersPage\n`, ROUTES_FILE],
        [dynamicImport('../features/members/members-page.tsx'), ROUTES_FILE],
        // 应用层的其他文件、功能模块、入口的再导出
        [dynamicImport('../features/members/index.ts'), WEB_FILE],
        [`import type { MembersPage } from '../members/index.ts'\n\nexport type Page = typeof MembersPage\n`, WEB_FEATURE_FILE],
        [`export { MembersPage } from '../../features/members/index.ts'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of members) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain('成员页（features/members）按需加载')
      }
    })

    it('确认的弹窗：按需加载的功能照常引用，首屏的功能、应用层与入口不行；它自己内部的引用不受限（M2-P2 审查 B8）', async () => {
      for (const file of ['apps/web/src/features/admin/users-page.tsx', 'apps/web/src/features/members/members-page.tsx'])
        expect(await rulesFor(importConfirm('../confirmation/index.ts'), file), file).not.toContain('boundaries/dependencies')
      const confirmation: [string, string][] = [
        [importConfirm('../confirmation/index.ts'), WEB_FEATURE_FILE],
        [importConfirm('../confirmation/index.ts'), 'apps/web/src/features/spaces/space-page.tsx'],
        [importConfirm('../features/confirmation/index.ts'), WEB_FILE],
        [importConfirm('../../features/confirmation/index.ts'), PLATFORM_ENTRY],
      ]
      for (const [code, file] of confirmation) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain('确认的弹窗（features/confirmation，带 Radix Dialog）只由按需加载的功能')
      }
      expect(await rulesFor('export { ConfirmDialog } from \'./confirm-dialog.tsx\'\n', 'apps/web/src/features/confirmation/index.ts')).not.toContain('boundaries/dependencies')
    })
  })

  describe('回收站页与搜索结果页按需加载（M2-P4 设计 §3.7）：只有路由表能动态 import() 它们的公开入口', () => {
    const names: Readonly<Record<string, string>> = { trash: '回收站页（features/trash）按需加载', search: '搜索结果页（features/search）按需加载' }
    const pages: Readonly<Record<string, string>> = { trash: 'TrashPage', search: 'SearchPage' }

    it.each(['trash', 'search'])('%s', async (feature) => {
      const page = pages[feature] ?? ''
      expect(await rulesFor(dynamicImport(`../features/${feature}/index.ts`), ROUTES_FILE)).not.toContain('boundaries/dependencies')
      const lazyPages: [string, string][] = [
        // 路由表：静态引用、动态引用内部文件
        [`import { ${page} } from '../features/${feature}/index.ts'\n\nexport const page = ${page}\n`, ROUTES_FILE],
        [dynamicImport(`../features/${feature}/${feature}-page.tsx`), ROUTES_FILE],
        // 应用层的其他文件、功能模块、入口的再导出
        [dynamicImport(`../features/${feature}/index.ts`), WEB_FILE],
        [`import type { ${page} } from '../${feature}/index.ts'\n\nexport type Page = typeof ${page}\n`, WEB_FEATURE_FILE],
        [`export { ${page} } from '../../features/${feature}/index.ts'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of lazyPages) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain(names[feature] ?? '')
      }
    })

    it('回收站页按需加载，所以它可以带确认的弹窗（永久删除要确认）；搜索结果页不带弹窗，引用了照样拦下', async () => {
      const importConfirm = (path: string): string => `import { ConfirmDialog } from '${path}'\n\nexport const dialog = ConfirmDialog\n`
      const importDialog = (path: string): string => `import { DialogContent } from '${path}'\n\nexport const content = DialogContent\n`
      expect(await rulesFor(importConfirm('../confirmation/index.ts'), 'apps/web/src/features/trash/trash-page.tsx')).not.toContain('boundaries/dependencies')
      expect(await rulesFor(importDialog('../../shared/ui/dialog.tsx'), 'apps/web/src/features/trash/trash-page.tsx')).not.toContain('boundaries/dependencies')
      const denied = await lint(importConfirm('../confirmation/index.ts'), 'apps/web/src/features/search/search-page.tsx')
      expect(denied.rules).toContain('boundaries/dependencies')
      expect(denied.messages.join('\n')).toContain('确认的弹窗（features/confirmation，带 Radix Dialog）只由按需加载的功能')
    })
  })

  describe('弹窗的文件（shared/ui/dialog.tsx）与按关键词选一项（features/colleagues）只由按需加载的功能引用（M2-P2 审查 B8）', () => {
    it('弹窗的文件', async () => {
      const importDialog = (path: string): string => `import { DialogContent } from '${path}'\n\nexport const content = DialogContent\n`
      for (const file of ['apps/web/src/features/admin/users-page.tsx', 'apps/web/src/features/members/members-page.tsx', 'apps/web/src/features/confirmation/confirm-dialog.tsx'])
        expect(await rulesFor(importDialog('../../shared/ui/dialog.tsx'), file), file).not.toContain('boundaries/dependencies')
      const dialog: [string, string][] = [
        // 首屏的功能（包括同样按需加载、却不带弹窗的同事选择）、应用层、入口
        [importDialog('../../shared/ui/dialog.tsx'), WEB_FEATURE_FILE],
        [importDialog('../../shared/ui/dialog.tsx'), 'apps/web/src/features/spaces/space-page.tsx'],
        [importDialog('../../shared/ui/dialog.tsx'), 'apps/web/src/features/colleagues/keyword-picker.tsx'],
        [importDialog('../shared/ui/dialog.tsx'), WEB_FILE],
        [`export type { DialogContent } from '../../shared/ui/dialog.tsx'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of dialog) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain('弹窗（shared/ui/dialog.tsx，带 Radix Dialog）只由按需加载的功能')
      }
      // 共享层的其他组件照常引用
      expect(await rulesFor('import { Button } from \'../../shared/ui/index.ts\'\n\nexport const button = Button\n', 'apps/web/src/features/spaces/space-page.tsx')).not.toContain('boundaries/dependencies')
    })

    it('按关键词选一项', async () => {
      const importPicker = (path: string): string => `import { ColleaguePicker } from '${path}'\n\nexport const picker = ColleaguePicker\n`
      for (const file of ['apps/web/src/features/admin/transfer-page.tsx', 'apps/web/src/features/members/members-page.tsx'])
        expect(await rulesFor(importPicker('../colleagues/index.ts'), file), file).not.toContain('boundaries/dependencies')
      // 同事选择自己内部的引用不受限
      expect(await rulesFor(importPicker('./colleague-picker.tsx'), 'apps/web/src/features/colleagues/index.ts')).not.toContain('boundaries/dependencies')
      const colleagues: [string, string][] = [
        [importPicker('../colleagues/index.ts'), WEB_FEATURE_FILE],
        [importPicker('../colleagues/index.ts'), 'apps/web/src/features/spaces/space-page.tsx'],
        [importPicker('../colleagues/index.ts'), 'apps/web/src/features/confirmation/confirm-dialog.tsx'],
        [`import type { KeywordPickerTexts } from '../features/colleagues/index.ts'\n\nexport type Texts = KeywordPickerTexts\n`, WEB_FILE],
        [`export { ColleaguePicker } from '../../features/colleagues/index.ts'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of colleagues) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain('按关键词选一项（features/colleagues）只由按需加载的功能')
      }
    })
  })

  describe('分享对话框与"与我共享"页（M2-P5 设计 §3.5）', () => {
    const SHARE_ENTRY = 'apps/web/src/features/documents/share-entry.tsx'
    const EDITOR_SHARE_ENTRY = 'apps/web/src/features/sheet-editor/share-entry.tsx'
    const importShare = (path: string): string => `import { ShareDialog } from '${path}'\n\nexport const dialog = ShareDialog\n`

    it('分享对话框：平台页面只有文档行操作的入口文件能动态 import() 它的公开入口；编辑器页的页头文件静态引用（另一个包）；别处一律不行', async () => {
      expect(await rulesFor(dynamicImport('../sharing/index.ts'), SHARE_ENTRY)).not.toContain('boundaries/dependencies')
      expect(await rulesFor(importShare('../sharing/index.ts'), EDITOR_SHARE_ENTRY)).not.toContain('boundaries/dependencies')
      const denied: [string, string][] = [
        // 平台页面的入口文件：静态引用（会进首屏）、动态引用内部文件
        [importShare('../sharing/index.ts'), SHARE_ENTRY],
        [`import type { ShareDialogProps } from '../sharing/index.ts'\n\nexport type Props = ShareDialogProps\n`, SHARE_ENTRY],
        [dynamicImport('../sharing/share-dialog.tsx'), SHARE_ENTRY],
        // 编辑器页的页头文件同样只经公开入口
        [importShare('../sharing/share-dialog.tsx'), EDITOR_SHARE_ENTRY],
        // 行操作、编辑器页头的其他文件、别的功能、应用层、入口
        [dynamicImport('../sharing/index.ts'), 'apps/web/src/features/documents/item-actions.tsx'],
        [dynamicImport('../sharing/index.ts'), 'apps/web/src/features/sheet-editor/editor-chrome.tsx'],
        [dynamicImport('../sharing/index.ts'), WEB_FEATURE_FILE],
        [dynamicImport('../features/sharing/index.ts'), ROUTES_FILE],
        [`export { ShareDialog } from '../../features/sharing/index.ts'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of denied) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        if (!code.includes('share-dialog.tsx'))
          expect(report.messages.join('\n'), file).toContain('分享对话框（features/sharing）只由入口所在的两个文件引用')
      }
    })

    it('分享对话框可以带弹窗、确认的弹窗与同事选择（三处白名单）', async () => {
      const imports = [
        'import { DialogContent } from \'../../shared/ui/dialog.tsx\'\n\nexport const content = DialogContent\n',
        'import { ConfirmDialog } from \'../confirmation/index.ts\'\n\nexport const dialog = ConfirmDialog\n',
        'import { ColleaguePicker } from \'../colleagues/index.ts\'\n\nexport const picker = ColleaguePicker\n',
      ]
      for (const code of imports)
        expect(await rulesFor(code, 'apps/web/src/features/sharing/share-dialog.tsx'), code).not.toContain('boundaries/dependencies')
      // "与我共享"页不带弹窗，引用了照样拦下
      expect(await rulesFor(imports[0] ?? '', 'apps/web/src/features/shared-with-me/shared-page.tsx')).toContain('boundaries/dependencies')
    })

    it('"与我共享"页：只有路由表能动态 import() 它的公开入口', async () => {
      expect(await rulesFor(dynamicImport('../features/shared-with-me/index.ts'), ROUTES_FILE)).not.toContain('boundaries/dependencies')
      const denied: [string, string][] = [
        [`import { SharedWithMePage } from '../features/shared-with-me/index.ts'\n\nexport const page = SharedWithMePage\n`, ROUTES_FILE],
        [dynamicImport('../features/shared-with-me/shared-page.tsx'), ROUTES_FILE],
        [dynamicImport('../features/shared-with-me/index.ts'), WEB_FILE],
        [`import type { SharedWithMePage } from '../shared-with-me/index.ts'\n\nexport type Page = typeof SharedWithMePage\n`, WEB_FEATURE_FILE],
        [`export { SharedWithMePage } from '../../features/shared-with-me/index.ts'\n`, PLATFORM_ENTRY],
      ]
      for (const [code, file] of denied) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toContain('"与我共享"页（features/shared-with-me）按需加载')
      }
    })
  })

  describe('只给按需加载的页面与编辑器页用的文案（shared/i18n/zh-cn/<功能>.ts）只由对应的功能引用；测试不受限（M2-P6 复核第二批）', () => {
    const importTexts = (path: string, name: string): string => `import { ${name} } from '${path}'\n\nexport const texts = ${name}\n`
    const TEXTS_MESSAGE = /这份文案（shared\/i18n\/zh-cn\/[\w-]+\.ts）只由按需加载的 features\/[\w-]+ 引用/

    it('对应的功能照常引用', async () => {
      const allowed: [string, string][] = [
        [importTexts('../../shared/i18n/zh-cn/admin.ts', 'adminMessages'), 'apps/web/src/features/admin/users-page.tsx'],
        [importTexts('../../shared/i18n/zh-cn/members.ts', 'membersMessages'), 'apps/web/src/features/members/members-page.tsx'],
        [importTexts('../../shared/i18n/zh-cn/colleagues.ts', 'colleaguesMessages'), 'apps/web/src/features/colleagues/keyword-picker.tsx'],
        [importTexts('../../shared/i18n/zh-cn/trash.ts', 'trashMessages'), 'apps/web/src/features/trash/trash-page.tsx'],
        [importTexts('../../shared/i18n/zh-cn/search.ts', 'searchMessages'), 'apps/web/src/features/search/search-page.tsx'],
        [importTexts('../../shared/i18n/zh-cn/sharing.ts', 'sharingMessages'), 'apps/web/src/features/sharing/share-dialog.tsx'],
        [importTexts('../../shared/i18n/zh-cn/shared-with-me.ts', 'sharedWithMeMessages'), 'apps/web/src/features/shared-with-me/shared-page.tsx'],
        [importTexts('../../shared/i18n/zh-cn/editor.ts', 'editorMessages'), 'apps/web/src/features/sheet-editor/editor-chrome.tsx'],
      ]
      for (const [code, file] of allowed)
        expect(await rulesFor(code, file), `${file}：${code}`).not.toContain('boundaries/dependencies')
    })

    it('测试与测试辅助照常引用（不进产物）；首屏的文案照常由各处引用，拆出去的文件引用首屏的那份也照常', async () => {
      const allowed: [string, string][] = [
        [importTexts('../shared/i18n/zh-cn/admin.ts', 'adminMessages'), WEB_TEST_FILE],
        [importTexts('../shared/i18n/zh-cn/editor.ts', 'editorMessages'), WEB_TEST_SUPPORT],
        [importTexts('../../shared/i18n/index.ts', 'messages'), WEB_FEATURE_FILE],
        [importTexts('./messages.ts', 'messages'), 'apps/web/src/shared/i18n/zh-cn/admin.ts'],
      ]
      for (const [code, file] of allowed)
        expect(await rulesFor(code, file), `${file}：${code}`).not.toContain('boundaries/dependencies')
    })

    it('首屏的功能、别的按需加载的功能、应用层、入口、编辑器适配层引用都失败', async () => {
      const denied: [string, string][] = [
        [importTexts('../../shared/i18n/zh-cn/admin.ts', 'adminMessages'), 'apps/web/src/features/spaces/space-page.tsx'],
        [importTexts('../../shared/i18n/zh-cn/admin.ts', 'adminMessages'), 'apps/web/src/features/members/members-page.tsx'],
        [importTexts('../shared/i18n/zh-cn/members.ts', 'membersMessages'), WEB_FILE],
        [`export type { trashMessages } from '../../shared/i18n/zh-cn/trash.ts'\n`, PLATFORM_ENTRY],
        [importTexts('../../shared/i18n/zh-cn/editor.ts', 'editorMessages'), 'apps/web/src/features/documents/new-sheet-button.tsx'],
        [importTexts('../shared/i18n/zh-cn/editor.ts', 'editorMessages'), 'apps/web/src/editor/sheet-editor.ts'],
        // 分享对话框的文案：入口所在的文件（平台页面的首屏、编辑器页的页头）与"与我共享"页都不行
        [importTexts('../../shared/i18n/zh-cn/sharing.ts', 'sharingMessages'), 'apps/web/src/features/documents/share-entry.tsx'],
        [importTexts('../../shared/i18n/zh-cn/sharing.ts', 'sharingMessages'), 'apps/web/src/features/sheet-editor/share-entry.tsx'],
        [importTexts('../../shared/i18n/zh-cn/sharing.ts', 'sharingMessages'), 'apps/web/src/features/shared-with-me/shared-page.tsx'],
        [importTexts('../shared/i18n/zh-cn/shared-with-me.ts', 'sharedWithMeMessages'), WEB_FILE],
      ]
      for (const [code, file] of denied) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
        expect(report.messages.join('\n'), file).toMatch(TEXTS_MESSAGE)
      }
    })

    it('共享层内部的引用模块边界不检查（同一个元素），改按解析之后的路径拦下：shared/i18n/index.ts 的转出、别的共享文件的中转、弹窗的文件；共享层的测试辅助不受限', async () => {
      const insideShared: [string, string][] = [
        [`export { searchMessages } from './zh-cn/search.ts'\n`, 'apps/web/src/shared/i18n/index.ts'],
        [`export type { adminMessages } from './zh-cn/admin.ts'\n`, 'apps/web/src/shared/i18n/index.ts'],
        [`export { sharingMessages } from './zh-cn/sharing.ts'\n`, 'apps/web/src/shared/i18n/index.ts'],
        [importTexts('../i18n/zh-cn/shared-with-me.ts', 'sharedWithMeMessages'), 'apps/web/src/shared/ui/space-label.tsx'],
        [importTexts('../i18n/zh-cn/colleagues.ts', 'colleaguesMessages'), WEB_SHARED_FILE],
        [importTexts('./trash.ts', 'trashMessages'), 'apps/web/src/shared/i18n/zh-cn/messages.ts'],
        [importTexts('../i18n/zh-cn/members.ts', 'membersMessages'), 'apps/web/src/shared/ui/dialog.tsx'],
      ]
      for (const [code, file] of insideShared) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('import-x/no-restricted-paths')
        expect(report.messages.join('\n'), file).toMatch(TEXTS_MESSAGE)
      }
      expect(await rulesFor(importTexts('../i18n/zh-cn/admin.ts', 'adminMessages'), 'apps/web/src/shared/testing/people.test-support.ts')).not.toContain('import-x/no-restricted-paths')
    })

    it('只给平台页面用的请求层模块不经 shared/api/index.ts 转出（编辑器页也引用这个桶文件）；按路径引用照常', async () => {
      for (const code of [`export { createRequestIdLedger } from './request-ids.ts'\n`, `export type { RequestIdLedger } from './request-ids.ts'\n`, `export { writeFailureText } from './write-outcome.ts'\n`]) {
        const report = await lint(code, 'apps/web/src/shared/api/index.ts')
        expect(report.rules, code).toContain('import-x/no-restricted-paths')
        expect(report.messages.join('\n'), code).toContain('只给平台页面用，不经 shared/api/index.ts 转出')
      }
      expect(await rulesFor('import { createRequestIdLedger } from \'../shared/api/request-ids.ts\'\n\nexport const ledger = createRequestIdLedger\n', WEB_FILE)).not.toContain('import-x/no-restricted-paths')
    })
  })

  it('首屏的限制只管平台页面：编辑器页（它的入口与 sheet-editor）是另一个包，可以引用弹窗、确认的弹窗与同事选择（M2-P2 复验）', async () => {
    const imports = [
      'import { DialogContent } from \'../../shared/ui/dialog.tsx\'\n\nexport const content = DialogContent\n',
      'import { ConfirmDialog } from \'../confirmation/index.ts\'\n\nexport const dialog = ConfirmDialog\n',
      'import { ColleaguePicker } from \'../colleagues/index.ts\'\n\nexport const picker = ColleaguePicker\n',
    ]
    for (const code of imports)
      expect(await rulesFor(code, 'apps/web/src/features/sheet-editor/editor-page.ts'), code).not.toContain('boundaries/dependencies')
    expect((await lintAtProbe(imports[0] ?? '', PROBE_FILES.editorEntry)).rules).not.toContain('boundaries/dependencies')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：弹窗类的 Radix 原语只在 shared/ui/dialog.tsx 里引入（M2-P2 复验）', () => {
  it('命名导入、改名、命名空间导入、export *、动态导入与 @radix-ui/react-dialog 都拦下；其他原语照常', async () => {
    expect(await rulesFor('import { Dialog as DialogPrimitive } from \'radix-ui\'\n\nexport const root = DialogPrimitive.Root\n', 'apps/web/src/shared/ui/dialog.tsx')).not.toContain('no-restricted-syntax')
    // 其他原语照常按名字引入
    expect(await rulesFor('import { Slot } from \'radix-ui\'\n\nexport const slot = Slot\n', 'apps/web/src/features/spaces/space-page.tsx')).not.toContain('no-restricted-syntax')
    const codes = [
      'import { Dialog } from \'radix-ui\'\n\nexport const root = Dialog.Root\n',
      'import { AlertDialog as Alert } from \'radix-ui\'\n\nexport const root = Alert.Root\n',
      'import * as Radix from \'radix-ui\'\n\nexport const root = Radix.Slot\n',
      'export * from \'radix-ui\'\n',
      'export async function load() {\n  return import(\'radix-ui\')\n}\n',
      'import { Root } from \'@radix-ui/react-dialog\'\n\nexport const root = Root\n',
    ]
    for (const code of codes) {
      const report = await lint(code, 'apps/web/src/features/spaces/space-page.tsx')
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(RADIX_DIALOG_MESSAGE)
    }
  })

  it('对 web 的每类文件都生效：功能、应用层、平台页面的入口、共享层、编辑器适配层与内部 API 各有自己的配置块，都带上这组限制', async () => {
    const code = 'import { Dialog } from \'radix-ui\'\n\nexport const root = Dialog.Root\n'
    for (const file of ['apps/web/src/features/spaces/space-page.tsx', WEB_FILE, PLATFORM_ENTRY, WEB_SHARED_FILE, 'apps/web/src/editor/index.ts', 'apps/web/src/editor/internal-api/registry.ts']) {
      const report = await lint(code, file)
      expect(report.rules, file).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), file).toContain(RADIX_DIALOG_MESSAGE)
    }
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：人名经 PersonName 显示，显示名不和登录名、别的文字拼成一段（规范 §2.4，M2-P6 第 6 片复核 S5）', () => {
  const PERSON_NAME_MESSAGE = '人名经 PersonName（shared/ui）显示，纯文字里用 messages.people.text'
  /** 各种拼法：模板字符串、+、JSX 里和文字、字符串、登录名同在一个元素里（显示名在前在后都算） */
  const JOINED = [
    `export function label(user: { displayName: string, username: string }): string {\n  return \`\${user.displayName}（\${user.username}）\`\n}\n`,
    `export function label(displayName: string): string {\n  return \`用户 \${displayName}\`\n}\n`,
    'export function label(user: { displayName: string }): string {\n  return \'用户 \' + user.displayName\n}\n',
    'export function Name({ user }: { user: { displayName: string, username: string } }) {\n  return <span>{user.displayName}（{user.username}）</span>\n}\n',
    'export function Name({ user }: { user: { displayName: string } }) {\n  return <span>用户：{user.displayName}</span>\n}\n',
    'export function Name({ user }: { user: { displayName: string } }) {\n  return <span>{user.displayName}{\'（管理员）\'}</span>\n}\n',
    'export function Name({ displayName, username }: { displayName: string, username: string }) {\n  return <span>{username}{displayName}</span>\n}\n',
  ]

  it.each(['apps/web/src/features/spaces/space-page.tsx', 'apps/web/src/features/admin/users-page.tsx', WEB_FILE])('%s', async (file) => {
    for (const code of JOINED) {
      const report = await lint(code, file)
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(PERSON_NAME_MESSAGE)
    }
  })

  it('入口、弹窗的文件与编辑器同样生效；显示名单独占一个元素（表格里"显示名"那一列、PersonName 自己）照常；测试不受限', async () => {
    const joined = JOINED[0] ?? ''
    for (const file of [PLATFORM_ENTRY, 'apps/web/src/shared/ui/dialog.tsx', 'apps/web/src/editor/sheet-editor.ts'])
      expect((await lint(joined, file)).messages.join('\n'), file).toContain(PERSON_NAME_MESSAGE)
    const alone = 'export function Cell({ user }: { user: { displayName: string } }) {\n  return <td><bdi>{user.displayName}</bdi></td>\n}\n'
    expect((await lint(alone, 'apps/web/src/features/admin/users-page.tsx')).messages.join('\n')).not.toContain(PERSON_NAME_MESSAGE)
    expect((await lint(joined, WEB_TEST_FILE)).messages.join('\n')).not.toContain(PERSON_NAME_MESSAGE)
  })

  it('外面套着不改变值的写法同样认得：可选链、??、条件表达式的一支、非空断言，两层套在一起也算（M2-P6 第 6 片复核第二批 S-2）', async () => {
    const wrapped = [
      `export function label(user?: { displayName: string, username: string }): string {\n  return \`\${user?.displayName}（\${user?.username}）\`\n}\n`,
      `export function label(user: { displayName: string | null }): string {\n  return \`用户 \${user.displayName ?? ''}\`\n}\n`,
      `export function label(user?: { displayName: string }): string {\n  return \`用户 \${user?.displayName ?? ''}\`\n}\n`,
      'export function label(user?: { displayName: string }): string {\n  return \'用户 \' + user?.displayName\n}\n',
      `export function label(me: boolean, user: { displayName: string }): string {\n  return \`\${me ? '我' : user.displayName}：\`\n}\n`,
      'export function Name({ user }: { user?: { displayName: string, username: string } }) {\n  return <span>{user?.displayName}（{user?.username}）</span>\n}\n',
      'export function Name({ user }: { user: { displayName: string | null, username: string } }) {\n  return <span>{user.displayName ?? \'\'}（{user.username}）</span>\n}\n',
      'export function Name({ user }: { user?: { displayName?: string } }) {\n  return <span>用户：{user?.displayName!}</span>\n}\n',
    ]
    for (const code of wrapped)
      expect((await lint(code, 'apps/web/src/features/admin/users-page.tsx')).messages.join('\n'), code).toContain(PERSON_NAME_MESSAGE)
  })

  it('值不是显示名本身的照常：条件表达式的条件、显示名的长度；套着可选链与 ?? 单独占一个元素也照常', async () => {
    const notJoined = [
      `export function label(user: { displayName: string }): string {\n  return \`显示名\${user.displayName ? '已填' : '未填'}\`\n}\n`,
      `export function label(user: { displayName: string }): string {\n  return \`\${user.displayName.length} 个字\`\n}\n`,
      'export function Cell({ user }: { user?: { displayName: string } }) {\n  return <td><bdi>{user?.displayName ?? \'\'}</bdi></td>\n}\n',
    ]
    for (const code of notJoined)
      expect((await lint(code, 'apps/web/src/features/admin/users-page.tsx')).messages.join('\n'), code).not.toContain(PERSON_NAME_MESSAGE)
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：读屏用的状态区（role="status"）不能 display: none 或 invisible，空的时候用 StatusRegion（M2-P5 审查 B 的 M1）', () => {
  const LIVE_STATUS_MESSAGE = '读屏用的状态区（role="status"）要一直在无障碍树里'
  const FEATURE_FILE = 'apps/web/src/features/sharing/share-dialog.tsx'
  /**
   * 几种写法：字符串里的 hidden 与带变体前缀的、cn() 的参数里条件表达式的一支、模板字符串、hidden 属性、style、invisible 与 role={'status'}；
   * cn()、clsx() 的对象写法里键是标识符的 hidden、invisible（含简写），状态区自己带 aria-hidden（M2-P5 复验 G1）
   */
  const HIDING = [
    'export function Notice({ text }: { text: string }) {\n  return <p role="status" className="text-sm empty:hidden">{text}</p>\n}\n',
    'export function Notice({ text }: { text: string }) {\n  return <p role="status" className="hidden">{text}</p>\n}\n',
    'declare function cn(...parts: unknown[]): string\nexport function Notice({ text }: { text?: string }) {\n  return <p role="status" className={cn(\'m-0 text-sm\', text === undefined ? \'hidden\' : \'rounded-lg border p-2\')}>{text}</p>\n}\n',
    `export function Notice({ text }: { text: string }) {\n  return <p role="status" className={\`md:hidden \${text}\`}>{text}</p>\n}\n`,
    'export function Notice({ text }: { text?: string }) {\n  return <p role="status" hidden={text === undefined}>{text}</p>\n}\n',
    'export function Notice({ text }: { text: string }) {\n  return <p role="status" style={{ display: \'none\' }}>{text}</p>\n}\n',
    'export function Notice({ text }: { text: string }) {\n  return <span role={\'status\'} className="!invisible text-sm">{text}</span>\n}\n',
    'declare function cn(...parts: unknown[]): string\nexport function Notice({ text }: { text?: string }) {\n  return <p role="status" className={cn(\'text-sm\', { hidden: text === undefined })}>{text}</p>\n}\n',
    'declare function clsx(...parts: unknown[]): string\nexport function Notice({ text, invisible }: { text: string, invisible: boolean }) {\n  return <p role="status" className={clsx(\'text-sm\', { invisible })}>{text}</p>\n}\n',
    'export function Notice({ text }: { text?: string }) {\n  return <p role="status" aria-hidden={text === undefined}>{text}</p>\n}\n',
    'export function Notice({ text }: { text: string }) {\n  return <span role={\'status\'} aria-hidden="true">{text}</span>\n}\n',
  ]

  it.each([FEATURE_FILE, WEB_FILE, 'apps/web/src/shared/ui/dialog.tsx', PLATFORM_ENTRY])('%s', async (file) => {
    for (const code of HIDING) {
      const report = await lint(code, file)
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(LIVE_STATUS_MESSAGE)
    }
  })

  it('照常的写法：视觉隐藏（sr-only）、overflow-hidden 这类不让元素离开无障碍树的类名、对象写法里别的键与计算出来的键、状态区里面的图标带 aria-hidden、不是状态区的元素、共用的 StatusRegion；测试不受限', async () => {
    const fine = [
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" className="sr-only">{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" className="overflow-hidden text-sm aria-hidden:opacity-0">{text}</p>\n}\n',
      'declare function cn(...parts: unknown[]): string\ndeclare const key: string\nexport function Notice({ text }: { text?: string }) {\n  return <p role="status" className={cn({ hiddenText: text === undefined, \'overflow-hidden\': true, [key]: true })}>{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p role="status"><svg aria-hidden />{text}</p>\n}\n',
      'declare function cn(...parts: unknown[]): string\nexport function Notice({ text, hidden }: { text: string, hidden: boolean }) {\n  return <p className={cn({ hidden })} aria-hidden={hidden}>{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p className="hidden">{text}</p>\n}\n',
      'declare function StatusRegion(props: { className?: string, children?: string }): null\nexport function Notice({ text }: { text: string }) {\n  return <StatusRegion className="mt-2 text-sm">{text}</StatusRegion>\n}\n',
    ]
    for (const code of fine)
      expect((await lint(code, FEATURE_FILE)).messages.join('\n'), code).not.toContain(LIVE_STATUS_MESSAGE)
    expect((await lint(HIDING[0] ?? '', WEB_TEST_FILE)).messages.join('\n')).not.toContain(LIVE_STATUS_MESSAGE)
  })

  it('规则的说明里列出的漏报与误报（M2-P5 复验 G1）：漏报照旧认不出、误报照旧拦下——改了规则让哪一种变了，一并改说明', async () => {
    const missed = [
      'declare const HIDE: string\ndeclare const SHOW: string\nexport function Notice({ text }: { text?: string }) {\n  return <p role="status" className={text === undefined ? HIDE : SHOW}>{text}</p>\n}\n',
      'export function Notice({ text }: { text?: string }) {\n  return <p role="status" style={{ display: text === undefined ? \'none\' : \'block\' }}>{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" style={{ \'display\': \'none\' }}>{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" className="collapse">{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" inert>{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <div aria-live="polite" className="hidden">{text}</div>\n}\n',
      'declare function StatusRegion(props: { className?: string, children?: string }): null\nexport function Notice({ text }: { text: string }) {\n  return <StatusRegion className="hidden md:block">{text}</StatusRegion>\n}\n',
    ]
    for (const code of missed)
      expect((await lint(code, FEATURE_FILE)).messages.join('\n'), code).not.toContain(LIVE_STATUS_MESSAGE)
    const falsePositives = [
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" hidden={false}>{text}</p>\n}\n',
      'export function Notice({ text }: { text: string }) {\n  return <p role="status" aria-hidden={false}>{text}</p>\n}\n',
      'declare function cn(...parts: unknown[]): string\nexport function Notice({ text }: { text: string }) {\n  return <p role="status" className={cn(\'x\', text === \'hidden\' && \'y\')}>{text}</p>\n}\n',
    ]
    for (const code of falsePositives)
      expect((await lint(code, FEATURE_FILE)).messages.join('\n'), code).toContain(LIVE_STATUS_MESSAGE)
  })
}, LINT_TIMEOUT)
