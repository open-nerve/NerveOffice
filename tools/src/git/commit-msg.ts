// commit-msg 钩子：node tools/src/git/commit-msg.ts <提交说明文件>
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { stripAiTrailers } from './strip-ai-trailers.ts'

const file = process.argv[2]
if (file === undefined) {
  console.error('用法：node tools/src/git/commit-msg.ts <提交说明文件>')
  process.exit(2)
}

const original = readFileSync(file, 'utf8')
const cleaned = stripAiTrailers(original)
if (cleaned !== original) {
  writeFileSync(file, cleaned)
  console.log('已从提交说明中去掉 AI 署名')
}
