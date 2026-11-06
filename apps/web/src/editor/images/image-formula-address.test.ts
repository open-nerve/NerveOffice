import { describe, expect, it } from 'vitest'
import { normalizeImageFormula } from './image-formula-address.ts'

const ORIGIN = 'https://docs.example.com'
const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const RELATIVE = `/api/assets/${ID}`
const ABSOLUTE = `${ORIGIN}${RELATIVE}`

describe('IMAGE() 首参的本站绝对地址写入时规范为相对地址（M5R-I-03，D-02）', () => {
  it.each([
    [`=IMAGE("${ABSOLUTE}")`, `=IMAGE("${RELATIVE}")`],
    [`=IMAGE("${ABSOLUTE}","说明",3,60,70)`, `=IMAGE("${RELATIVE}","说明",3,60,70)`],
    [`=image("${ABSOLUTE}")`, `=image("${RELATIVE}")`],
    [`=IMAGE( "${ABSOLUTE}" , "", 0)`, `=IMAGE( "${RELATIVE}" , "", 0)`],
    [`=IMAGE((("${ABSOLUTE}")),"")`, `=IMAGE((("${RELATIVE}")),"")`],
    [`=IF(A1,IMAGE("${ABSOLUTE}"),"")`, `=IF(A1,IMAGE("${RELATIVE}"),"")`],
    [`=IF("a""b"="x",IMAGE("${ABSOLUTE}"),IMAGE("${ORIGIN}/api/assets/${OTHER}"))`, `=IF("a""b"="x",IMAGE("${RELATIVE}"),IMAGE("/api/assets/${OTHER}"))`],
    [`='工作"表'!A1&IMAGE("${ABSOLUTE}")`, `='工作"表'!A1&IMAGE("${RELATIVE}")`],
    [`='it''s'!A1&IMAGE("${ABSOLUTE}")`, `='it''s'!A1&IMAGE("${RELATIVE}")`],
    [`=Table1[[#This Row],["col]]&IMAGE("${ABSOLUTE}")`, `=Table1[[#This Row],["col]]&IMAGE("${RELATIVE}")`],
  ])('改写首参字面量：%s', (formula, expected) => {
    expect(normalizeImageFormula(formula, ORIGIN)).toBe(expected)
  })

  // SDK 认作 IMAGE 调用的等价写法（engine-formula 的 checkAndCreateNodeType：名字两端的空白去掉；normalizeFunctionToken：
  // 不区分大小写、去掉一个 _XLFN./_XLWS./_XLETA. 前缀；@、- 是另外的前缀节点）：写入者能看到图，必须同样改写（S14 审查 E2）
  it.each([
    [`=IMAGE ("${ABSOLUTE}")`, `=IMAGE ("${RELATIVE}")`],
    [`=IMAGE\n\t("${ABSOLUTE}")`, `=IMAGE\n\t("${RELATIVE}")`],
    [`=IMAGE\u00A0("${ABSOLUTE}")`, `=IMAGE\u00A0("${RELATIVE}")`],
    [`=_xlfn.IMAGE("${ABSOLUTE}")`, `=_xlfn.IMAGE("${RELATIVE}")`],
    [`=_XLWS.image("${ABSOLUTE}")`, `=_XLWS.image("${RELATIVE}")`],
    [`=_xleta.Image ("${ABSOLUTE}")`, `=_xleta.Image ("${RELATIVE}")`],
    [`=@IMAGE("${ABSOLUTE}")`, `=@IMAGE("${RELATIVE}")`],
    [`=IF(A1,_xlfn.IMAGE ("${ABSOLUTE}"),"")`, `=IF(A1,_xlfn.IMAGE ("${RELATIVE}"),"")`],
  ])('SDK 认作 IMAGE 的等价写法同样改写：%s', (formula, expected) => {
    expect(normalizeImageFormula(formula, ORIGIN)).toBe(expected)
  })

  it.each([
    `=IMAGE("${RELATIVE}")`,
    `=IMAGE("https://outside.example/api/assets/${ID}")`,
    `=IMAGE("${ABSOLUTE}?x=1")`,
    `=IMAGE("${ABSOLUTE}/extra")`,
    `=IMAGE("${ORIGIN}/api/assets/0199A2C4-1F2E-4A3B-8C4D-5E6F7A8B9C0D")`,
    `=IMAGE(" ${ABSOLUTE}")`,
    `="${ABSOLUTE}"`,
    `=HYPERLINK("${ABSOLUTE}")`,
    `=MYIMAGE("${ABSOLUTE}")`,
    // SDK 只去掉一个前缀、前缀要带点：这些不是 IMAGE 调用
    `=_xlfn._xlws.IMAGE("${ABSOLUTE}")`,
    `=_xlfnIMAGE("${ABSOLUTE}")`,
    `=XLFN.IMAGE("${ABSOLUTE}")`,
    `=IMAGE(A1)`,
    `=IMAGE("${ABSOLUTE}"&"")`,
    `=IMAGE(+"${ABSOLUTE}")`,
    `=IMAGE(("${ABSOLUTE}"&""))`,
    `=IMAGE("${RELATIVE}","${ABSOLUTE}")`,
    `="IMAGE(""${ABSOLUTE}"")"`,
    `='IMAGE("${ABSOLUTE}")'!A1`,
    `=IMAGE("${ABSOLUTE}`,
    `${ABSOLUTE}`,
  ])('其他写法原样保留：%s', (formula) => {
    expect(normalizeImageFormula(formula, ORIGIN)).toBe(formula)
  })

  it('没有本站源时不改写', () => {
    const formula = `=IMAGE("${ABSOLUTE}")`
    expect(normalizeImageFormula(formula, '')).toBe(formula)
    expect(normalizeImageFormula(formula, 'null')).toBe(formula)
    expect(normalizeImageFormula(formula, 'https://other.example.com')).toBe(formula)
  })

  it('不含本站地址的长公式直接原样返回', () => {
    const formula = `=SUM(${Array.from({ length: 10_000 }, (_, index) => `A${index + 1}`).join(',')})`
    expect(normalizeImageFormula(formula, ORIGIN)).toBe(formula)
  })
})
