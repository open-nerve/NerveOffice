// 应用在一段时间里对某个库发出的全部语句（只记语句文本，不记参数，M2-P6 复核 S2）："看不到"与"不存在"执行同样的查询，
// 集成测试据此逐条比较两者的语句序列——语句相同，执行路径就相同，耗时没有可以分辨的差别。
// 做法：在测试进程里替换 pg.Client.prototype.query（应用与测试在同一个进程里运行，用的是同一个 pg 模块），
// 只记应用自己连这个库的连接（application_name 是应用的连接池的名字）：测试自己建数据、查数据的连接不算。
import pg from 'pg'

/** 应用的连接池的 application_name（apps/api 的 database 模块） */
const APPLICATION_NAME = 'nerve-office-api'

interface ClientWithParameters {
  readonly connectionParameters?: { readonly database?: string, readonly application_name?: string }
}

/** 语句文本：query(text, …) 与 query({ text, … }) 两种写法 */
function textOf(first: unknown): string {
  if (typeof first === 'string')
    return first
  if (typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string')
    return first.text
  return '<无法识别的语句>'
}

/** 只折叠空白：参数占位符本来就与取值无关 */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export interface StatementCapture {
  /** 执行 fn，返回它的结果与期间应用对这个库发出的语句（按顺序） */
  readonly during: <T>(fn: () => Promise<T>) => Promise<{ readonly result: T, readonly statements: string[] }>
  /** 还原 pg.Client.prototype.query（afterAll 里调用） */
  readonly restore: () => void
}

export function captureStatements(databaseName: string): StatementCapture {
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }
  const original = prototype.query
  let log: string[] | undefined
  prototype.query = function query(this: ClientWithParameters, ...args: unknown[]): unknown {
    const parameters = this.connectionParameters
    if (log !== undefined && parameters?.database === databaseName && parameters.application_name === APPLICATION_NAME)
      log.push(normalized(textOf(args[0])))
    return original.apply(this, args)
  }
  return {
    during: async (fn) => {
      log = []
      try {
        const result = await fn()
        // 响应发出之后不应再有这个请求的语句；让出一轮事件循环，万一有也记下来
        await new Promise(resolve => setImmediate(resolve))
        return { result, statements: log }
      }
      finally {
        log = undefined
      }
    },
    restore: () => {
      prototype.query = original
    },
  }
}
