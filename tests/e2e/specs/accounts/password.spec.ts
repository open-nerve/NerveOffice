// 修改密码（M2-P1，US-M2-02）：改完之后其他地方的登录被退出、这里保持登录；旧密码不对时的提示。
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'

const NEW_PASSWORD = 'a brand new password'

test.describe('US-M2-02 修改密码', () => {
  test('改完之后另一台设备被要求重新登录，这里保持登录；新密码能登录，旧密码不能', async ({ page, anotherDevice }) => {
    const user = await createUser('pw-change', '改密码的人')
    await loginThroughApi(anotherDevice, user)
    await anotherDevice.goto('/')
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await loginThroughApi(page, user)
    await page.goto('/')
    await page.getByRole('link', { name: '修改密码' }).click()
    await expect(page).toHaveURL(/\/settings\/password$/)
    await page.getByLabel('当前密码').fill(user.password)
    await page.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: '修改密码' }).click()
    await expect(page.getByText('密码已修改。你在其他设备上的登录已经退出。')).toBeVisible()

    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await anotherDevice.reload()
    await expect(anotherDevice).toHaveURL(/\/login/)
    await expect(anotherDevice.getByText('登录已过期，请重新登录')).toBeVisible()
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')
    await loginThroughUi(anotherDevice, { username: user.username, password: NEW_PASSWORD })
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('当前密码不对：提示，密码不变', async ({ page }) => {
    const user = await createUser('pw-wrong')
    await loginThroughApi(page, user)
    await page.goto('/settings/password')
    await page.getByLabel('当前密码').fill('not my password')
    await page.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: '修改密码' }).click()
    await expect(page.getByRole('alert')).toHaveText('当前密码不正确')
    const login = await page.request.post('/api/auth/login', { data: { username: user.username, password: user.password }, headers: { origin: new URL(page.url()).origin } })
    expect(login.status()).toBe(200)
  })
})
