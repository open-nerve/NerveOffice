// 提交说明中不得出现 AI 署名（用户级约定与规范 §12）：commit-msg 钩子用它清理提交说明。
// 只处理说明末尾的署名段（git trailer 与"Generated with …"水印），正文里举例写的同样格式的行不动；
// 判断 AI 署名看专用邮箱，或者整个名字就是 AI 产品名，所以名叫 Claude、Devin 的人不会被误删。

const TRAILER = /^[A-Z][\w-]*\s*:\s*(\S.*)$/i
const AI_EMAIL = /<[^>]*@(?:anthropic\.com|openai\.com|cursor\.com|codeium\.com|devin\.ai|aider\.chat)>|<(?:copilot@github\.com|[^>]*\bcopilot@users\.noreply\.github\.com)>/i
const AI_NAME = /^(?:claude(?:\s+(?:code|opus|sonnet|haiku|fable|instant)\b.*)?|anthropic(?:\s.*)?|chatgpt(?:\s.*)?|openai(?:\s.*)?|(?:github\s+)?copilot|codex|openai\s+codex|gemini(?:\s+(?:code|cli|pro|flash|ultra)\b.*)?|cursor(?:\s*agent)?|devin(?:\s+ai)?|aider(?:\s+ai)?)$/i
const WATERMARK = /^(?:🤖\s*)?generated\s+(?:with|by)\s+\[?(?:claude(?:\s+code)?|copilot|cursor|codex|chatgpt|gemini)\b/i

function isAiTrailer(line: string): boolean {
  const match = TRAILER.exec(line.trim())
  if (match === null)
    return false
  const value = match[1] ?? ''
  const name = value.split('<')[0]?.trim() ?? ''
  return AI_EMAIL.test(value) || AI_NAME.test(name)
}

function isAttributionLine(line: string): boolean {
  return TRAILER.test(line.trim()) || WATERMARK.test(line.trim())
}

function isAiAttribution(line: string): boolean {
  return isAiTrailer(line) || WATERMARK.test(line.trim())
}

/**
 * 去掉末尾署名段里的 AI 署名，并把末尾的空行收成一个换行；git 的注释行原样保留在最后。
 * `git commit -v` 在提交说明后面附上剪刀线与 diff：有剪刀线时只处理它之前的部分，剪刀线与 diff 原样保留（git 提交时会丢掉它们）。
 * commentPrefix 是 git 的注释符（core.commentString 或 core.commentChar，默认 #）。
 */
export function stripAiTrailers(message: string, commentPrefix = '#'): string {
  const all = message.split('\n')
  const scissorsLine = `${commentPrefix} ------------------------ >8 ------------------------`
  const scissors = all.findIndex(line => line === scissorsLine)
  if (scissors >= 0)
    return `${stripMessage(all.slice(0, scissors), commentPrefix)}${all.slice(scissors).join('\n')}`
  return stripMessage(all, commentPrefix)
}

function stripMessage(lines: string[], commentPrefix: string): string {
  const trailingComments: string[] = []
  while (lines.length > 0 && (lines.at(-1)?.trim() === '' || lines.at(-1)?.startsWith(commentPrefix) === true)) {
    const line = lines.pop() ?? ''
    if (line.startsWith(commentPrefix))
      trailingComments.unshift(line)
  }

  // 从最后一段往前：整段都是署名行时，去掉其中的 AI 署名；去掉后整段空了，就继续看前一段
  let end = lines.length
  while (end > 0) {
    let start = end
    while (start > 0 && lines[start - 1]?.trim() !== '')
      start--
    const paragraph = lines.slice(start, end)
    if (paragraph.length === 0 || !paragraph.every(isAttributionLine))
      break
    const kept = paragraph.filter(line => !isAiAttribution(line))
    lines.splice(start, end - start, ...kept)
    if (kept.length > 0)
      break
    end = start
    while (end > 0 && lines[end - 1]?.trim() === '')
      end--
    lines.splice(end)
  }

  while (lines.length > 0 && lines.at(-1)?.trim() === '')
    lines.pop()
  const body = lines.join('\n')
  return trailingComments.length > 0 ? `${body}\n\n${trailingComments.join('\n')}\n` : `${body}\n`
}
