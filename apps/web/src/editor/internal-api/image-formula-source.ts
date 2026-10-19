import type { BaseAstNode } from '@univerjs/engine-formula'

/**
 * 固定 engine-formula 补丁在名称展开前证明首参，再按真实输出位置传给函数节点。
 * nodeType 2/4 是该版本的 Value/Function；没有运行期证明的手造节点不能放行。
 * 括号只改变分组，名称、LET/LAMBDA 参数即使求值得到同一字符串也没有此证明。
 */
export function imageLiteralSource(node: BaseAstNode): string | undefined {
  const parent = node.getParent()
  if (node.nodeType !== 2 || node.getChildren().length !== 0
    || !parent || parent.nodeType !== 4 || parent.getToken() !== 'IMAGE'
    || parent.getChildren()[0] !== node
    || !('_nerveLiteralFirstArgument' in parent) || parent._nerveLiteralFirstArgument !== true) {
    return undefined
  }
  const token = node.getToken().trim()
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"'))
    return undefined
  return token.slice(1, -1).replace(/""/g, '"')
}
