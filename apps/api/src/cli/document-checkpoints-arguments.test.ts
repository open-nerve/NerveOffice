import { describe, expect, it } from 'vitest'
import { parseDocumentCheckpointArguments } from './document-checkpoints-arguments.ts'
import { UsageError } from './init-admin-arguments.ts'

const ID = '11111111-1111-4111-8111-111111111111'
describe('升级检查点命令参数', () => {
  it('五种命令各自只接受相关选项，默认批量为 20', () => {
    expect(parseDocumentCheckpointArguments(['prepare', '--target', 'univer@next:0.21/rc-1'])).toEqual({ action: 'prepare', target: 'univer@next:0.21/rc-1' })
    expect(parseDocumentCheckpointArguments(['resume', '--batch', ID])).toEqual({ action: 'resume', batch: ID, batchSize: 20 })
    expect(parseDocumentCheckpointArguments(['resume', '--batch', ID, '--batch-size', '100'])).toEqual({ action: 'resume', batch: ID, batchSize: 100 })
    expect(parseDocumentCheckpointArguments(['status'])).toEqual({ action: 'status' })
    expect(parseDocumentCheckpointArguments(['status', '--batch', ID])).toEqual({ action: 'status', batch: ID })
    for (const action of ['release', 'abort'] as const)
      expect(parseDocumentCheckpointArguments([action, '--batch', ID])).toEqual({ action, batch: ID })
  })

  it.each([
    [],
    ['unknown'],
    ['prepare'],
    ['prepare', '--target', 'x', '--batch', ID],
    ['status', '--batch-size', '1'],
    ['resume', '--target', 'x'],
    ['release'],
    ['abort', '--batch', 'bad'],
    ['resume', '--batch', ID, '--batch-size', '0'],
    ['resume', '--batch', ID, '--batch-size', '101'],
    ['resume', '--batch', ID, '--batch-size', '1.5'],
    ['resume', '--batch', ID, '--batch-size', '1e2'],
    ['resume', '--batch', ID, '--batch-size', '100\n'],
    ['prepare', '--target', 'a', '--target', 'b'],
    ['status', '--batch', ID, '--batch', ID],
    ['prepare', '--target', 'a\n'],
    ['prepare', '--target', '中文'],
    ['prepare', '--target', '-bad'],
    ['prepare', '--target', 'x'.repeat(129)],
    ['prepare', '--target', 'x', 'trailing'],
  ].map(args => ({ args })))('拒绝不完整、混合或重复参数 $args', ({ args }) => {
    expect(() => parseDocumentCheckpointArguments(args)).toThrow(UsageError)
  })

  it('用法错误不回显误传的正文、连接串或其他参数', () => {
    expect(() => parseDocumentCheckpointArguments(['status', '--raw-secret-token'])).toThrow('参数不合法')
    try {
      parseDocumentCheckpointArguments(['prepare', '--target', 'postgresql://secret@host/\n'])
    }
    catch (error) {
      expect(String(error)).not.toContain('secret')
    }
  })
})
