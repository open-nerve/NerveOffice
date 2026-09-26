// 测试用：读取 tools/fixtures/ 下保存的真实工具输出。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../shared/repo.ts'

export function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'tools/fixtures', path), 'utf8'))
}
