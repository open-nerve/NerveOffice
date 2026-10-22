import { parseArgs } from 'node:util'
import { z } from 'zod'
import { isDocumentUpgradeTarget } from '../modules/documents/index.ts'
import { UsageError } from './init-admin-arguments.ts'

export const DOCUMENT_CHECKPOINT_USAGE = [
  '用法：document-checkpoints prepare --target <版本标识>',
  '      document-checkpoints resume --batch <UUID> [--batch-size <1..100>]',
  '      document-checkpoints status [--batch <UUID>]',
  '      document-checkpoints release --batch <UUID>',
  '      document-checkpoints abort --batch <UUID>',
  'prepare 冻结源写入；中断不会解冻，resume 接续；ready 仍冻结，明确 release 或 abort 才解除。',
].join('\n')

export type DocumentCheckpointArguments
  = | { readonly action: 'prepare', readonly target: string }
    | { readonly action: 'resume', readonly batch: string, readonly batchSize: number }
    | { readonly action: 'status', readonly batch?: string }
    | { readonly action: 'release' | 'abort', readonly batch: string }

export function parseDocumentCheckpointArguments(argv: readonly string[]): DocumentCheckpointArguments {
  const action = argv[0]
  if (action !== 'prepare' && action !== 'resume' && action !== 'status' && action !== 'release' && action !== 'abort')
    throw new UsageError('参数不合法：须指定 prepare、resume、status、release 或 abort')
  let values: { 'target'?: string, 'batch'?: string, 'batch-size'?: string }
  try {
    const parsed = parseArgs({ args: argv.slice(1), options: { 'target': { type: 'string' }, 'batch': { type: 'string' }, 'batch-size': { type: 'string' } }, strict: true, allowPositionals: false, tokens: true })
    const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name)
    const allowed = action === 'prepare' ? ['target'] : action === 'resume' ? ['batch', 'batch-size'] : ['batch']
    if (new Set(names).size !== names.length || names.some(name => !allowed.includes(name)))
      throw new Error('duplicate or unrelated option')
    values = parsed.values
  }
  catch {
    throw new UsageError('参数不合法：选项不认识、重复或不属于这个命令')
  }
  if (action === 'prepare') {
    if (values.target === undefined || !isDocumentUpgradeTarget(values.target))
      throw new UsageError('参数不合法：--target 须为 1–128 个 ASCII 标识字符')
    return { action, target: values.target }
  }
  if (action === 'status' && values.batch === undefined)
    return { action }
  if (values.batch === undefined || !z.uuid().safeParse(values.batch).success)
    throw new UsageError('参数不合法：须提供 --batch <UUID>')
  if (action === 'resume') {
    const raw = values['batch-size'] ?? '20'
    const size = Number(raw)
    if (!Number.isInteger(size) || size < 1 || size > 100 || String(size) !== raw)
      throw new UsageError('参数不合法：--batch-size 须为 1–100 的整数')
    return { action, batch: values.batch.toLowerCase(), batchSize: size }
  }
  return { action, batch: values.batch.toLowerCase() }
}
