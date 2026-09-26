// 用法：node tools/src/verify/clean-cli.ts（pnpm clean）
import { REPO_ROOT } from '../shared/repo.ts'
import { cleanBuildOutputs } from './clean.ts'

const removed = cleanBuildOutputs(REPO_ROOT)
console.log(removed.length === 0 ? '没有需要删除的构建产物' : `已删除：${removed.join('、')}`)
