import { readFileSync } from 'node:fs'
import { assertSignalPid } from './process-id.ts'

/** 通过校验后才能登记到清理数组；Number() 的宽松输入不能成为信号目标。 */
export function readReadyPid(path: string): number {
  const text = readFileSync(path, 'utf8')
  const pid = Number(text)
  // 合法范围内的 String(pid) 必定是无空白、符号、前导零的十进制文本。
  if (text !== String(pid))
    throw new RangeError('PID 就绪标记必须是规范十进制文本')
  assertSignalPid(pid)
  return pid
}

/** path 属于本轮唯一、单写者 marker；同目录写完 staging 后才发布就绪。 */
export function pidReadyScript(path: string): string {
  return `;(() => {
    const fs = require('node:fs');
    const staging = ${JSON.stringify(`${path}.staging`)};
    fs.writeFileSync(staging, String(process.pid), { flag: 'wx' });
    fs.renameSync(staging, ${JSON.stringify(path)});
  })();`
}
