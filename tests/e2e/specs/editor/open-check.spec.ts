// 打开自检无误报（M3-P4 设计 §3.11、§3.17）：误报会让一份文档谁也编辑不了。新建的模板、只读样本（六项内容资源都非空，五张表、图片、
// 批注、筛选、条件格式、数据验证、定义名称）与大表，打开（阅读）与进入编辑时编辑器的打开自检都通过——经测试构建的探针读出结果。
// 这是资源守卫的登记里写的回归用例之一（internal-api/registry.ts 的 createResourceLoadGuard）：SDK 升级改了资源 hook 的注册时机、名字或
// 加载路径时，这组先失败。US-M3-15 的页面级用例（失败之后只能阅读、页头的说明、上报、先取后放）在 S5 补进这个文件。
// 用到探针（只在测试构建里）：标签 @test-build，外部模式测生产镜像时按标签排除
import type { SnapshotFor } from '../../support/database.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { createDocument, createUser } from '../../support/database.ts'
import { probeOpenCheck } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { largeSheetFor } from '../../support/large-sheet.ts'
import { readOnlySampleFor } from '../../support/read-only-sample.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, enterEditing, openReader } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const DOCUMENTS: readonly (readonly [name: string, snapshotFor: SnapshotFor])[] = [
  ['新建的模板', sheetSnapshotFor],
  ['只读样本', readOnlySampleFor],
  ['大表', largeSheetFor],
]

test.describe('打开自检无误报：模板、只读样本与大表', { tag: '@test-build' }, () => {
  for (const [name, snapshotFor] of DOCUMENTS) {
    test(`US-M3-15 ${name}：打开（阅读）与进入编辑时，打开自检都通过`, async ({ page }) => {
      const owner = await createUser('open-check')
      const id = await createDocument(owner, `打开自检 ${name}`, snapshotFor)
      await loginThroughApi(page, owner)
      await openReader(page, id)
      expect(await probeOpenCheck(page)).toEqual({ ok: true })
      // 模式切换一律重建：可编辑的编辑器另做一次自检
      await enterEditing(page)
      expect(await probeOpenCheck(page)).toEqual({ ok: true })
    })
  }
})
