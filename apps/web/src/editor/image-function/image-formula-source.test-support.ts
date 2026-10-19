import { Univer, UniverInstanceType } from '@univerjs/core'
import { AstTreeBuilder, generateAstNode, generateExecuteAstNodeData, IDefinedNamesService, IFormulaCurrentConfigService, Interpreter, Lexer, LexerNode, LexerTreeBuilder, UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { BaseFunction, BaseValueObject, IFunctionService, injectorOf } from '../internal-api/index.ts'
import { installRestrictedImageFunction } from './install-image-policy.ts'

type BaseAstNode = Parameters<BaseFunction['calculateAst']>[0][number]
export const IMAGE_SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
export const IMAGE_ORIGIN = 'https://docs.example.com'

class RecordingImageFunction extends BaseFunction {
  override minParams = 1
  override maxParams = 5
  readonly calls: BaseValueObject[][] = []
  readonly original: BaseFunction

  constructor(original: BaseFunction) {
    super('IMAGE')
    this.original = original
  }

  override calculate(...args: BaseValueObject[]): ReturnType<BaseFunction['calculate']> {
    this.calls.push(args)
    return this.original.calculate(...args)
  }
}

let instance = 0

/** 固定发布包的 lexer、parser、interpreter 与原 IMAGE；不用手造 AST 冒充来源。 */
export async function imageFormulaEngine() {
  const unitId = `s3-source-${++instance}`
  const univer = new Univer()
  univer.registerPlugin(UniverFormulaEnginePlugin, { notExecuteFormula: false })
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
    id: unitId,
    sheetOrder: ['sheet'],
    sheets: { sheet: { id: 'sheet', name: 'Sheet', rowCount: 10, columnCount: 5, cellData: { 0: { 0: { v: IMAGE_SOURCE } } } } },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const injector = injectorOf(univer)
  const functions = injector.get(IFunctionService)
  const original = functions.getExecutor('IMAGE')
  if (!original)
    throw new Error('实际 SDK 没有注册 IMAGE')
  const recording = new RecordingImageFunction(original)
  functions.registerExecutors(recording)
  if (!await installRestrictedImageFunction(univer, IMAGE_ORIGIN))
    throw new Error('实际 SDK 的 IMAGE 限制未安装')
  const lexer = injector.get(LexerTreeBuilder)
  const parser = injector.get(AstTreeBuilder)
  const interpreter = injector.get(Interpreter)
  const names: Record<string, string> = {
    sourceName: `"${IMAGE_SOURCE}"`,
    nestedSource: '=sourceName',
    imageName: `=IMAGE("${IMAGE_SOURCE}")`,
    pictureName: '=IMAGE(sourceName)',
    sizeName: '3',
    heightName: '20',
  }
  const definedNames = injector.get(IDefinedNamesService)
  for (const [name, formulaOrRefString] of Object.entries(names))
    definedNames.registerDefinedName(unitId, { id: name, name, formulaOrRefString })
  const context: NonNullable<Parameters<LexerTreeBuilder['treeBuilder']>[2]> = {
    unitId,
    sheetId: 'sheet',
    refOffsetX: 0,
    refOffsetY: 0,
    hasFunction: name => functions.getExecutor(name) !== undefined,
    getValueByName: (_unit, name) => names[name] === undefined ? undefined : { id: name, name, formulaOrRefString: names[name] },
    getDirtyDefinedNameMap: () => ({}),
    getSheetName: () => 'Sheet',
  }
  function parse(formula: string): BaseAstNode {
    const tree = lexer.treeBuilder(formula, true, context)
    if (!(tree instanceof LexerNode))
      throw new Error(`实际词法分析失败：${String(tree)}`)
    const ast = parser.parse(tree)
    if (!ast)
      throw new Error('实际语法分析失败')
    return ast
  }
  function scalar(value: ReturnType<Interpreter['execute']>): BaseValueObject {
    if (!(value instanceof BaseValueObject))
      throw new Error('IMAGE 来源对照意外返回引用对象')
    return value
  }
  return {
    univer,
    original,
    recording,
    functions,
    names,
    context,
    lexer,
    parse,
    cached: (formula: string) => generateAstNode(unitId, formula, injector.get(Lexer), parser, injector.get(IFormulaCurrentConfigService), 'sheet'),
    run: (node: BaseAstNode) => scalar(interpreter.execute(generateExecuteAstNodeData(node))),
    execute: (formula: string) => scalar(interpreter.execute(generateExecuteAstNodeData(parse(formula)))),
    executeAsync: async (formula: string) => scalar(await interpreter.executeAsync(generateExecuteAstNodeData(parse(formula)))),
    dispose: () => univer.dispose(),
  }
}

export function imageNodes(node: BaseAstNode): BaseAstNode[] {
  return [
    ...(node.nodeType === 4 && node.getToken() === 'IMAGE' ? [node] : []),
    ...node.getChildren().flatMap(child => imageNodes(child)),
  ]
}
