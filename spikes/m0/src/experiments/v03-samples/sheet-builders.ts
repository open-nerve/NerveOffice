// V03 表格样本构建器：在空白工作簿上用 Facade 生成内容，生成后由 save() 输出样本（样本本身就是 SDK 的输出）。
// 每个带数据的插件至少一个样本；sheet-all 是综合样本；sheet-protection 只用于观察保护类资源。
import type { FWorkbook, FWorksheet } from '@univerjs/sheets/facade';
import type { EditorHandle, SampleBuilder } from '../../harness/create-editor';

import { BorderStyleTypes, BorderType } from '@univerjs/core';

const BLUE = '/fixtures-assets/blue-120x80.png';
const ORANGE = '/fixtures-assets/orange-64x64.png';

function workbook(editor: EditorHandle): FWorkbook {
    const wb = editor.univerAPI.getActiveWorkbook();
    if (wb == null) throw new Error('没有活动的工作簿');
    return wb;
}

/** 等公式、自动行高等异步任务落定。 */
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

async function buildCore(editor: EditorHandle): Promise<void> {
    const wb = workbook(editor);
    const data = wb.getActiveSheet();

    // 表头：加粗、底色、居中、下边框
    data.getRange('A1:G1').setValues([['名称', '数量', '日期', '比例', '金额', '精度', '拼接']]);
    const header = data.getRange('A1:G1');
    header.setFontWeight('bold');
    header.setBackground('#dbeafe');
    header.setHorizontalAlignment('center');
    header.setBorder(BorderType.BOTTOM, BorderStyleTypes.MEDIUM, '#1d4ed8');

    // 多种值类型与数字格式
    data.getRange('A2:F6').setValues([
        ['苹果', 12, 45200, 0.125, 1234.5, 3.14159],
        ['香蕉', 7, 45201, 0.3, 88, 2.71828],
        ['橙子', 30, 45202, 0.05, 1500, 1.41421],
        ['葡萄', 18, 45203, 0.75, 42.75, 1.73205],
        ['西瓜', 3, 45204, 1, 9999.99, 0.57721],
    ]);
    data.getRange('C2:C6').setNumberFormat('yyyy-mm-dd');
    data.getRange('D2:D6').setNumberFormat('0.00%');
    data.getRange('E2:E6').setNumberFormat('"¥"#,##0.00');
    data.getRange('F2:F6').setNumberFormat('0.000');

    // 公式：聚合、文本拼接、跨表引用、定义名称
    data.getRange('G2').setValue('=A2&"-"&B2');
    data.getRange('B7').setValue('=SUM(B2:B6)');
    data.getRange('B8').setValue('=AVERAGE(B2:B6)');
    wb.insertDefinedName('数量合计区', "'数据'!$B$2:$B$6");
    data.getRange('B9').setValue('=SUM(数量合计区)');

    // 富文本单元格
    const rich = editor.univerAPI.newRichText()
        .insertText('普通、')
        .insertText('加粗', { bl: 1 })
        .insertText('、')
        .insertText('红色斜体', { it: 1, cl: { rgb: '#dc2626' } });
    data.getRange('A10').setRichTextValueForCell(rich);

    // 各类样式
    data.getRange('A11').setValue('换行的长文本：用来验证单元格内自动换行与行高的保存');
    data.getRange('A11').setWrap(true);
    data.getRange('B11').setValue('旋转45°');
    data.getRange('B11').setTextRotation(45);
    data.getRange('C11').setValue('下划线');
    data.getRange('C11').setFontLine('underline');
    data.getRange('D11').setValue('删除线');
    data.getRange('D11').setFontLine('line-through');
    data.getRange('E11').setValue('大号字');
    data.getRange('E11').setFontSize(18);
    data.getRange('F11').setValue('宋体');
    data.getRange('F11').setFontFamily('SimSun');
    // Facade 的水平对齐只有 left/center/normal，右对齐用样式直接写：ht=3（右），vt=3（底）
    data.getRange('G11').setValue({ v: '右下对齐', s: { ht: 3, vt: 3 } });

    // 合并、行高列宽、隐藏行列、冻结
    data.getRange('A13:C14').merge();
    data.getRange('A13').setValue('合并单元格 A13:C14');
    data.setColumnWidth(0, 120);
    data.setRowHeight(13, 40);
    data.hideRows(15, 1);
    data.hideColumns(8, 1);
    data.setFrozenRows(1);
    data.setFrozenColumns(1);

    // 第二个工作表：跨表引用、标签颜色、隐藏网格线
    const summary = wb.insertSheet('汇总');
    summary.getRange('A1').setValue("=SUM('数据'!B2:B6)");
    summary.getRange('A2').setValue("='数据'!A2");
    summary.setTabColor('#16a34a');
    summary.setHiddenGridlines(true);

    // 第三个工作表：隐藏
    const hidden = wb.insertSheet('隐藏');
    hidden.getRange('A1').setValue('隐藏工作表中的内容');
    hidden.hideSheet();

    wb.setActiveSheet(data);
    await settle();
}

