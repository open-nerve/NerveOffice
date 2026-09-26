// CSP 阳性对照（P3 设计 §3.9，US-M1-09）：只在测试构建里（vite build --mode e2e），生产构建没有这个入口。
// 尝试三件违反定稿 CSP 的事：向另一个源发请求、eval、new Function。策略生效时三件都被拦下。
export type Outcome = 'allowed' | 'blocked'

export interface ProbeResult {
  readonly fetch: Outcome
  readonly eval: Outcome
  readonly function: Outcome
}

async function attempt(action: () => unknown): Promise<Outcome> {
  try {
    await action()
    return 'allowed'
  }
  catch {
    return 'blocked'
  }
}

export async function runProbe(target: string): Promise<ProbeResult> {
  return {
    fetch: await attempt(async () => {
      const response = await fetch(target, { mode: 'cors', cache: 'no-store' })
      if (!response.ok)
        throw new Error(`目标返回 ${response.status}`)
    }),
    // eslint-disable-next-line no-eval -- 阳性对照：就是要试 eval 能否执行
    eval: await attempt(() => (0, eval)('1 + 1')),
    // eslint-disable-next-line no-new-func, ts/no-implied-eval, ts/no-unsafe-call -- 阳性对照：就是要试 new Function 能否执行
    function: await attempt(() => new Function('return 1')()),
  }
}
