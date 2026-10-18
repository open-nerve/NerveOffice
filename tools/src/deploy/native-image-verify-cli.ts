// 此入口与所需模块编译后随镜像交付；不依赖仓库路径、pnpm、构建环境或网络。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { verifyNativeImageBundle } from './native-image-bundle.ts'
import { materialFilePath, sourceManifestSchema } from './native-image-materials.ts'
import { verifyInstalledNativeImages } from './native-image-runtime.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--bundle' || args[1] === undefined || args[2] !== '--api-package' || args[3] === undefined)
    throw new Error('用法：--bundle <材料目录> --api-package <API 的 package.json>')
  const root = resolve(args[1])
  const receipt = await verifyNativeImageBundle(root)
  const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(materialFilePath(root, 'sources.json'), 'utf8')))
  const versions = verifyInstalledNativeImages(resolve(args[3]), manifest)
  console.log(JSON.stringify({ ...versions, sourceFiles: receipt.sourceFiles, sourceBytes: receipt.sourceBytes, distributedFiles: receipt.files.length, verified: true }))
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '运行镜像原生图片材料校验失败')
  process.exitCode = 1
})
