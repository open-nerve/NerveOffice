// 默认 WebKit 临时上下文没有 OPFS；此处严格验证同一正文交接的无镜像对照，真实镜像交错在 mirror.spec.ts。
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { handoverRecovery } from '../../support/handover-recovery.ts'
import { cellOf, EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

for (const ordering of ['before', 'after'] as const) {
  test(`US-M4-06 旧页正文读回与新页恢复观察交错 ${ordering}：一次编辑接上 A1，旧页副本仍保留自己的正文`, async ({ page, context, browserName }, testInfo) => {
    const owner = await createUser(`recovery-busy-${ordering}`)
    const { cloud, copy } = await handoverRecovery({ page, context, owner, ordering, mirrored: browserName !== 'webkit' }, testInfo)
    expect([cellOf(cloud, 'A1')?.v, cellOf(cloud, 'B1')?.v]).toEqual(['旧页已经落盘的 A1', '新页的 B1'])
    expect([cellOf(copy, 'A1')?.v, cellOf(copy, 'B1')]).toEqual(['旧页已经落盘的 A1', undefined])
  })
}
