import { StringValueObject } from '@univerjs/engine-formula'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_ORIGIN, IMAGE_SOURCE, imageFormulaEngine, imageNodes } from '../image-function/image-formula-source.test-support.ts'
import { installRestrictedImageFunction } from '../image-function/install-image-policy.ts'

let engine: Awaited<ReturnType<typeof imageFormulaEngine>>
beforeEach(async () => {
  engine = await imageFormulaEngine()
})
afterEach(() => engine.dispose())

describe('IMAGE 首参来源：固定包实际词法、语法与解释执行', () => {
  it.each([
    `=IMAGE("${IMAGE_SOURCE}")`,
    `=image( "${IMAGE_SOURCE}" )`,
    `=_xlfn.IMAGE("${IMAGE_SOURCE}")`,
    `=IMAGE(( ("${IMAGE_SOURCE}") ))`,
    `=IMAGE("${IMAGE_ORIGIN}${IMAGE_SOURCE}")`,
    `=IF(TRUE,IMAGE("${IMAGE_SOURCE}"),IMAGE(sourceName))`,
    `=LET(x,1,IMAGE("${IMAGE_SOURCE}"))`,
    `=LAMBDA(x,IMAGE("${IMAGE_SOURCE}"))(1)`,
  ])('直接字面量和透明括号允许：%s', (formula) => {
    const value = engine.execute(formula)
    expect(value.isString()).toBe(true)
    expect(engine.recording.calls).toHaveLength(1)
    expect(engine.recording.calls[0]?.[0]?.getValue()).toMatch(/^https:\/\/docs\.example\.com\/api\/assets\/|^\/api\/assets\//)
  })

  it.each([
    `=IMAGE(""&"${IMAGE_SOURCE}")`,
    `=IMAGE(CONCAT("${IMAGE_SOURCE}"))`,
    `=IMAGE(IF(TRUE,"${IMAGE_SOURCE}",""))`,
    '=IMAGE(sourceName)',
    '=IMAGE(nestedSource)',
    `=IMAGE({"${IMAGE_SOURCE}"})`,
    '=IMAGE(A1)',
    '=IMAGE(A1:A2)',
    `=LET(x,"${IMAGE_SOURCE}",IMAGE(x))`,
    `=LAMBDA(x,IMAGE(x))("${IMAGE_SOURCE}")`,
    '=imageName',
  ])('相同地址的非字面量来源不调用原 IMAGE：%s', (formula) => {
    expect(engine.execute(formula).getValue()).toBe('#VALUE!')
    expect(engine.recording.calls).toEqual([])
  })

  it('真实解释器异步路径也拒绝名称展开，允许原字面量', async () => {
    expect((await engine.executeAsync('=IMAGE(sourceName)')).getValue()).toBe('#VALUE!')
    expect(engine.recording.calls).toEqual([])
    expect((await engine.executeAsync(`=IMAGE("${IMAGE_SOURCE}")`)).isString()).toBe(true)
    expect(engine.recording.calls).toHaveLength(1)
  })

  it('合法首参保留命名的模式/尺寸、计算参数、缺省与原错误语义', () => {
    const value = engine.execute(`=IMAGE("${IMAGE_SOURCE}","说明",sizeName,heightName,10*3)`)
    expect(value).toBeInstanceOf(StringValueObject)
    if (!(value instanceof StringValueObject))
      throw new Error('合法 IMAGE 没有返回字符串图片值')
    expect(value.getImageInfo()).toEqual({ source: IMAGE_SOURCE, altText: '说明', sizing: 3, height: 20, width: 30 })
    expect(engine.execute(`=IMAGE("${IMAGE_SOURCE}",,#REF!)`).getValue()).toBe('#REF!')
    expect(engine.execute(`=IMAGE("${IMAGE_SOURCE}",,9)`).getValue()).toBe('#VALUE!')
    expect(engine.execute(`=IMAGE("${IMAGE_SOURCE}","",3,20,30,40)`).getValue()).toBe('#N/A')
  })

  it('多个相同地址和名称生成的额外 IMAGE 不会错绑来源证明', () => {
    const formula = `=IFERROR(imageName,"")&IFERROR(IMAGE(sourceName),"")&IMAGE("${IMAGE_SOURCE}","ok",sizeName,heightName,30)`
    engine.execute(formula)
    expect(imageNodes(engine.parse(formula))).toHaveLength(3)
    expect(engine.recording.calls).toHaveLength(1)
    expect(engine.recording.calls[0]?.[1]?.getValue()).toBe('ok')
  })

  it('先行 UTF-16 文本和空白不使来源位置错绑', () => {
    const formula = `=IFERROR(IMAGE(sourceName,"ab😀"),"") & IMAGE("${IMAGE_SOURCE}","合法",sizeName,heightName,30)`
    engine.execute(formula)
    expect(engine.recording.calls).toHaveLength(1)
    expect(engine.recording.calls[0]?.[1]?.getValue()).toBe('合法')
  })

  it('固定 SDK 对带转义引号的名称展开原已拒绝，不能误当成来源通过', () => {
    const formula = `=IFERROR(IMAGE(sourceName,"a""b😀"),"")&IMAGE("${IMAGE_SOURCE}","合法",sizeName,heightName,30)`
    expect(engine.lexer.treeBuilder(formula, true, engine.context)).toBe('#VALUE!')
    expect(engine.recording.calls).toEqual([])
  })

  it('相同词法缓存重复解析，来源证明不会从合法调用泄漏给名称', () => {
    for (let round = 0; round < 3; round++) {
      engine.execute(`=IMAGE("${IMAGE_SOURCE}","",sizeName,heightName,30)`)
      expect(engine.execute('=IMAGE(sourceName)').getValue()).toBe('#VALUE!')
    }
    expect(engine.recording.calls).toHaveLength(3)
  })

  it.each([
    `=image(""&"${IMAGE_SOURCE}")`,
    '=pictureName',
  ])('重新安装后，真实全局 AST 缓存不能留下旧 IMAGE 执行器：%s', async (formula) => {
    engine.functions.registerExecutors(engine.recording)
    const unrelated = engine.cached('=SUM(1,2)')
    const before = engine.cached(formula)
    expect(engine.run(before).isString()).toBe(true)
    expect(engine.recording.calls).toHaveLength(1)
    engine.recording.calls.length = 0
    expect(await installRestrictedImageFunction(engine.univer, IMAGE_ORIGIN)).toBe(true)
    const after = engine.cached(formula)
    expect(engine.run(after).getValue()).toBe('#VALUE!')
    expect(after).not.toBe(before)
    expect(engine.recording.calls).toEqual([])
    expect(engine.cached('=SUM(1,2)')).toBe(unrelated)
  })
})
