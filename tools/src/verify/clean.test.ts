import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanBuildOutputs } from './clean.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined)
    rmSync(root, { recursive: true, force: true })
})

describe('cleanBuildOutputs', () => {
  it('删除 apps/* 与 packages/* 下的 dist，保留其他文件', () => {
    root = mkdtempSync(join(tmpdir(), 'nerve-clean-'))
    for (const dir of ['apps/web/dist/assets', 'packages/contracts/dist', 'apps/web/src', 'tools/dist'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'apps/web/dist/assets/a.js'), 'x')
    writeFileSync(join(root, 'apps/web/src/main.tsx'), 'x')

    expect(cleanBuildOutputs(root).sort()).toEqual(['apps/web/dist', 'packages/contracts/dist'])
    expect(existsSync(join(root, 'apps/web/dist'))).toBe(false)
    expect(existsSync(join(root, 'packages/contracts/dist'))).toBe(false)
    expect(existsSync(join(root, 'apps/web/src/main.tsx'))).toBe(true)
    expect(existsSync(join(root, 'tools/dist'))).toBe(true)
  })
})
