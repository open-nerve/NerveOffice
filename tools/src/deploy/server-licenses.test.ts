import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { missingTexts, readLicenseText, readPackage, renderServerLicenses, serverPackages, uniquePackages } from './server-licenses.ts'

const created: string[] = []

function directory(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'server-licenses-'))
  created.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('US-M1-10 服务端的第三方许可清单（P5 设计 §3.2.1）', () => {
  it('许可文件：LICENSE、LICENCE、COPYING 开头的都收，按文件名排序合并；其他文件不算', () => {
    const dir = directory({ 'LICENSE-MIT': 'MIT text', 'LICENSE-APACHE': 'Apache text', 'README.md': 'readme', 'licenses.json': '{}' })
    expect(readLicenseText(dir)).toBe('Apache text\n\nMIT text')
    expect(readLicenseText(directory({ 'README.md': 'x' }))).toBeNull()
  })

  it('包里没有许可文件时到补充目录里找；许可写成旧格式时记为 Unknown', () => {
    const root = directory({ 'package.json': JSON.stringify({ name: 'no-text', version: '1.0.0', license: { type: 'MIT' } }) })
    const supplement = directory({ 'no-text/LICENSE': 'supplemented' })
    expect(readPackage({ name: 'no-text', version: '1.0.0', path: root }, supplement)).toEqual({ name: 'no-text', version: '1.0.0', license: 'Unknown', text: 'supplemented' })
    expect(readPackage({ name: 'no-text', version: '1.0.0', path: root }, directory({})).text).toBeNull()
  })

  it('同名同版本只列一次，按包名与版本排序；缺正文的列出来', () => {
    const packages = uniquePackages([
      { name: 'b', version: '1.0.0', license: 'MIT', text: 'b' },
      { name: 'a', version: '2.0.0', license: 'MIT', text: null },
      { name: 'b', version: '1.0.0', license: 'MIT', text: 'b' },
      { name: 'a', version: '1.0.0', license: 'ISC', text: 'a' },
    ])
    expect(packages.map(item => `${item.name}@${item.version}`)).toEqual(['a@1.0.0', 'a@2.0.0', 'b@1.0.0'])
    expect(missingTexts(packages)).toEqual(['a@2.0.0'])
  })

  it('只列装上了的包：别的平台的预编译包只在依赖图里，不在镜像里', () => {
    const installed = directory({ 'package.json': JSON.stringify({ name: 'pg', version: '8.23.0', license: 'MIT' }), 'LICENSE': 'MIT text' })
    const graph = {
      installed: [
        { name: 'pg', version: '8.23.0', path: installed },
        { name: '@node-rs/argon2-android-arm-eabi', version: '2.2.1', path: join(installed, 'missing') },
      ],
      unexpanded: [],
    }
    expect(serverPackages(graph, directory({}))).toEqual({ packages: [{ name: 'pg', version: '8.23.0', license: 'MIT', text: 'MIT text' }], notInstalled: 1 })
  })

  it('清单：每个包一节，写明版本与许可', () => {
    const text = renderServerLicenses([{ name: 'pg', version: '8.23.0', license: 'MIT', text: 'The MIT License' }])
    expect(text).toContain('# 第三方许可（服务端）')
    expect(text).toContain('## pg 8.23.0（MIT）\n\nThe MIT License')
  })
})
