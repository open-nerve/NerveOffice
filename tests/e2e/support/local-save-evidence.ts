import type { Buffer } from 'node:buffer'
import type { LocalSaveConfig, LocalSaveSample } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import type { MeasuredEdit } from '../../../apps/web/src/editor/testing/local-save-timing.ts'
import type { ScenarioApiRequest } from '../safari/scenario-proxy.ts'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { localSaveSnapshotProblems } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import { withDatabase } from './database.ts'

export interface LocalSaveCloud {
  readonly revision: number
  readonly snapshotHash: string
  readonly formulasPending: boolean
  readonly contentProblems: readonly string[]
  readonly lease: { readonly holderId: string, readonly clientInstanceId: string, readonly writeEpoch: number, readonly ended: boolean } | null
}
export interface LocalSaveNetwork {
  readonly cutAt: number | null
  readonly inFlight: number
  readonly requests: readonly ScenarioApiRequest[]
}
export async function readLocalSaveCloud(documentId: string, edit?: MeasuredEdit): Promise<LocalSaveCloud> {
  return withDatabase(async (client) => {
    const row = (await client.query<{ revision: number, formulas_pending: boolean, snapshot: Buffer, holder_id: string | null, client_instance_id: string | null, write_epoch: number | null, ended: boolean }>(
      `SELECT d.revision, d.formulas_pending, c.snapshot, l.holder_id, l.client_instance_id, l.write_epoch, (l.ended_at IS NOT NULL) AS ended
       FROM documents d JOIN document_contents c ON c.document_id = d.id
       LEFT JOIN document_edit_leases l ON l.document_id = d.id WHERE d.id = $1`,
      [documentId],
    )).rows[0]
    if (row === undefined)
      throw new Error('本轮测量文档不存在')
    const text = gunzipSync(row.snapshot).toString('utf8')
    return {
      revision: row.revision,
      snapshotHash: createHash('sha256').update(text).digest('hex'),
      formulasPending: row.formulas_pending,
      contentProblems: edit === undefined ? [] : localSaveSnapshotProblems(text, edit),
      lease: row.holder_id === null || row.client_instance_id === null || row.write_epoch === null ? null : { holderId: row.holder_id, clientInstanceId: row.client_instance_id, writeEpoch: row.write_epoch, ended: row.ended },
    }
  })
}
export function localSaveCloudProblems(config: LocalSaveConfig, sample: LocalSaveSample, cloud: LocalSaveCloud, baseline: LocalSaveCloud): string[] {
  if (config.network === 'offline')
    return cloud.revision === baseline.revision && cloud.snapshotHash === baseline.snapshotHash && cloud.formulasPending === baseline.formulasPending ? [] : ['离线期间数据库偏离基线']
  return cloud.revision === sample.baseRevision + 1 && cloud.revision === sample.cloudRevision && cloud.snapshotHash === sample.snapshotHash && !cloud.formulasPending && cloud.contentProblems.length === 0 ? [] : ['数据库修订、完整正文摘要或本轮单元格不符']
}
export function localSaveNetworkProblems(config: LocalSaveConfig, documentId: string, networkAt: number, network: LocalSaveNetwork): string[] {
  const problems: string[] = []
  if (!Number.isSafeInteger(networkAt) || networkAt <= 0 || network.inFlight !== 0 || network.requests.some(request => request.completedAt === null || request.completedAt < request.startedAt))
    problems.push('传输时刻不符或仍有未结束请求')
  const saves = network.requests.filter(request => request.method === 'PUT' && request.path === `/api/documents/${documentId}/content` && request.startedAt >= networkAt)
  if (config.network === 'online') {
    if (network.cutAt !== null || saves.length !== config.rounds || saves.some(request => !request.forwarded || request.status !== 200))
      problems.push('在线组没有完整逐轮成功保存，或应用传输被切断')
  }
  else {
    const cutAt = network.cutAt
    const failedApplication = network.requests.filter(request => request.startedAt >= networkAt
      && ((request.method === 'PUT' && [`/api/documents/${documentId}/content`, `/api/documents/${documentId}/edit-lease`].includes(request.path))
        || (request.method === 'GET' && request.path === '/api/auth/session')))
    if (cutAt === null || !Number.isSafeInteger(cutAt) || cutAt <= 0 || cutAt > networkAt || failedApplication.length === 0
      || network.requests.some(request => request.forwarded ? request.startedAt >= (cutAt ?? Infinity) || (request.completedAt ?? Infinity) > (cutAt ?? Infinity) : request.status !== null)
      || failedApplication.some(request => request.forwarded || request.status !== null)) {
      problems.push('离线切断、实际应用请求失败或切断后零上游传输的证据不足')
    }
  }
  return problems
}
