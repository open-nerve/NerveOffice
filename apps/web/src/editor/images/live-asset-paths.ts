import { extractAssetIds } from '@nerve-office/contracts'

const PREFIX = '/api/assets/'

/**
 * 工作簿数据里仍引用的平台图片地址（规范相对地址 `/api/assets/<id>`，M5R-M-11）：图片刷新只重读这些来源。
 * 遍历全部字符串值：资源插件保存浮图的 JSON 字符串、IMAGE() 公式与单元格图片都在其中。地址判定沿用服务端提取引用的同一函数；
 * 同源绝对地址先改写为相对地址，与资源表的规范形式一致。用显式栈遍历，宽数组与深嵌套都不受调用栈与参数个数限制
 */
export function liveAssetPaths(data: unknown, origin: string): Set<string> {
  const paths = new Set<string>()
  const absolute = `${origin}${PREFIX}`
  const pending: unknown[] = [data]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') {
      if (value.includes(PREFIX)) {
        for (const id of extractAssetIds(value.replaceAll(absolute, PREFIX)))
          paths.add(`${PREFIX}${id}`)
      }
    }
    else if (typeof value === 'object' && value !== null) {
      for (const child of Array.isArray(value) ? value : Object.values(value))
        pending.push(child)
    }
  }
  return paths
}
