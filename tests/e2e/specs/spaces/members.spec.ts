// 成员与空间角色（M2-P2，US-M2-06）：空间管理员在成员页按名字搜索同事并添加、调整角色、移出；
// 被移出的人已打开的页面里，再进这个空间就看不到它（不显示缓存里的旧内容），导航里它随之消失。
// 要移出的人已经被别人移出时，确认框关掉、焦点交还之后才在表格上方说明，写进去的那一刻读屏读得到（M2-P5 复验 S1，support/status-writes.ts）。
import type { Locator, Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { createTeamSpace, createUser, removeMember } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { plainName, shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { expectWrittenAfterClose, recordStatusWrites } from '../../support/status-writes.ts'

function spaceNav(page: Page) {
  return page.getByRole('navigation', { name: '空间' })
}

test.describe('US-M2-06 管理成员与空间角色', () => {
  test('空间管理员添加同事、调整角色、移出；对方随即按新的角色看到这个空间，移出之后已打开的页面里再进来就看不到', async ({ page, anotherDevice }) => {
    const admin = await createUser('mb-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-lead', '空间管理员')
    const colleague = await createUser('mb-colleague', '新成员')
    const space = await createTeamSpace('项目组', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}`)
    await page.getByRole('link', { name: '成员', exact: true }).click()
    await expect(page.getByRole('heading', { name: `${space.name} 的成员` })).toBeVisible()

    // 添加：按名字搜索（这里用登录名：它全库唯一），选角色
    await page.getByLabel('要添加的同事').fill(colleague.username)
    await page.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: shownName(colleague), exact: true }).click()
    await page.getByLabel('角色', { exact: true }).selectOption({ label: '编辑者' })
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    const role = page.getByRole('combobox', { name: `${plainName(colleague)} 的角色` })
    await expect(role).toHaveValue('editor')

    await loginThroughApi(anotherDevice, colleague)
    await anotherDevice.goto('/')
    await spaceNav(anotherDevice).getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('我的角色：编辑者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toBeVisible()

    // 调整为查看者：选好之后点"保存"才提交（M2-P6 复核的疑点：收起的选择框上按方向键会逐个改值），对方重新打开就只能查看
    await role.selectOption({ label: '查看者' })
    await page.getByRole('button', { name: `保存 ${plainName(colleague)} 的角色`, exact: true }).click()
    await expect(role).toHaveValue('viewer')
    await expect(page.getByRole('row').filter({ hasText: shownName(colleague) })).toHaveAttribute('aria-busy', 'false')
    await anotherDevice.reload()
    await expect(anotherDevice.getByText('我的角色：查看者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toHaveCount(0)

    // 移出：先确认
    await page.getByRole('button', { name: `移出 ${plainName(colleague)}`, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '移出', exact: true }).click()
    await expect(page.getByRole('combobox', { name: `${plainName(colleague)} 的角色` })).toHaveCount(0)

    // 对方已打开的页面（单页，不整页加载）：先到我的空间，再点导航里这个空间（缓存里还有它的页头与文档）。
    // 重新请求得到 404：说明看不到，不显示旧的内容；导航随之刷新，这个空间的链接消失（审查 B1）
    const nav = spaceNav(anotherDevice)
    await nav.getByRole('link', { name: '我的空间', exact: true }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
    await nav.getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('空间不存在，或者你没有访问权限')).toBeVisible()
    await expect(anotherDevice.getByText('我的角色：查看者')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: space.name })).toHaveCount(0)
  })

  test('选人：显示名写成"李四（登录名）"冒充别人的，与真正的李四分得清——登录名在单独的元素里、等宽、与显示名同样醒目；选中与成员表里一样（M2-P6 复核 M2，第三批 S-d）', async ({ page }) => {
    const admin = await createUser('mb-pick-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-pick-lead', '空间管理员')
    const tag = randomBytes(3).toString('hex')
    const real = await createUser(`lisi${tag}`, `李四${tag}`)
    const spoof = await createUser(`mallory${tag}`, `李四${tag}（${real.username}）`)
    const space = await createTeamSpace('选人', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await page.getByLabel('要添加的同事').fill(`李四${tag}`)
    const candidates = page.getByRole('list', { name: '找到的同事' })
    await expect(candidates.getByRole('button')).toHaveCount(2)
    const realButton = candidates.getByRole('button', { name: shownName(real), exact: true })
    const spoofButton = candidates.getByRole('button', { name: shownName(spoof), exact: true })
    // 每个候选里：显示名在 <bdi> 里（冒充者显示名里的"（登录名）"只是显示名的一部分），登录名在另一个元素里
    await expect(realButton.locator('bdi')).toHaveText(real.displayName)
    await expect(realButton.locator('[data-slot="person-username"]')).toHaveText(`@${real.username}`)
    await expect(spoofButton.locator('bdi')).toHaveText(spoof.displayName)
    await expect(spoofButton.locator('[data-slot="person-username"]')).toHaveText(`@${spoof.username}`)
    // 登录名用等宽字体与显示名区分；与显示名同样醒目——颜色、字号、粗细都相同（需求方 2026-10-02 的决定，M2-P6 复核第三批 S-d：
    // 原来登录名灰色、小一号，冒充者那一行里最醒目的反倒是可以伪造的显示名）
    const styles = await spoofButton.locator('[data-slot="person-username"]').evaluate((username) => {
      const name = username.parentElement?.querySelector('bdi')
      const own = getComputedStyle(username)
      const shown = name === null || name === undefined ? undefined : getComputedStyle(name)
      return {
        login: { font: own.fontFamily, color: own.color, size: own.fontSize, weight: own.fontWeight },
        name: { font: shown?.fontFamily, color: shown?.color, size: shown?.fontSize, weight: shown?.fontWeight },
      }
    })
    expect(styles.login.font).toMatch(/mono/i)
    expect(styles.login.font).not.toBe(styles.name.font)
    expect(styles.login.color).toBe(styles.name.color)
    expect(styles.login.size).toBe(styles.name.size)
    expect(styles.login.weight).toBe(styles.name.weight)

    // 选中冒充者：已选的标签里同样分得清；添加之后成员表里也一样
    await spoofButton.click()
    await expect(page.getByText(`已选择：${shownName(spoof)}`)).toBeVisible()
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    const table = page.getByRole('table', { name: '成员列表' })
    const row = table.getByRole('row').filter({ hasText: `@${spoof.username}` })
    await expect(row).toHaveCount(1)
    await expect(row.locator('bdi')).toHaveText(spoof.displayName)
    await expect(row.locator('[data-slot="person-username"]')).toHaveText(`@${spoof.username}`)
    await expect(table.getByRole('row').filter({ hasText: `@${real.username}` })).toHaveCount(0)
  })

  test('选人：显示名写成"李四 @登录名"冒充别人的，候选的可读名称与确认框的标题都是登录名在前，从开头就分得清（M2-P6 复核第二批 M-1）', async ({ page }) => {
    const admin = await createUser('mb-at-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-at-lead', '空间管理员')
    const tag = randomBytes(3).toString('hex')
    const real = await createUser(`lisi${tag}`, `李四${tag}`)
    const spoof = await createUser(`eve${tag}`, `李四${tag} @${real.username}`)
    const space = await createTeamSpace('冒充', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await page.getByLabel('要添加的同事').fill(real.username)
    const candidates = page.getByRole('list', { name: '找到的同事' })
    await expect(candidates.getByRole('button')).toHaveCount(2)
    // 读屏读出的候选：登录名在前。原来显示名在前时两个候选的开头相同（"李四… @lisi…"与"李四… @lisi… @eve…"）
    const names = (await candidates.getByRole('button').allTextContents()).toSorted()
    expect(names).toEqual([shownName(spoof), shownName(real)].toSorted())
    expect(names.filter(name => name.startsWith(`@${real.username} `))).toEqual([shownName(real)])
    await expect(candidates.getByRole('button', { name: shownName(spoof), exact: true })).toHaveAccessibleName(new RegExp(`^@${spoof.username} `))

    // 把冒充者加进来，再打开移出的确认框：标题同样登录名在前
    await candidates.getByRole('button', { name: shownName(spoof), exact: true }).click()
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    await page.getByRole('button', { name: `移出 ${plainName(spoof)}`, exact: true }).click()
    await expect(page.getByRole('dialog', { name: `把 ${plainName(spoof)} 移出这个空间？` })).toBeVisible()
    expect(plainName(spoof).startsWith(`@${spoof.username} `)).toBe(true)
  })

  test('要移出的人已经被别人移出：确认框关掉之后才在表格上方说明（写进去的那一刻读屏读得到），那一行随之消失（M2-P5 复验 S1）', async ({ page }) => {
    const admin = await createUser('mb-gone-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-gone-lead', '空间管理员')
    const member = await createUser('mb-gone-member', '成员')
    const space = await createTeamSpace('已被移出', admin, [[lead, 'admin'], [member, 'viewer']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await expect(page.getByRole('combobox', { name: `${plainName(member)} 的角色` })).toBeVisible()
    // 表格上方的状态区一直在（空的时候只做视觉隐藏）：记下它每一次内容变化的那一刻
    await recordStatusWrites(page.locator('[data-slot="status-region"]'))

    // 别人先把他移出了（直接改库），这一页还显示着他
    await removeMember(space.id, member)
    await page.getByRole('button', { name: `移出 ${plainName(member)}`, exact: true }).click()
    const confirm = page.getByRole('dialog', { name: `把 ${plainName(member)} 移出这个空间？` })
    await confirm.getByRole('button', { name: '移出', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    const text = `${shownName(member)} 已经不在成员里了（可能已被别人移出），列表已刷新`
    await expect(page.getByRole('status').filter({ hasText: '已经不在成员里了' })).toHaveText(text)
    // 确认框开着时 Radix 把页面标为 aria-hidden：说明等它关掉、焦点交还之后才写，写进去的那一刻读屏读得到。原来与关掉在同一次渲染里写：
    // 那一刻 aria-hidden 已经撤销，焦点却还在 body 上（交还焦点在后面），读屏能否播报说不准（M2-P5 复验 S1）
    await expectWrittenAfterClose(page, text)
    await expect(page.getByRole('combobox', { name: `${plainName(member)} 的角色` })).toHaveCount(0)
  })

  test('只有空间管理员能管理：编辑者打开成员页只能查看', async ({ page }) => {
    const admin = await createUser('mb-ro-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-ro-lead', '空间管理员')
    const editor = await createUser('mb-ro-editor', '编辑者')
    const space = await createTeamSpace('只读成员页', admin, [[lead, 'admin'], [editor, 'editor']])
    await loginThroughApi(page, editor)
    await page.goto(`/spaces/${space.id}/members`)
    await expect(page.getByText('只有空间管理员能添加、调整与移出成员。')).toBeVisible()
    await expect(page.getByRole('table', { name: '成员列表' }).getByText(shownName(lead))).toBeVisible()
    await expect(page.getByLabel('要添加的同事')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^移出 / })).toHaveCount(0)
  })

  test('窄屏：显示名到了上限、登录名最长时，同事选择的候选与已选都在表单之内换行，不撑出页面；可读名称仍是全名（M2-P6 复核第四批）', async ({ page }) => {
    const admin = await createUser('mb-narrow-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-narrow-lead', '空间管理员')
    // 登录名 32 个字符（上限：前缀 23 个，加上随机的后缀 9 个）；显示名 64 个字符（上限），后半是一个没有空格的长单词
    const longest = await createUser('n'.repeat(23), `${'很长的显示名'.repeat(5)}Supercalifragilisticexpialidocious`)
    expect(longest.username).toHaveLength(32)
    expect([...longest.displayName]).toHaveLength(64)
    const space = await createTeamSpace('窄屏', admin, [[lead, 'admin']])
    await page.setViewportSize({ width: 320, height: 800 })
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await page.getByLabel('要添加的同事').fill(longest.username)
    const form = page.locator('form').filter({ has: page.getByLabel('要添加的同事') })

    // 候选：按钮的可读名称是全名（登录名在前），换行之后仍在表单之内
    const candidate = page.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: shownName(longest), exact: true })
    await expect(candidate).toBeVisible()
    await expectInside(page, form, candidate, '候选')
    // 选中之后的标签同样
    await candidate.click()
    const chosen = form.getByText('已选择：')
    await expect(chosen).toContainText(shownName(longest))
    await expectInside(page, form, chosen, '已选')
  })
})

/** 这一处在容器之内（左右都不出界），页面没有横向溢出（窄屏的用例，视口 320px 宽） */
async function expectInside(page: Page, container: Locator, part: Locator, what: string): Promise<void> {
  const box = await part.boundingBox()
  const outer = await container.boundingBox()
  if (box === null || outer === null)
    throw new Error(`${what} 或者它的容器没有出现`)
  expect(box.x, `${what} 左边出界`).toBeGreaterThanOrEqual(outer.x - 0.5)
  expect(box.x + box.width, `${what} 撑出了容器`).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${what}：页面横向溢出`).toBeLessThanOrEqual(320)
}