async function buildConditionalFormatting(editor: EditorHandle): Promise<void> {
    const ws = workbook(editor).getActiveSheet();
    ws.getRange('A1:E10').setValues(Array.from({ length: 10 }, (_, i) => [i + 1, (i + 1) * 3, 10 - i, i % 4, `项目${i % 3}`]));
    const add = (rule: { build(): ReturnType<ReturnType<FWorksheet['newConditionalFormattingRule']>['build']> }) =>
        ws.addConditionalFormattingRule(rule.build());
    add(ws.newConditionalFormattingRule().whenNumberGreaterThan(5).setRanges([ws.getRange('A1:A10').getRange()]).setBackground('#fde68a'));
    add(ws.newConditionalFormattingRule().setDataBar({ min: { type: 'min' as never }, max: { type: 'max' as never }, positiveColor: '#22c55e', nativeColor: '#ef4444', isGradient: true } as never).setRanges([ws.getRange('B1:B10').getRange()]));
    add(ws.newConditionalFormattingRule().setColorScale([
        { index: 0, color: '#f87171', value: { type: 'min' as never } },
        { index: 1, color: '#34d399', value: { type: 'max' as never } },
    ] as never).setRanges([ws.getRange('C1:C10').getRange()]));
    add(ws.newConditionalFormattingRule().whenFormulaSatisfied('=D1>1').setRanges([ws.getRange('D1:D10').getRange()]).setFontColor('#7c3aed').setBold(true));
    add(ws.newConditionalFormattingRule().whenTextContains('1').setRanges([ws.getRange('E1:E10').getRange()]).setItalic(true));
    add(ws.newConditionalFormattingRule().setDuplicateValues().setRanges([ws.getRange('D1:D10').getRange()]).setBackground('#bfdbfe'));
    await settle();
}

async function buildDataValidation(editor: EditorHandle): Promise<void> {
    const api = editor.univerAPI;
    const ws = workbook(editor).getActiveSheet();
    ws.getRange('A1:E1').setValues([['下拉', '复选框', '整数 1-100', '日期范围', '自定义公式']]);
    ws.getRange('A2:A10').setDataValidation(api.newDataValidation().requireValueInList(['是', '否', '待定']).build());
    ws.getRange('B2:B10').setDataValidation(api.newDataValidation().requireCheckbox().build());
    ws.getRange('C2:C10').setDataValidation(api.newDataValidation().requireNumberBetween(1, 100, true).build());
    ws.getRange('D2:D10').setDataValidation(api.newDataValidation().requireDateBetween(new Date(2026, 0, 1), new Date(2026, 11, 31)).build());
    ws.getRange('E2:E10').setDataValidation(api.newDataValidation().requireFormulaSatisfied('=LEN(E2)<=5').build());
    ws.getRange('A2:C3').setValues([['是', true, 50], ['否', false, 120]]);
    await settle();
}

async function buildFilter(editor: EditorHandle): Promise<void> {
    const ws = workbook(editor).getActiveSheet();
    const rows: (string | number)[][] = [['部门', '姓名', '金额']];
    for (let i = 0; i < 19; i++) rows.push([['研发', '市场', '运营'][i % 3], `员工${i + 1}`, (i + 1) * 100]);
    ws.getRange('A1:C20').setValues(rows);
    const filter = ws.getRange('A1:C20').createFilter();
    if (filter == null) throw new Error('创建筛选失败');
    filter.setColumnFilterCriteria(0, { colId: 0, filters: { filters: ['研发', '运营'] } });
    await settle();
}

