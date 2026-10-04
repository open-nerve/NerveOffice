// 比较两次堆快照（M3-P2 S5：反复切换的内存随次数增长时，找出是谁留住了旧的实例）。memory.spec.ts 在 MEASURE_HEAP_SNAPSHOTS=1 时
// 于第 2 次与最后一次之后各取一次（同一个 CDP 会话里取的，对象的 id 前后一致）。
// 用法：NODE_OPTIONS=--conditions=@nerve-office/source node measure/heap-diff.ts <前一次.heapsnapshot> <后一次.heapsnapshot> [每类列几条保留路径，默认 2]
// 输出：
// 1. 两次的合计：全部、V8 的代码（节点类型 code：字节码、编译出的机器码与它们的元数据，随函数变热、被优化而增加）与其余；
//    编辑器实例的标志各有几个（表格的主画布、公式 Worker、Univer 弹出层的门户；游离的画布）：旧的实例被留住时它们随次数变多；
// 2. 按"类型 名称"（对象是构造函数的名字；测试构建经过压缩，SDK 的类名多半已经改短）合计，后一次比前一次多出来的个数与字节，前 40 项；
// 3. 多出来最多的几类里，后一次才有的对象（id 不在前一次里）各挑几个，列出从 GC 根到它的最短保留路径（不走弱引用）：
//    路径上的属性名没有压缩，看得出是谁（平台的代码还是 SDK 的）留住了它。
// 解析按 V8 堆快照的格式（snapshot.meta 给出字段的顺序），读进内存一次处理；几十 MB 的快照几秒钟。
import { readFileSync } from 'node:fs'
import process from 'node:process'

interface Snapshot {
  readonly snapshot: {
    readonly meta: {
      readonly node_fields: readonly string[]
      readonly node_types: readonly [readonly string[], ...unknown[]]
      readonly edge_fields: readonly string[]
      readonly edge_types: readonly [readonly string[], ...unknown[]]
    }
    readonly node_count: number
  }
  readonly nodes: readonly number[]
  readonly edges: readonly number[]
  readonly strings: readonly string[]
}

/** 解析好的快照：按节点的序号（0 起）取各个字段 */
interface Heap {
  readonly count: number
  readonly type: (node: number) => string
  readonly name: (node: number) => string
  readonly id: (node: number) => number
  readonly selfSize: (node: number) => number
  /** DOM 节点是否游离（0 不知道，1 在文档里，2 游离） */
  readonly detachedness: (node: number) => number
  /** 这个节点的各条出边：类型、名称、指向的节点 */
  readonly edges: (node: number) => Iterable<{ readonly type: string, readonly name: string, readonly to: number }>
}

function load(file: string): Heap {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
  const { meta } = raw.snapshot
  const nodeWidth = meta.node_fields.length
  const edgeWidth = meta.edge_fields.length
  const field = (name: string): number => meta.node_fields.indexOf(name)
  const [typeField, nameField, idField, sizeField, edgeCountField, detachedField] = ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'].map(field) as [number, number, number, number, number, number]
  const edgeType = meta.edge_fields.indexOf('type')
  const edgeName = meta.edge_fields.indexOf('name_or_index')
  const edgeTo = meta.edge_fields.indexOf('to_node')
  const nodeTypes = meta.node_types[0]
  const edgeTypes = meta.edge_types[0]
  const count = raw.snapshot.node_count
  // 每个节点的第一条出边在 edges 里的位置
  const firstEdge = new Uint32Array(count + 1)
  for (let node = 0, edge = 0; node < count; node += 1) {
    firstEdge[node] = edge
    edge += (raw.nodes[node * nodeWidth + edgeCountField] ?? 0) * edgeWidth
    firstEdge[node + 1] = edge
  }
  const at = (node: number, offset: number): number => raw.nodes[node * nodeWidth + offset] ?? 0
  return {
    count,
    type: node => nodeTypes[at(node, typeField)] ?? '?',
    name: node => raw.strings[at(node, nameField)] ?? '?',
    id: node => at(node, idField),
    selfSize: node => at(node, sizeField),
    detachedness: node => detachedField < 0 ? 0 : at(node, detachedField),
    * edges(node) {
      for (let edge = firstEdge[node] ?? 0; edge < (firstEdge[node + 1] ?? 0); edge += edgeWidth) {
        const type = edgeTypes[raw.edges[edge + edgeType] ?? 0] ?? '?'
        const value = raw.edges[edge + edgeName] ?? 0
        // element 与 hidden 的名称是下标，别的是字符串表的序号
        const name = type === 'element' || type === 'hidden' ? `[${value}]` : (raw.strings[value] ?? '?')
        yield { type, name, to: (raw.edges[edge + edgeTo] ?? 0) / nodeWidth }
      }
    },
  }
}

