import { describe, expect, it } from 'vitest'
import { assetGcRuntimeProblems, assetMountProblems, assetRuntimeProblems, nativeRuntimeProblems } from './container-image-checks.ts'

describe('正式镜像回执不能用空文件或只有成功退出替代', () => {
  const expected = { sharp: '0.35.5', sharpLibvips: '1.3.4', libvips: '8.18.7', sourceFiles: 398, sourceBytes: 201994917, distributedFiles: 402 }
  const native = { ...expected, platform: 'linux-arm64', verified: true }
  it('核对所有材料数量/大小、三个版本及真实 Linux 平台', () => {
    expect(nativeRuntimeProblems(0, JSON.stringify(native), expected)).toEqual([])
    for (const key of Object.keys(native))
      expect(nativeRuntimeProblems(0, JSON.stringify({ ...native, [key]: 'bad' }), expected), key).not.toEqual([])
    expect(nativeRuntimeProblems(0, JSON.stringify({ ...native, sourceFiles: 397 }), expected)).not.toEqual([])
  })
  it('命令失败、没有回执或无效 JSON 均拒绝', () => {
    for (const output of ['', '{}', 'ok', JSON.stringify({ verified: true })])
      expect(nativeRuntimeProblems(0, output, expected)).not.toEqual([])
    expect(nativeRuntimeProblems(1, JSON.stringify(native), expected)).not.toEqual([])
  })
  it('私有卷检查必须以非 root 执行且实际可写、不与 Web 重叠、限制工具存在', () => {
    const proof = { root: '/var/lib/nerve-office/assets', uid: 1000, private: true, writable: true, separated: true, limit: 'prlimit from util-linux 2.38.1', verified: true }
    expect(assetRuntimeProblems(0, JSON.stringify(proof))).toEqual([])
    for (const changed of [{ uid: 0 }, { root: '/app/web' }, { private: false }, { writable: false }, { separated: false }, { limit: '' }, { verified: false }])
      expect(assetRuntimeProblems(0, JSON.stringify({ ...proof, ...changed }))).not.toEqual([])
    expect(assetRuntimeProblems(1, JSON.stringify(proof))).not.toEqual([])
  })
  it('资源回收回执须包含 Linux 私有卷、备份暂停、危险配置拒绝、退休和新代次重开', () => {
    const proof = { platform: 'linux', uid: 1000, privateRoot: true, missingBackupPaused: true, invalidConfigurations: 3, retiredObjects: 1, markerBytes: 0, generationChanged: true, replayReleasedBytes: 0, reuploadedReadable: true, verified: true }
    expect(assetGcRuntimeProblems(0, JSON.stringify(proof))).toEqual([])
    for (const changed of [{ platform: 'darwin' }, { uid: 0 }, { privateRoot: false }, { missingBackupPaused: false }, { invalidConfigurations: 2 }, { retiredObjects: 0 }, { markerBytes: 1 }, { generationChanged: false }, { replayReleasedBytes: 1 }, { reuploadedReadable: false }, { verified: false }])
      expect(assetGcRuntimeProblems(0, JSON.stringify({ ...proof, ...changed }))).not.toEqual([])
    expect(assetGcRuntimeProblems(1, JSON.stringify(proof))).not.toEqual([])
    for (const output of ['', '{}', 'ok'])
      expect(assetGcRuntimeProblems(0, output)).not.toEqual([])
  })
})

describe('实际容器挂载核对', () => {
  const mount = { Type: 'volume', Name: 'test_assets', Destination: '/var/lib/nerve-office/assets', RW: true }
  const observation = (mounts: unknown[], readonly = true): string => JSON.stringify({ mounts, readonly })
  it('应用根仍只读，私有目录是本次项目的可写命名卷', () => {
    expect(assetMountProblems('app', 'test_assets', 0, observation([mount]))).toEqual([])
    for (const changed of [{ Type: 'bind' }, { Name: 'other' }, { Destination: '/app/web' }, { RW: false }])
      expect(assetMountProblems('app', 'test_assets', 0, observation([{ ...mount, ...changed }]))).not.toEqual([])
    expect(assetMountProblems('app', 'test_assets', 0, observation([mount], false))).not.toEqual([])
    expect(assetMountProblems('app', 'test_assets', 0, observation([]))).not.toEqual([])
    expect(assetMountProblems('app', 'test_assets', 1, observation([mount]))).not.toEqual([])
  })
  it.each(['db', 'migrate', 'caddy'])('%s 不能挂应用图片卷，即使换了容器内路径', (service) => {
    expect(assetMountProblems(service, 'test_assets', 0, observation([]))).toEqual([])
    expect(assetMountProblems(service, 'test_assets', 0, observation([{ ...mount, Destination: '/different' }]))).not.toEqual([])
  })
})
