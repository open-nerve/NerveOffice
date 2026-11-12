// 测试专用诊断的落档（关闭阶段记录器与协议记录共用）：每个 attempt 独占创建一个报告文件，每次整份重写之前核对父目录与原文件的身份；
// 已有文件、链接、替换成 FIFO 等身份变化都拒绝，写入时不阻塞，避免诊断反过来挂住原调用。
import type { TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/**
 * 独占创建 testInfo.outputPath(name)（0600）并立即登记附件，返回整份重写的写入函数。
 * 创建失败、超过 maxBytes、父目录或原文件的身份变化、写入不完整都抛错；调用者只登记固定原因，不透出错误正文。
 */
export function createExclusiveReport(testInfo: TestInfo, name: string, maxBytes: number, attachment: string): (text: string) => void {
  const path = testInfo.outputPath(name)
  if (!isAbsolute(path) || basename(path) !== name)
    throw new Error('invalid-output')
  const root = realpathSync(testInfo.project.outputDir)
  const parent = realpathSync(dirname(path))
  const inside = relative(root, parent)
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
    throw new Error('outside-output')
  const parentIdentity = lstatSync(parent)
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink())
    throw new Error('invalid-parent')
  const target = join(parent, name)
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let identity
  try {
    identity = fstatSync(fd)
    // 登记早于首条记录；不调用 attach(path) 提前复制一个尚未完成的快照。
    testInfo.attachments.push({ name: attachment, path, contentType: 'application/json' })
  }
  finally { closeSync(fd) }
  let size = 0
  return (text) => {
    const bytes = Buffer.from(text)
    if (bytes.length > maxBytes)
      throw new Error('byte-limit')
    const parentNow = lstatSync(parent)
    if (parentNow.dev !== parentIdentity.dev || parentNow.ino !== parentIdentity.ino || !parentNow.isDirectory())
      throw new Error('parent-changed')
    // 替换成无 reader 的 FIFO 时也不能在 fstat 前阻塞，避免诊断反过来挂住原调用。
    const output = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const now = fstatSync(output)
      if (!now.isFile() || now.nlink !== 1 || now.dev !== identity.dev || now.ino !== identity.ino || now.size !== size)
        throw new Error('file-changed')
      ftruncateSync(output, 0)
      if (writeSync(output, bytes) !== bytes.length)
        throw new Error('partial-write')
      fsyncSync(output)
      size = bytes.length
    }
    finally { closeSync(output) }
  }
}
