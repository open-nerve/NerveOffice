// commit-msg 钩子：node tools/src/git/commit-msg.ts <提交说明文件>
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { stripAiTrailers } from './strip-ai-trailers.ts'

/** git 的注释符：core.commentString 优先，其次 core.commentChar（auto 时按默认），都没设时是 #。 */
function gitCommentPrefix(): string {
  for (const key of ['core.commentString', 'core.commentChar']) {
    try {
      const value = execFileSync('git', ['config', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (value !== '' && value !== 'auto')
        return value
    }
    catch {
      // 没有设置这一项时 git 以非 0 退出，继续看下一项
    }
  }
  return '#'
}

const file = process.argv[2]
if (file === undefined) {
  console.error('用法：node tools/src/git/commit-msg.ts <提交说明文件>')
  process.exit(2)
}

const original = readFileSync(file, 'utf8')
const cleaned = stripAiTrailers(original, gitCommentPrefix())
if (cleaned !== original) {
  writeFileSync(file, cleaned)
  console.log('已从提交说明中去掉 AI 署名')
}
