// 本机模式下服务脚本与测试之间的控制文件（P5 设计 §3.6）：服务脚本每次启动后端都写入自己与后端的进程号，
// 重启用例（US-M1-10）据此向服务脚本发 SIGUSR2，并确认后端已经换成了新的进程。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 在 Playwright 的输出目录里：它在启动服务之前清空这个目录，不会读到上一次运行的 */
const CONTROL_FILE = fileURLToPath(new URL('../test-results/e2e-server.json', import.meta.url))

export interface ServerControl {
  /** 服务脚本的进程号：向它发 SIGUSR2 */
  readonly serverPid: number
  /** 当前后端的进程号 */
  readonly apiPid: number
}

/** 先写临时文件再改名：读的一方不会读到写了一半的内容 */
export function writeServerControl(control: ServerControl): void {
  const temporary = `${CONTROL_FILE}.tmp`
  writeFileSync(temporary, JSON.stringify(control))
  renameSync(temporary, CONTROL_FILE)
}

export function readServerControl(): ServerControl {
  return JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) as ServerControl
}
