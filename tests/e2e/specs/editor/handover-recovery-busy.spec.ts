// 三个浏览器都使用真实镜像，严格验证正文交接与 MirrorBusy 的先后关系。
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { handoverRecovery } from '../../support/handover-recovery.ts'
import { cellOf, EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

for (const ordering of ['before', 'after'] as const) {
  test(`US-M4-06 旧页正文读回与新页恢复观察交错 ${ordering}：一次编辑接上 A1，旧页副本仍保留自己的正文`, async ({ page, context }, testInfo) => {
    const owner = await createUser(`recovery-busy-${ordering}`)
    const { cloud, copy } = await handoverRecovery({ page, context, owner, ordering, mirrored: true }, testInfo)
    expect([cellOf(cloud, 'A1')?.v, cellOf(cloud, 'B1')?.v]).toEqual(['旧页已经落盘的 A1', '新页的 B1'])
    expect([cellOf(copy, 'A1')?.v, cellOf(copy, 'B1')]).toEqual(['旧页已经落盘的 A1', undefined])
  })
}
