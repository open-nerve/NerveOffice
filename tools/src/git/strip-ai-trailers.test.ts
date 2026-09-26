import { describe, expect, it } from 'vitest'
import { stripAiTrailers } from './strip-ai-trailers.ts'

describe('stripAiTrailers', () => {
  it('去掉 Claude 的 Co-Authored-By 与 Claude Code 水印，保留正文', () => {
    const message = [
      'feat: 新增登录接口',
      '',
      '说明第一行',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      '',
      'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>',
      '',
    ].join('\n')
    expect(stripAiTrailers(message)).toBe('feat: 新增登录接口\n\n说明第一行\n')
  })

  it.each([
    'Co-authored-by: Claude <noreply@anthropic.com>',
    'co-authored-by: GitHub Copilot <copilot@github.com>',
    'Co-Authored-By: OpenAI Codex <codex@openai.com>',
    'Co-Authored-By: ChatGPT <noreply@openai.com>',
    'Co-Authored-By: Gemini <gemini@google.com>',
    'Co-Authored-By: Cursor Agent <cursoragent@cursor.com>',
    'Co-Authored-By: someone <noreply@anthropic.com>',
  ])('去掉 AI 署名：%s', (trailer) => {
    expect(stripAiTrailers(`fix: 修正\n\n${trailer}\n`)).toBe('fix: 修正\n')
  })

  it('保留人类合作者', () => {
    const message = 'fix: 修正\n\nCo-Authored-By: 张三 <zhangsan@example.com>\n'
    expect(stripAiTrailers(message)).toBe(message)
  })

  it('保留 git 的注释行，并且只在末尾保留一个换行', () => {
    const message = 'docs: 更新\n\n# 请输入提交说明\n\n\n'
    expect(stripAiTrailers(message)).toBe('docs: 更新\n\n# 请输入提交说明\n')
  })

  it('正文里提到 Claude 的普通句子不受影响', () => {
    const message = 'docs: 记录 Claude 相关的约定\n\n说明 Co-Authored-By 规则\n'
    expect(stripAiTrailers(message)).toBe(message)
  })
})
