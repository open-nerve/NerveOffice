import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientBuild, clientBuildOf } from './client-build.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const ROOT_VERSION = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version

describe('页面的构建版本（M3-P3 设计 §3.5）', () => {
  it('取仓库根目录 package.json 的 version（x.y.z）；没有提交号时只有它', () => {
    expect(ROOT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(clientBuild(ROOT, {})).toBe(ROOT_VERSION)
  })

  it('镜像构建传进的提交号附在 + 之后（前 12 位、小写，去掉首尾空白）', () => {
    expect(clientBuild(ROOT, { CLIENT_BUILD_REVISION: 'abc1234' })).toBe(`${ROOT_VERSION}+abc1234`)
    expect(clientBuildOf('0.1.0', ' 0123456789ABCDEF0123456789abcdef01234567 ')).toBe('0.1.0+0123456789ab')
  })

  it.each([
    ['没有传', undefined],
    ['空串', ''],
    ['Dockerfile 的默认值', 'unknown'],
    ['太短', 'abc123'],
    ['带后缀', 'abc1234-dirty'],
    ['太长', 'a'.repeat(41)],
  ])('提交号写法不对（%s）时不附', (_case, revision) => {
    expect(clientBuildOf('0.1.0', revision)).toBe('0.1.0')
  })
})
