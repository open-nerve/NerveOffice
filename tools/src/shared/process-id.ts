/** 仅校验信号参数；合法数字不代表本轮拥有该进程或进程组。 */
export function assertSignalPid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 2 || pid > 2147483647)
    throw new RangeError('PID 必须是 2–2147483647 范围内的整数')
}