async function buildHyperlink(editor: EditorHandle): Promise<void> {
    const wb = workbook(editor);
    const ws = wb.getActiveSheet();
    const target = wb.insertSheet('目标');
    target.getRange('B2').setValue('内部链接的目标');
    wb.setActiveSheet(ws);
    await ws.getRange('A1').setHyperLink('https://example.com/docs', '外部网页');
    await ws.getRange('A2').setHyperLink('mailto:someone@example.com', '发邮件');
    await ws.getRange('A3').setHyperLink(`#gid=${target.getSheetId()}`, '跳到另一个工作表');
    await ws.getRange('A4').setHyperLink(`#gid=${target.getSheetId()}&range=B2`, '跳到另一个工作表的单元格');
    await settle();
}

async function buildNote(editor: EditorHandle): Promise<void> {
    const ws = workbook(editor).getActiveSheet();
    ws.getRange('B2').setValue('有备注');
    ws.getRange('B2').createOrUpdateNote({ note: '这是一条普通备注', width: 200, height: 80 } as never);
    ws.getRange('D5').setValue('显示的备注');
    ws.getRange('D5').createOrUpdateNote({ note: '这条备注始终显示', width: 180, height: 60, show: true } as never);
    await settle();
}

async function buildDrawing(editor: EditorHandle): Promise<void> {
    const ws = workbook(editor).getActiveSheet();
    ws.getRange('A1').setValue('浮动图片与单元格图片');
    const floating = await ws.insertImage(BLUE, 2, 2);
    if (!floating) throw new Error('插入浮动图片失败');
    const cell = await ws.getRange('A3').insertCellImageAsync(ORANGE);
    if (!cell) throw new Error('插入单元格图片失败');
    await settle(1200);
}

async function buildProtection(editor: EditorHandle): Promise<void> {
    const ws = workbook(editor).getActiveSheet();
    ws.getRange('A1:B5').setValue('受保护区域');
    const permission = ws.getWorksheetPermission();
    await permission.protectRanges([{ ranges: [ws.getRange('A1:B5')], options: { name: '保护区域' } }] as never);
    const other = workbook(editor).insertSheet('整表保护');
    other.getRange('A1').setValue('整个工作表受保护');
    await other.getWorksheetPermission().protect();
    await settle();
}

async function buildAll(editor: EditorHandle): Promise<void> {
    // 综合样本：在同一个工作簿里依次叠加各个功能（不含保护）
    await buildCore(editor);
    const wb = workbook(editor);
    const features = wb.insertSheet('功能');
    wb.setActiveSheet(features);
    await buildConditionalFormatting(editor);
    features.getRange('G1:G10').setDataValidation(editor.univerAPI.newDataValidation().requireValueInList(['是', '否']).build());
    features.getRange('H1').setValue('备注在这里');
    features.getRange('H1').createOrUpdateNote({ note: '综合样本中的备注', width: 160, height: 60 } as never);
    await features.getRange('H2').setHyperLink(`#gid=${wb.getSheetByName('数据')!.getSheetId()}&range=A1`, '回到数据表');
    await features.getRange('H3').setHyperLink('https://example.com/all', '外部链接');
    await features.insertImage(BLUE, 9, 1);
    await features.getRange('H5').insertCellImageAsync(ORANGE);
    const filterSheet = wb.insertSheet('筛选');
    wb.setActiveSheet(filterSheet);
    await buildFilter(editor);
    wb.setActiveSheet(wb.getSheetByName('数据')!);
    await settle(1200);
}

export const sheetBuilders: Record<string, SampleBuilder> = {
    'sheet-core': buildCore,
    'sheet-cf': buildConditionalFormatting,
    'sheet-dv': buildDataValidation,
    'sheet-filter': buildFilter,
    'sheet-hyperlink': buildHyperlink,
    'sheet-note': buildNote,
    'sheet-drawing': buildDrawing,
    'sheet-protection': buildProtection,
    'sheet-all': buildAll,
};
