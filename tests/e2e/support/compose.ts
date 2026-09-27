// 外部模式下经 docker compose 操作被测环境（容器 E2E，P5 设计 §3.6）：编排的项目、文件与变量文件由编排脚本
// （pnpm test:e2e:container）经环境变量给出。
import { spawnSync } from 'node:child_process'
import process from 'node:process'

function composeArgs(): string[] {
  const project = process.env.E2E_COMPOSE_PROJECT
  const file = process.env.E2E_COMPOSE_FILE
  const envFile = process.env.E2E_COMPOSE_ENV_FILE
  if (project === undefined || file === undefined || envFile === undefined)
    throw new Error('要经 pnpm test:e2e:container 运行：它给出编排的 E2E_COMPOSE_PROJECT、E2E_COMPOSE_FILE、E2E_COMPOSE_ENV_FILE')
  return ['compose', '-p', project, '-f', file, '--env-file', envFile]
}

/** 执行 docker compose 的一个命令（input 交给它的标准输入），返回标准输出；失败时报错 */
export function compose(args: readonly string[], input?: string): string {
  const result = spawnSync('docker', [...composeArgs(), ...args], { encoding: 'utf8', input })
  if (result.status !== 0)
    throw new Error(`docker compose ${args.join(' ')} 失败（退出码 ${String(result.status)}）：${result.stderr}`)
  return result.stdout
}
