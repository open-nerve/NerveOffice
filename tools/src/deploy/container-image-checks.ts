import { z } from 'zod'

const nativeProofSchema = z.strictObject({
  platform: z.enum(['linux-arm64', 'linux-x64']),
  sharp: z.string(),
  sharpLibvips: z.string(),
  libvips: z.string(),
  sourceFiles: z.number().int().positive(),
  sourceBytes: z.number().int().positive(),
  distributedFiles: z.number().int().positive(),
  verified: z.literal(true),
})
type NativeProof = z.infer<typeof nativeProofSchema>

export function nativeRuntimeProblems(status: number | null, output: string, expected: Omit<NativeProof, 'platform' | 'verified'>): string[] {
  try {
    if (status !== 0)
      throw new Error('执行失败')
    const proof = nativeProofSchema.parse(JSON.parse(output))
    if (Object.entries(expected).some(([key, value]) => proof[key as keyof NativeProof] !== value))
      throw new Error('材料版本或数量不符')
    return []
  }
  catch {
    return ['镜像中的原生组件与完整源码材料复核失败']
  }
}

const assetProofSchema = z.strictObject({
  root: z.literal('/var/lib/nerve-office/assets'),
  uid: z.number().int().positive(),
  private: z.literal(true),
  writable: z.literal(true),
  separated: z.literal(true),
  limit: z.string().startsWith('prlimit from util-linux '),
  verified: z.literal(true),
})

export function assetRuntimeProblems(status: number | null, output: string): string[] {
  try {
    if (status !== 0)
      throw new Error('执行失败')
    assetProofSchema.parse(JSON.parse(output))
    return []
  }
  catch {
    return ['镜像的私有图片根、写入、根分离或 Linux 限制工具检查失败']
  }
}

const assetGcProofSchema = z.strictObject({
  platform: z.literal('linux'),
  uid: z.number().int().positive(),
  privateRoot: z.literal(true),
  missingBackupPaused: z.literal(true),
  invalidConfigurations: z.literal(3),
  retiredObjects: z.literal(1),
  markerBytes: z.literal(0),
  generationChanged: z.literal(true),
  replayReleasedBytes: z.literal(0),
  reuploadedReadable: z.literal(true),
  verified: z.literal(true),
})

export function assetGcRuntimeProblems(status: number | null, output: string): string[] {
  try {
    if (status !== 0)
      throw new Error('执行失败')
    assetGcProofSchema.parse(JSON.parse(output))
    return []
  }
  catch {
    return ['镜像内资源回收的配置保护、私有文件退休或新代次接续核对失败']
  }
}

const mountsSchema = z.object({
  mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string(), RW: z.boolean() })),
  readonly: z.boolean(),
})

/** 只接收 Mounts/ReadonlyRootfs，不读取或记录容器的环境变量。 */
export function assetMountProblems(service: string, volumeName: string, status: number | null, output: string): string[] {
  try {
    if (status !== 0)
      throw new Error('执行失败')
    const { mounts, readonly } = mountsSchema.parse(JSON.parse(output))
    if (service === 'app') {
      const atRoot = mounts.filter(mount => mount.Destination === '/var/lib/nerve-office/assets')
      if (!readonly || atRoot.length !== 1 || atRoot[0]?.Type !== 'volume' || atRoot[0].Name !== volumeName || !atRoot[0].RW)
        throw new Error('挂载错误')
    }
    else if (mounts.some(mount => mount.Name === volumeName || mount.Destination === '/var/lib/nerve-office/assets')) {
      throw new Error('非应用容器挂载了图片卷')
    }
    return []
  }
  catch {
    return [`${service} 的实际图片卷挂载或只读根配置不符`]
  }
}