/** 节点的分类：类型与名称（字符串、数字之类按类型合并，名称没有意义） */
function classOf(heap: Heap, node: number): string {
  const type = heap.type(node)
  if (type === 'string' || type === 'concatenated string' || type === 'sliced string' || type === 'number' || type === 'code' || type === 'hidden' || type === 'array' || type === 'object shape')
    return `(${type})`
  return `${type} ${heap.name(node).slice(0, 80)}`
}

interface ClassTotal {
  count: number
  bytes: number
}

/** 编辑器实例的标志：每个编辑器各一个（主画布、公式 Worker、弹出层的门户），旧的实例被留住时随次数变多 */
const INSTANCE_MARKERS: readonly { readonly name: string, readonly test: (heap: Heap, node: number) => boolean }[] = [
  { name: '表格的主画布（univer-sheet-main-canvas_）', test: (heap, node) => heap.type(node) === 'native' && heap.name(node).includes('univer-sheet-main-canvas_') },
  { name: '公式 Worker（native Worker）', test: (heap, node) => heap.type(node) === 'native' && heap.name(node) === 'Worker' },
  { name: 'Univer 弹出层的门户（univer-popup-portal-）', test: (heap, node) => heap.type(node) === 'native' && heap.name(node).startsWith('<div id="univer-popup-portal-') },
  { name: '游离的画布', test: (heap, node) => heap.type(node) === 'native' && heap.name(node).startsWith('<canvas') && heap.detachedness(node) === 2 },
]

