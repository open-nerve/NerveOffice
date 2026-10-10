// E2E 的测试库名（environment.ts）：nerve_e2e_<主机标识>_<进程号>。服务脚本清理中断的运行留下的库时只认本主机建的、按本主机的进程号判断
// （tests/shared/test-databases.ts，那边测判断本身；这里核对两边接得上）
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { abandonedNames, hostTag } from '../../shared/test-databases.ts'
import { E2E_DATABASE_PREFIX, e2eDatabaseName } from './environment.ts'

describe('E2E 的测试库名（e2eDatabaseName）', () => {
  it('nerve_e2e_<主机标识>_<进程号>；服务脚本清理时认得出：本主机建的、进程已经不在的才删', () => {
    expect(e2eDatabaseName(42)).toBe(`nerve_e2e_${hostTag()}_42`)
    expect(abandonedNames([e2eDatabaseName(process.pid), e2eDatabaseName(99_999_999)], { prefix: E2E_DATABASE_PREFIX })).toEqual([e2eDatabaseName(99_999_999)])
  })
})
