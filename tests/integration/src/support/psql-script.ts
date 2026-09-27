// 按 psql 的规则执行部署用的 SQL 脚本（deploy/sql/）：本机与 CI 的集成测试环境不一定装了 psql。
// 只支持脚本里实际用到的几样：-v 传入的变量、\getenv、\connect、\set ON_ERROR_STOP on（这里本来就出错即停），
// :"变量"（标识符）与 :'变量'（字面量）的替换，独占一行的注释，以分号结尾的语句逐条执行。遇到别的写法时报错，不静默跳过；
// 真正的 psql 在测试环境的数据库初始化里执行（deploy/test，容器 E2E 覆盖）。
import pg from 'pg'

export interface PsqlScriptOptions {
  /** 开始时连接的库；\connect 换库时沿用其中的用户与密码 */
  readonly connectionString: string
  /** psql 的 -v 变量 */
  readonly variables: Readonly<Record<string, string>>
  /** \getenv 读的环境变量 */
  readonly env: Readonly<Record<string, string>>
}

const VARIABLE = /:"(\w+)"|:'(\w+)'/g

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  return url.toString()
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 })
  await client.connect()
  return client
}

export async function runPsqlScript(script: string, options: PsqlScriptOptions): Promise<void> {
  const variables = new Map(Object.entries(options.variables))
  const valueOf = (name: string): string => {
    const value = variables.get(name)
    if (value === undefined)
      throw new Error(`psql 变量没有定义：${name}`)
    return value
  }
  const substitute = (text: string): string => text.replaceAll(VARIABLE, (_match, identifier: string | undefined, literal: string | undefined) =>
    identifier === undefined ? pg.escapeLiteral(valueOf(literal ?? '')) : pg.escapeIdentifier(valueOf(identifier)))

  let client = await connect(options.connectionString)
  try {
    let statement = ''
    for (const line of script.split('\n')) {
      const text = line.trim()
      if (text === '' || text.startsWith('--'))
        continue
      if (text.startsWith('\\')) {
        const [command, ...args] = text.split(/\s+/)
        if (command === '\\set' && args.join(' ') === 'ON_ERROR_STOP on') {
          // 出错即停：这里的每条语句出错都会抛出
        }
        else if (command === '\\getenv' && args.length === 2) {
          const value = options.env[args[1] ?? '']
          if (value !== undefined)
            variables.set(args[0] ?? '', value)
        }
        else if (command === '\\connect' && args.length === 1 && /^:"\w+"$/.test(args[0] ?? '')) {
          await client.end()
          client = await connect(withDatabase(options.connectionString, valueOf((args[0] ?? '').slice(2, -1))))
        }
        else {
          throw new Error(`不支持的 psql 元命令：${text}`)
        }
        continue
      }
      statement += `${line}\n`
      if (text.endsWith(';')) {
        // 先替换再执行：密码里的分号、引号不影响语句的切分
        await client.query(substitute(statement))
        statement = ''
      }
    }
    if (statement !== '')
      throw new Error(`脚本结尾的语句没有以分号结束：${statement}`)
  }
  finally {
    await client.end()
  }
}
