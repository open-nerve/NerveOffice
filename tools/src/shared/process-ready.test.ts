import { spawnSync } from 'node:child_process'
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { pidReadyScript, readReadyPid } from './process-ready.test-support.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function marker(name = 'ready.pid'): string {
  const directory = mkdtempSync(join(tmpdir(), 'nerve-pid-ready-'))
  directories.push(directory)
  return join(directory, name)
}

// 只在实际文件写入的 open/write 之间插入观察；发布脚本和 rename 使用夹具本身的实现。
function publish(path: string, fileSystem: Pick<typeof fs, 'writeFileSync' | 'renameSync'>): void {
  runInNewContext(pidReadyScript(path), {
    process: { pid: 4242 },
    require: (name: string) => {
      if (name !== 'node:fs')
        throw new Error(`unexpected module: ${name}`)
      return fileSystem
    },
  })
}

describe('PID 就绪文件的严格读取', () => {
  it.each(['', ' ', '\n', '\t', '0', '-0', '1', '-2', '+2', '02', ' 2', '2 ', '2\n', '2.0', '2e3', '0x10', 'NaN', 'Infinity', '2147483648', '4294967298', '2x', '2\0', '２'])('拒绝非规范或越界文本 %j', (text) => {
    const path = marker()
    writeFileSync(path, text)
    expect(() => readReadyPid(path)).toThrow(RangeError)
  })

  it.each([
    { text: '2', pid: 2 },
    { text: '4242', pid: 4242 },
    { text: '2147483647', pid: 2147483647 },
  ])('完整十进制 $text 读为合法 PID', ({ text, pid }) => {
    const path = marker()
    writeFileSync(path, text)
    expect(readReadyPid(path)).toBe(pid)
  })

  it('缺失文件保留 I/O 失败，不产生清理 PID', () => {
    expect(() => readReadyPid(marker())).toThrow(/ENOENT/)
  })
})

describe('PID 就绪脚本的原子发布', () => {
  it('打开空 staging 及写完内容时正式 marker 都不可见，rename 后只留下完整 PID', () => {
    const path = marker()
    const observations: { body: string, ready: boolean, directory: string }[] = []
    publish(path, {
      writeFileSync: (file, data) => {
        if (typeof file !== 'string')
          throw new Error('expected a file path')
        const fd = fs.openSync(file, 'wx')
        try {
          observations.push({ body: readFileSync(file, 'utf8'), ready: existsSync(path), directory: dirname(file) })
          writeFileSync(fd, data)
          observations.push({ body: readFileSync(file, 'utf8'), ready: existsSync(path), directory: dirname(file) })
        }
        finally { fs.closeSync(fd) }
      },
      renameSync: fs.renameSync,
    })
    expect(observations).toEqual([
      { body: '', ready: false, directory: dirname(path) },
      { body: '4242', ready: false, directory: dirname(path) },
    ])
    expect(readReadyPid(path)).toBe(4242)
    expect(readdirSync(dirname(path))).toEqual(['ready.pid'])
  })

  it('写到一半失败时不发布 marker，残留仅留在本轮目录等待清理', () => {
    const path = marker()
    const failure = new Error('synthetic partial write')
    expect(() => publish(path, {
      writeFileSync: (file) => {
        writeFileSync(file, '4')
        throw failure
      },
      renameSync: fs.renameSync,
    })).toThrow(failure)
    expect(existsSync(path)).toBe(false)
    const files = readdirSync(dirname(path))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dirname(path), files[0]!), 'utf8')).toBe('4')
  })

  it('真实 CommonJS 子进程发布自己的 PID，路径中的引号和换行不变成代码', () => {
    const path = marker('ready "quoted" \' \\ \n $`; .pid')
    const child = spawnSync(process.execPath, ['-e', pidReadyScript(path)], { timeout: 2000, encoding: 'utf8' })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stderr).toBe('')
    expect(readReadyPid(path)).toBe(child.pid)
    expect(readdirSync(dirname(path))).toHaveLength(1)
  })

  it('与前后没有分号的相邻语句按换行拼接时仍独立执行', () => {
    const path = marker()
    const code = [
      'process.on("SIGINT", () => {})',
      pidReadyScript(path),
      '(() => process.stdout.write("after"))()',
    ].join('\n')
    const child = spawnSync(process.execPath, ['-e', code], { timeout: 2000, encoding: 'utf8' })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stderr).toBe('')
    expect(child.stdout).toBe('after')
    expect(readReadyPid(path)).toBe(child.pid)
  })
})
