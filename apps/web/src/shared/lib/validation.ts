import type { z } from 'zod'

/**
 * 校验结果里给用户看的说明：第一条不满足的规则（契约的结构按"先基本、后具体"的顺序写规则，第一条最贴切，
 * 例如整个名字都看不见时说"只有看不见的字符"，而不是"不能包含看不见的字符"）；通过时为空
 */
export function problemOf(result: z.ZodSafeParseResult<unknown>): string | undefined {
  return result.success ? undefined : result.error.issues[0]?.message
}
