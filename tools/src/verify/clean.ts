// 构建前删除旧的产物：构建步骤如果没有真正执行，后面的产物检查不能拿旧产物蒙混过关。
import { globSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 删除 apps/* 与 packages/* 下的 dist 目录，返回删除了哪些（相对 root）。 */
export function cleanBuildOutputs(root: string): string[] {
  const outputs = globSync(['apps/*/dist', 'packages/*/dist'], { cwd: root })
  for (const dir of outputs)
    rmSync(join(root, dir), { recursive: true, force: true })
  return outputs
}
