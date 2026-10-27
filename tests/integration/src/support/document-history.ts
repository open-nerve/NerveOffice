import type { TestApp } from './api-app.ts'
import { TransactionRunner } from '@nerve-office/api'
import { DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'

/** 测试从真实存储入口采样；调用者可替换数据库时钟来布置保留期。 */
export async function captureHistory(app: TestApp, documentId: string): Promise<string> {
  return app.runtime.get(TransactionRunner).run(async (transaction) => {
    await app.runtime.get(DocumentsRepository).lockById(documentId, transaction)
    const id = await app.runtime.get(DocumentCheckpointService).captureHourly(documentId, transaction)
    if (id === undefined)
      throw new Error('测试的小时已被占用，没有新增历史')
    return id
  })
}
