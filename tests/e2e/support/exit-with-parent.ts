// 由 serve.ts 用 --import 加载进 E2E 的后端进程（后端的代码不为测试改动）。
// 后端单独一个进程组，Playwright 发给服务脚本进程组的信号（包括超时之后的 SIGKILL）碰不到它。
// 服务脚本被强制结束时来不及停止后端；这时后端标准输入的另一端（由服务脚本持有）随之关闭：
// 给自己发 SIGTERM，走后端正常的优雅退出，端口与数据库连接都会释放，不留下孤儿进程。
import process from 'node:process'

process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'))
process.stdin.resume()
