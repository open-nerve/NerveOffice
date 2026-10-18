import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { verifyPrivateAssetRoot } from './asset-deployment.ts'

try {
  if (process.platform !== 'linux')
    throw new Error('此检查必须在正式 Linux 镜像内执行')
  // 固定工具和参数，无 shell；确认实际二进制可运行，而非仅有文件名。
  const limit = execFileSync('/usr/bin/prlimit', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  const root = process.env.NERVE_ASSET_ROOT ?? ''
  const result = verifyPrivateAssetRoot(root, process.env.NERVE_WEB_ROOT ?? '')
  console.log(JSON.stringify({ root, ...result, limit, verified: true }))
}
catch (error) {
  console.error(error instanceof Error ? error.message : '私有资源部署检查失败')
  process.exitCode = 1
}
