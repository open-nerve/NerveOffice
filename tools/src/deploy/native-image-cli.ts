// 构建时收集；输出必须是全新目录。验证模式完全离线。
import { resolve } from 'node:path'
import process from 'node:process'
import { REPO_ROOT } from '../shared/repo.ts'
import { bundleNativeImages, verifyNativeImageBundle } from './native-image-bundle.ts'
import { loadNativeMaterials } from './native-image-materials.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const receipt = args.length === 2 && args[0] === '--verify' && args[1] !== undefined
    ? await verifyNativeImageBundle(resolve(args[1]))
    : args.length === 4 && args[0] === '--out' && args[1] !== undefined && args[2] === '--cache' && args[3] !== undefined
      ? await bundleNativeImages(loadNativeMaterials(REPO_ROOT), { output: resolve(args[1]), cache: resolve(args[3]) })
      : undefined
  if (receipt === undefined)
    throw new Error('用法：node tools/src/deploy/native-image-cli.ts --out <全新目录> --cache <缓存目录>；离线复核：--verify <成品目录>')
  console.log(JSON.stringify({ sharp: receipt.sharp, sharpLibvips: receipt.sharpLibvips, libvips: receipt.libvips, sourceFiles: receipt.sourceFiles, sourceBytes: receipt.sourceBytes, distributedFiles: receipt.files.length, verified: true }))
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '原生材料收集或校验失败')
  process.exitCode = 1
})
