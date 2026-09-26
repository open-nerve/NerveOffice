// 提交说明中不得出现 AI 署名（用户级约定与规范 §12）：commit-msg 钩子用它清理提交说明。

/** AI 助手的名称或专用邮箱；人类合作者的署名不受影响。 */
const AI_ASSISTANT = /\b(?:claude|anthropic|copilot|codex|chatgpt|openai|gpt-?\d|gemini|cursor(?:agent)?|aider|devin)\b/i
const CO_AUTHORED_BY = /^co-authored-by:/i
const GENERATED_WITH = /^(?:🤖\s*)?generated with \[?claude code\]?/i

function isAiAttribution(line: string): boolean {
  const text = line.trim()
  if (CO_AUTHORED_BY.test(text))
    return AI_ASSISTANT.test(text)
  return GENERATED_WITH.test(text)
}

/** 去掉 AI 署名行，并把末尾的空行收成一个换行。 */
export function stripAiTrailers(message: string): string {
  const kept = message.split('\n').filter(line => !isAiAttribution(line))
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '')
    kept.pop()
  return `${kept.join('\n')}\n`
}
