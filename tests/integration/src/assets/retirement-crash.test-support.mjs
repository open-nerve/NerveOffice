// 使用正式构建的应用、GC 与真实文件；只在原子 rename 的边界暂停，由父测试 SIGKILL。
import fs from 'node:fs/promises'
import process from 'node:process'
import { AssetGcJob, createApplication, loadServerConfig } from '@nerve-office/api'

async function main() {
  const timer = setTimeout(() => process.exit(2), 15_000)
  process.on('disconnect', () => process.exit(1))
  const runtime = await createApplication(loadServerConfig(process.env))
  const rename = fs.rename
  fs.rename = async (source, target) => {
    if (process.argv[2] === 'after-rename')
      await rename(source, target)
    process.send?.({ stage: process.argv[2] })
    await new Promise(() => {})
  }
  await runtime.get(AssetGcJob).runOnce(new Date())
  clearTimeout(timer)
  process.exit(3)
}
void main()
