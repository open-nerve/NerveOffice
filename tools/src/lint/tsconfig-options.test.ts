// TypeScript 的编译选项（规范 §2.1【自动】，M2-P6 第 6 片复核 S4）：strict、noUncheckedIndexedAccess、noImplicitOverride、
// noFallthroughCasesInSwitch 与 skipLibCheck 写在 tsconfig.base.json 里，各工程继承它。原来没有检查：哪个工程的 tsconfig 关掉
// strict（或者不再继承基础配置），类型检查照常通过，只是检查得少了。这里对根目录与每个工作区包里的每份 tsconfig*.json 取
// tsc --showConfig 的结果（解析过 extends 之后真正生效的选项）逐项核对；只列出子工程的"解决方案"式配置（files 为空、只有
// references）核对它引用的子工程都在被检查之列。用根目录的 TypeScript（pnpm typecheck 第一步用的同一份）。
// strict 为真时，它管着的那一组检查（strictNullChecks 等）单独写成 false 照样关掉，只核对 strict 本身会放过：这一组逐项核对没有
// 写成 false（复核第二批 S-4）
import { readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { commandText, readWorkspaceConfig, REPO_ROOT, workspacePackageDirs } from '../shared/repo.ts'

const TSC = join(REPO_ROOT, 'node_modules/typescript/bin/tsc')
const REQUIRED_OPTIONS = ['strict', 'noUncheckedIndexedAccess', 'noImplicitOverride', 'noFallthroughCasesInSwitch', 'skipLibCheck'] as const

/**
 * strict 管着的那一组检查：tsc --all 的说明里默认值写成"true，除非 strict 为 false"的布尔选项，随 TypeScript 的版本取，不手抄
 * （升级之后多出来的一并核对）。alwaysStrict 在 TypeScript 6 改为默认打开、不再随 strict，写成 false 同样关掉严格模式，一并核对
 */
function strictFamily(): string[] {
  const help = commandText(process.execPath, [TSC, '--all'])
  // 每个选项一段（空行隔开）：名字（可能带简写）、说明（一行或几行）、类型、默认值；说明的行不以 - 开头、不是空行，匹配不会跨到下一段
  const option = /^--(\w+)(?:, -\w+)?\n(?:[^\n-][^\n]*\n)*?type: boolean\ndefault: `true`, unless `strict` is `false`$/gm
  return [...[...help.matchAll(option)].map(match => match[1] ?? ''), 'alwaysStrict']
}

const STRICT_FAMILY = strictFamily()

const shownConfigSchema = z.object({
  compilerOptions: z.record(z.string(), z.unknown()).default({}),
  files: z.array(z.string()).optional(),
  include: z.array(z.string()).optional(),
  references: z.array(z.object({ path: z.string() })).optional(),
})

/** 根目录与各工作区包里的 tsconfig*.json（相对仓库根目录）；基础配置本身不是工程（各工程继承它，核对的是继承之后的结果） */
function tsconfigFiles(): string[] {
  const dirs = ['.', ...workspacePackageDirs(readWorkspaceConfig())]
  return dirs.flatMap(dir => readdirSync(join(REPO_ROOT, dir)).filter(name => /^tsconfig(?:\.[\w-]+)?\.json$/.test(name) && name !== 'tsconfig.base.json').map(name => posix.join(dir, name)))
}

const files = tsconfigFiles()

describe('US-M1-11 TypeScript 的编译选项（规范 §2.1）', () => {
  it('找得到各工程的 tsconfig：根目录、apps、packages、tests 与 tools 都在', () => {
    expect(files).toEqual(expect.arrayContaining(['tsconfig.json', 'apps/api/tsconfig.json', 'apps/web/tsconfig.app.json', 'packages/contracts/tsconfig.json', 'tests/e2e/tsconfig.json', 'tests/integration/tsconfig.json', 'tools/tsconfig.json']))
  })

  it('认得出 strict 管着的那一组检查（tsc --all 的说明改了写法、一项也认不出时，这里先失败）', () => {
    expect(STRICT_FAMILY).toEqual(expect.arrayContaining(['noImplicitAny', 'noImplicitThis', 'strictBindCallApply', 'strictFunctionTypes', 'strictNullChecks', 'strictPropertyInitialization', 'useUnknownInCatchVariables', 'alwaysStrict']))
  })

  it.each(files)('%s', (file) => {
    const shown = shownConfigSchema.parse(JSON.parse(commandText(process.execPath, [TSC, '--showConfig', '-p', file])))
    if (shown.references !== undefined && (shown.files?.length ?? 0) === 0 && shown.include === undefined) {
      // 解决方案式的配置：自己不检查文件，引用的子工程都要在被检查之列
      for (const reference of shown.references)
        expect(files, file).toContain(posix.join(dirname(file), reference.path))
      return
    }
    for (const option of REQUIRED_OPTIONS)
      expect(shown.compilerOptions[option], `${file}：${option}`).toBe(true)
    // 解析之后的配置只列出写过的选项：这一组没写时随 strict 打开，写成 false 就单独关掉了
    for (const option of STRICT_FAMILY)
      expect(shown.compilerOptions[option], `${file}：${option} 不能单独关掉`).not.toBe(false)
  })
})