/** 合计：全部的字节、V8 的代码的字节，与各个实例标志的个数 */
function overview(heap: Heap): { readonly bytes: number, readonly code: number, readonly markers: readonly number[] } {
  let bytes = 0
  let code = 0
  const markers = INSTANCE_MARKERS.map(() => 0)
  for (let node = 0; node < heap.count; node += 1) {
    bytes += heap.selfSize(node)
    if (heap.type(node) === 'code')
      code += heap.selfSize(node)
    INSTANCE_MARKERS.forEach((marker, index) => {
      if (marker.test(heap, node))
        markers[index] = (markers[index] ?? 0) + 1
    })
  }
  return { bytes, code, markers }
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`
}

function totals(heap: Heap): Map<string, ClassTotal> {
  const result = new Map<string, ClassTotal>()
  for (let node = 0; node < heap.count; node += 1) {
    const key = classOf(heap, node)
    const total = result.get(key) ?? { count: 0, bytes: 0 }
    total.count += 1
    total.bytes += heap.selfSize(node)
    result.set(key, total)
  }
  return result
}

/** 从 GC 根（0 号节点）出发、不走弱引用的广度优先：每个节点的上一个节点与那条边 */
function retainers(heap: Heap): { readonly parent: Int32Array, readonly via: string[] } {
  const parent = new Int32Array(heap.count).fill(-1)
  const via: string[] = Array.from({ length: heap.count })
  const queue = new Uint32Array(heap.count)
  let head = 0
  let tail = 0
  queue[tail++] = 0
  parent[0] = 0
  while (head < tail) {
    const node = queue[head++] ?? 0
    for (const edge of heap.edges(node)) {
      if (edge.type === 'weak' || parent[edge.to] !== -1)
        continue
      parent[edge.to] = node
      via[edge.to] = `${edge.type}:${edge.name}`
      queue[tail++] = edge.to
    }
  }
  return { parent, via }
}

/** 从 GC 根到 target 的路径：每行"—边的类型:名称→ 节点的类型 名称" */
function pathTo(heap: Heap, tree: ReturnType<typeof retainers>, target: number): string {
  if (tree.parent[target] === -1)
    return '（从 GC 根不经弱引用到不了）'
  const chain: number[] = []
  for (let node = target; node !== 0 && chain.length < 60; node = tree.parent[node] ?? 0)
    chain.push(node)
  return chain.reverse().map(node => `—${tree.via[node] ?? '?'}→ ${classOf(heap, node)}`).join('\n    ')
}

function main(): void {
  const [beforeFile, afterFile, pathsArg] = process.argv.slice(2)
  if (beforeFile === undefined || afterFile === undefined)
    throw new Error('用法：node measure/heap-diff.ts <前一次.heapsnapshot> <后一次.heapsnapshot> [每类的保留路径条数]')
  const pathsPerClass = Number(pathsArg ?? '2')
  const before = load(beforeFile)
  const after = load(afterFile)
  const out: string[] = [`前一次 ${before.count} 个节点，后一次 ${after.count} 个节点`]
  const [first, second] = [overview(before), overview(after)]
  out.push(
    '',
    '| | 前一次 | 后一次 | 多出来 |',
    '| --- | --- | --- | --- |',
    `| 全部 | ${kib(first.bytes)} | ${kib(second.bytes)} | ${kib(second.bytes - first.bytes)} |`,
    `| V8 的代码（节点类型 code） | ${kib(first.code)} | ${kib(second.code)} | ${kib(second.code - first.code)} |`,
    `| 其余（JS 对象、DOM 与浏览器的对象） | ${kib(first.bytes - first.code)} | ${kib(second.bytes - second.code)} | ${kib(second.bytes - second.code - first.bytes + first.code)} |`,
    ...INSTANCE_MARKERS.map((marker, index) => `| ${marker.name} | ${first.markers[index] ?? 0} 个 | ${second.markers[index] ?? 0} 个 | ${(second.markers[index] ?? 0) - (first.markers[index] ?? 0)} |`),
  )
  const beforeTotals = totals(before)
  const growth = [...totals(after)]
    .map(([key, total]) => ({ key, count: total.count - (beforeTotals.get(key)?.count ?? 0), bytes: total.bytes - (beforeTotals.get(key)?.bytes ?? 0) }))
    .filter(item => item.count > 0 || item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
  out.push('', '多出来的（按字节，前 40 项）：', '| 类型 名称 | 个数 | 字节 |', '| --- | --- | --- |')
  for (const item of growth.slice(0, 40))
    out.push(`| ${item.key.replaceAll('|', '\\|')} | +${item.count} | +${item.bytes} |`)
  const beforeIds = new Set<number>()
  for (let node = 0; node < before.count; node += 1)
    beforeIds.add(before.id(node))
  const tree = retainers(after)
  // 有名字的对象、闭包与原生对象里多出来最多的几类：各挑几个后一次才有的，看保留路径
  const named = growth.filter(item => !item.key.startsWith('(') && item.count > 0).sort((a, b) => b.count - a.count).slice(0, 8)
  out.push('', '多出来最多的几类里后一次才有的对象，从 GC 根到它的最短保留路径（不走弱引用）：')
  for (const item of named) {
    out.push('', `## ${item.key}（+${item.count}）`)
    let shown = 0
    for (let node = 0; node < after.count && shown < pathsPerClass; node += 1) {
      if (classOf(after, node) !== item.key || beforeIds.has(after.id(node)))
        continue
      out.push(`  @${after.id(node)}：\n    ${pathTo(after, tree, node)}`)
      shown += 1
    }
  }
  process.stdout.write(`${out.join('\n')}\n`)
}

main()
