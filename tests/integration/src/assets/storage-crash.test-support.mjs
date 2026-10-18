// 真实 API 组装、配额、处理与文件写入；只在 link 的边界暂停，由测试 SIGKILL。
import fs from 'node:fs/promises'
import process from 'node:process'
import { AssetUploadService, createApplication, loadServerConfig } from '@nerve-office/api'

async function main() {
  const timer = setTimeout(() => process.exit(2), 15_000)
  process.on('disconnect', () => process.exit(1))
  const runtime = await createApplication(loadServerConfig(process.env))
  const data = await fs.readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
  const link = fs.link
  fs.link = async (source, target) => {
    if (process.argv[3] === 'after-link')
      await link(source, target)
    process.send?.({ stage: process.argv[3] })
    await new Promise(() => {})
  }
  await runtime.get(AssetUploadService).upload({ userId: process.argv[2], sessionId: process.argv[4] }, async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
  clearTimeout(timer)
  process.exit(3)
}
void main()
