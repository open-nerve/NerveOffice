// 只在测试构建运行；计时沿用 P2，读盘/解密/云端及宿主确认都在计时结束以后。
import type { LocalSaveConfig, LocalSaveIdentity, LocalSaveSample } from './local-save-report.ts'
import type { MeasuredEdit } from './local-save-timing.ts'
import type { observeSelftestWrites, SelftestKey } from './selftest-persistence.ts'
import type { Session } from './selftest-session.ts'
import { connectionState } from '../../shared/lib/connection-state.ts'
import { perfIncrementalEdit } from './capture-samples.ts'
import { localSavePrefixProblems, localSaveProblems, localSaveSnapshotProblems, localSaveTargets } from './local-save-report.ts'
import { observeLocalSaveEdit } from './local-save-timing.ts'
import { autosaveControl, prepareAutosave } from './selftest-autosave.ts'
import { readSelftestDraft, readSelftestWriter } from './selftest-local-draft.ts'
import { localSaveTransportFailed } from './selftest-local-save-connection.ts'
import { assertMeasuredDraft } from './selftest-local-save-draft.ts'
import { decryptWithSelftestKey, loadSelftestKey, selftestSha256 } from './selftest-persistence.ts'
import { check } from './selftest-session.ts'

export async function runLocalSaveMeasurement(session: Session, options: {
  readonly config: LocalSaveConfig
  readonly documentId: string
  readonly writes: ReturnType<typeof observeSelftestWrites>
  readonly post: (kind: string, facts?: Record<string, unknown>) => Promise<unknown>
  readonly samples: LocalSaveSample[]
  readonly signal: AbortSignal
}): Promise<void> {
  const { config, documentId, writes, post, samples, signal } = options
  let key: SelftestKey | undefined
  let identity: LocalSaveIdentity | undefined
  let lastDraftSeq = 0
  let baseRevision = 0
  let connectionGeneration = 0
  let networkPreparedAt = 0
  const guard = (): void => {
    signal.throwIfAborted()
    if (performance.now() >= session.deadline || session.hiddenAt !== undefined || document.visibilityState !== 'visible' || session.host.view().mode !== 'editing')
      throw new Error('测量超时、页面不再可见或已经离开编辑')
  }
  const fetchBounded = async (path: string): Promise<Response> => {
    guard()
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
    if (!response.ok)
      throw new Error(`测量独立读取失败：${response.status}`)
    return response
  }
  const metadata = async (): Promise<number> => {
    const data = await (await fetchBounded(`/api/documents/${encodeURIComponent(documentId)}`)).json() as { revision?: unknown, formulasPending?: unknown }
    if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 1 || data.formulasPending !== false)
      throw new Error('云端修订或公式状态无法核对')
    return Number(data.revision)
  }
  const poll = async (accept: () => Promise<boolean>, milliseconds: number): Promise<void> => {
    const until = performance.now() + milliseconds
    while (performance.now() < until) {
      guard()
      if (await accept()) {
        guard()
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('测量阶段没有在限定时间内得到实际结果')
  }
  try {
    if (!await check(session, 'local-save.ready', async () => {
      guard()
      prepareAutosave({ mode: 'running' })
      const auth = await (await fetchBounded('/api/auth/session')).json() as { user: { id: string }, csrfToken: string }
      key = await loadSelftestKey(auth.csrfToken)
      guard()
      const writer = await readSelftestWriter(auth.user.id, documentId)
      if (writer === undefined || writer.userId !== auth.user.id || writer.documentId !== documentId)
        throw new Error('没有本页实际登记的持久写入者')
      lastDraftSeq = writer.lastDraftSeq
      baseRevision = await metadata()
      const connection = connectionState.view()
      if (!connection.available || !connection.browserOnline)
        throw new Error('切断之前应用连接已经不可用')
      connectionGeneration = connection.generation
      networkPreparedAt = Date.now()
      const reply = await post('ready', { userId: writer.userId, writerId: writer.writerId, writeEpoch: writer.writeEpoch, lastDraftSeq, baseRevision }) as { kind?: unknown }
      if (reply?.kind !== 'wait')
        throw new Error('宿主拒绝本轮准备')
      await poll(async () => {
        const command = await post('network-state') as { kind?: unknown, clientInstanceId?: unknown }
        if (command?.kind === 'wait')
          return false
        if (command?.kind !== 'measure' || typeof command.clientInstanceId !== 'string')
          throw new Error('宿主没有确认本轮网络与租约身份')
        identity = { userId: writer.userId, documentId, writerId: writer.writerId, writeEpoch: writer.writeEpoch, writtenBy: command.clientInstanceId }
        return true
      }, 30_000)
      return '正常捕获与上传节奏、实际写入者、不可导出解密密钥及宿主网络条件均已确认'
    }, 90_000)) {
      return
    }

    for (let round = 1; round <= config.rounds; round += 1) {
      if (!await check(session, `local-save.round.${round}`, async () => {
        guard()
        if (key === undefined || identity === undefined)
          throw new Error('测量身份或独立密钥已释放')
        const edit: MeasuredEdit = config.sample === 'perf-50k' ? { ...perfIncrementalEdit(round - 1), formula: true } : { cell: 'B2', value: `实测第 ${round} 次修改`, formula: false }
        autosaveControl().clearLog()
        const wallStartedAt = Date.now()
        session.facts.localSaveAttemptRound = round
        session.facts.localSaveWallStartedAt = wallStartedAt
        const timing = await observeLocalSaveEdit(edit)
        session.facts.localSaveStartedAt = timing.startedAt
        session.facts.localSaveSavedAt = timing.savedAt
        session.facts.localSaveEditorSeq = timing.editorSeq
        guard()
        // 只读一次；被云端 ACK 抢先清掉的草稿不能用旧原件或内存快照冒充。
        const draft = await readSelftestDraft(identity.userId, documentId)
        session.facts.localSaveDraftSeq = draft?.draftSeq ?? null
        session.facts.localSaveDraftUpdatedAt = draft?.updatedAt ?? null
        assertMeasuredDraft(draft, { identity, lastDraftSeq, baseRevision, wallStartedAt, readAt: Date.now() })
        const text = await decryptWithSelftestKey(draft, key)
        const snapshotHash = await selftestSha256(text)
        const worker = writes.timingFor(draft, snapshotHash)
        const captures = autosaveControl().log().filter(entry => entry.kind === 'capture' && entry.at >= timing.startedAt && entry.at <= timing.savedAt)
        const capture = captures.at(-1)
        if (worker === undefined || !writes.writtenFor(draft, snapshotHash) || capture?.kind !== 'capture' || capture.seq !== timing.editorSeq || capture.formulasPending || localSaveSnapshotProblems(text, edit).length > 0)
          throw new Error('Worker 写成回包、实际捕获或本轮正文/公式缓存不符')
        let cloudRevision: number | null = null
        if (config.network === 'online') {
          await poll(async () => session.host.view().save === 'clean', 20_000)
          const cloud = await (await fetchBounded(`/api/documents/${encodeURIComponent(documentId)}/content`)).text()
          cloudRevision = await metadata()
          if (localSaveSnapshotProblems(cloud, edit).length > 0 || cloudRevision !== baseRevision + 1 || await selftestSha256(cloud) !== snapshotHash)
            throw new Error('在线逐轮云端正文或修订与真实草稿不符')
        }
        guard()
        const sample: LocalSaveSample = {
          ...identity,
          ...timing,
          round,
          cold: round === 1,
          wallStartedAt,
          checkedAt: Date.now(),
          draftSeq: draft.draftSeq,
          baseRevision: draft.baseRevision,
          captureSeq: capture.seq,
          captureAt: capture.at,
          captureMs: Math.max(...captures.map(entry => entry.kind === 'capture' ? entry.durationMs : 0)),
          workerSentAt: worker.sentAt,
          workerReceivedAt: worker.receivedAt,
          workerMs: worker.receivedAt - worker.sentAt,
          workerConfirmed: true,
          rawBytes: draft.rawBytes,
          snapshotHash,
          contentChecked: true,
          formulasPending: draft.formulasPending,
          cloudChecked: config.network === 'online',
          cloudRevision,
          visible: document.visibilityState === 'visible',
        }
        samples.push(sample)
        if (localSavePrefixProblems(samples, config, identity).length > 0)
          throw new Error('本轮原始事实不满足完整测量判据')
        const reply = await post('sample', { sample }) as { kind?: unknown }
        if (reply?.kind !== 'wait')
          throw new Error('宿主拒绝本轮样本')
        await poll(async () => {
          const command = await post('round-state', { round }) as { kind?: unknown }
          if (command?.kind === 'wait')
            return false
          if (command?.kind !== 'next')
            throw new Error('本轮独立数据库核对未通过')
          return true
        }, 20_000)
        lastDraftSeq = draft.draftSeq
        baseRevision = cloudRevision ?? baseRevision
        return `第 ${round} 轮真实草稿与 Worker 回包匹配，正文和公式缓存独立核对完成`
      }, 90_000)) {
        return
      }
    }
    await check(session, 'local-save.targets', async () => {
      if (config.network === 'offline') {
        // 连续编辑超过心跳间隔时，真实续约失败会先暂停上传；不能为了取证强迫正文上传。
        await poll(async () => localSaveTransportFailed(connectionState.view(), connectionGeneration, networkPreparedAt), 20_000)
        session.facts.localSaveTransportFailed = true
      }
      if (identity === undefined || localSaveProblems(samples, config, identity).length > 0 || localSaveTargets(samples, config).length > 0)
        throw new Error('整组证据或性能门槛未满足')
      return '全部轮次完整，公式条件外样本保留，端到端与同步捕获门槛通过'
    }, 30_000)
  }
  finally { key = undefined }
}
