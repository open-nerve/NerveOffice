// P3 表格样本构建器（确定性，固定随机种子）：
// - big-1m / big-5m：按目标字节数生成的大表格（V06 打开静默、V08 捕获成本）；
// - perf-50k：5 万单元格 + 1,000 公式（V10 性能基线，00 号计划书 §12.1 的表格样本）；
// - formula-scenarios：依赖链、大范围聚合、跨表、慢计算、易变函数（V07）。
// 在空白样本上运行，生成后由验证脚本写入文档存储，不入库。
import type { ICellData, IObjectMatrixPrimitiveType } from '@univerjs/core';
import type { FWorkbook } from '@univerjs/sheets/facade';
import type { EditorHandle, SampleBuilder } from '../../harness/create-editor';

import { mulberry32, pick } from './random';

type CellMatrix = IObjectMatrixPrimitiveType<ICellData>;

const CATEGORIES = ['华东', '华南', '华北', '西南', '西北', '东北', '华中', '海外', '线上', '其他'];

function workbook(editor: EditorHandle): FWorkbook {
    const wb = editor.univerAPI.getActiveWorkbook();
    if (wb == null) throw new Error('没有活动的工作簿');
    return wb;
}

async function waitFormulas(editor: EditorHandle, timeout = 120_000): Promise<void> {
    await editor.univerAPI.getFormula().onCalculationResultApplied(timeout);
}

function removeSheet(wb: FWorkbook, name: string): void {
    const ws = wb.getSheetByName(name);
    if (ws != null) wb.deleteSheet(ws);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** 一行明细：编号、名称、类别，其余为数值；每 10 行最后一列是行合计公式。 */
function detailRow(r: number, cols: number, rand: () => number): Record<number, ICellData> {
    const row: Record<number, ICellData> = {
        0: { v: r },
        1: { v: `项目-${String(r).padStart(6, '0')}` },
        2: { v: pick(CATEGORIES, rand) },
    };
    for (let c = 3; c < cols - 1; c++) row[c] = { v: round2(rand() * 10_000) };
    const last = cols - 1;
    row[last] = r % 10 === 0 ? { f: `=SUM(D${r + 1}:${String.fromCharCode(65 + last - 1)}${r + 1})` } : { v: round2(rand() * 10_000) };
    return row;
}

/** 按目标字节数生成明细表：先估算每行的体积，再一次性插入工作表（InsertSheet 走 SDK 的命令）。 */
async function buildBig(editor: EditorHandle, targetBytes: number): Promise<void> {
    const wb = workbook(editor);
    const rand = mulberry32(20260924);
    const cols = 20;
    const cellData: CellMatrix = {};
    cellData[0] = Object.fromEntries(
        ['编号', '名称', '类别', ...Array.from({ length: cols - 4 }, (_, i) => `指标${i + 1}`), '合计'].map((v, c) => [c, { v, s: { bl: 1 } }]),
    );
    // 每行约 450 字节；留出工作簿其余部分的余量
    let bytes = JSON.stringify(cellData).length;
    let r = 1;
    while (bytes < targetBytes * 0.97) {
        const row = detailRow(r, cols, rand);
        cellData[r] = row;
        bytes += new TextEncoder().encode(JSON.stringify(row)).length + String(r).length + 4;
        r += 1;
    }
    wb.insertSheet('明细', { sheet: { rowCount: r + 100, columnCount: cols, cellData } });
    removeSheet(wb, '数据');
    await waitFormulas(editor);
}

/** 性能基线样本：数据 5,000 行 × 10 列（其中 600 个行合计公式）+ 汇总 400 个公式，共 1,000 个公式。 */
async function buildPerf50k(editor: EditorHandle): Promise<void> {
    const wb = workbook(editor);
    const rand = mulberry32(12);
    const rows = 5000;
    const data: CellMatrix = {
        0: Object.fromEntries(['编号', '名称', '类别', '销量', '单价', '成本', '费用', '退货', '库存', '合计'].map((v, c) => [c, { v, s: { bl: 1 } }])),
    };
    for (let r = 1; r <= rows; r++) {
        const row: Record<number, ICellData> = {
            0: { v: r },
            1: { v: `商品-${String(r).padStart(5, '0')}` },
            2: { v: CATEGORIES[r % CATEGORIES.length] },
        };
        for (let c = 3; c <= 8; c++) row[c] = { v: round2(rand() * 1000) };
        row[9] = r <= 600 ? { f: `=SUM(D${r + 1}:I${r + 1})` } : { v: round2(rand() * 6000) };
        data[r] = row;
    }
    wb.insertSheet('数据表', { sheet: { rowCount: rows + 200, columnCount: 12, cellData: data } });

    const ref = (col: string) => `'数据表'!$${col}$2:$${col}$${rows + 1}`;
    const summary: CellMatrix = {};
    // 分类统计：10 类 × 4 个公式 = 40
    CATEGORIES.forEach((cat, i) => {
        summary[i] = {
            0: { v: cat },
            1: { f: `=SUMIF(${ref('C')},A${i + 1},${ref('D')})` },
            2: { f: `=AVERAGEIF(${ref('C')},A${i + 1},${ref('E')})` },
            3: { f: `=COUNTIF(${ref('C')},A${i + 1})` },
            4: { f: `=MAXIFS(${ref('F')},${ref('C')},A${i + 1})` },
        };
    });
    // 列统计：6 列 × 10 个函数 = 60
    const fns = ['SUM', 'AVERAGE', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'STDEV', 'SUMSQ', 'COUNTA', 'PRODUCT'];
    ['D', 'E', 'F', 'G', 'H', 'I'].forEach((col, j) => {
        const row: Record<number, ICellData> = { 0: { v: `列 ${col}` } };
        fns.forEach((fn, k) => {
            // PRODUCT 只取前 10 行，避免溢出
            row[k + 1] = { f: fn === 'PRODUCT' ? `=PRODUCT('数据表'!$${col}$2:$${col}$11)` : `=${fn}(${ref(col)})` };
        });
        summary[12 + j] = row;
    });
    // 查找：300 个 VLOOKUP
    for (let k = 0; k < 300; k++) {
        const id = 1 + ((k * 16) % rows);
        summary[20 + k] = { 0: { v: id }, 1: { f: `=VLOOKUP(A${21 + k},'数据表'!$A$2:$J$${rows + 1},2,FALSE)` } };
    }
    wb.insertSheet('汇总', { sheet: { rowCount: 400, columnCount: 12, cellData: summary } });
    removeSheet(wb, '数据');
    await waitFormulas(editor);
}

/** V07 公式场景。输入单元格：链!A1、聚合!B1。 */
async function buildFormulaScenarios(editor: EditorHandle): Promise<void> {
    const wb = workbook(editor);
    const rand = mulberry32(7);

    const chain: CellMatrix = { 0: { 0: { v: 1 } } };
    for (let i = 1; i < 200; i++) chain[i] = { 0: { f: `=A${i}+1` } };
    wb.insertSheet('链', { sheet: { rowCount: 220, columnCount: 5, cellData: chain } });

    const agg: CellMatrix = {};
    for (let i = 0; i < 20_000; i++) agg[i] = { 1: { v: Math.floor(rand() * 1001) } };
    agg[0][2] = { f: '=SUM(B1:B20000)' };
    agg[1] = { ...agg[1], 2: { f: '=AVERAGE(B1:B20000)' } };
    agg[2] = { ...agg[2], 2: { f: '=COUNTIF(B1:B20000,">500")' } };
    agg[3] = { ...agg[3], 2: { f: '=MAX(B1:B20000)' } };
    wb.insertSheet('聚合', { sheet: { rowCount: 20_100, columnCount: 5, cellData: agg } });

    wb.insertSheet('跨表', {
        sheet: {
            rowCount: 20,
            columnCount: 5,
            cellData: {
                0: { 0: { f: "='链'!A200*2" } },
                1: { 0: { f: "=SUM('聚合'!B1:B20000)+'链'!A1" } },
                2: { 0: { f: "='聚合'!C1-'聚合'!B1" } },
            },
        },
    });

    const slow: CellMatrix = {};
    for (let i = 0; i < 200; i++) slow[i] = { 0: { f: `=SUMPRODUCT(('聚合'!$B$1:$B$20000>${i * 5})*'聚合'!$B$1:$B$20000)` } };
    wb.insertSheet('慢', { sheet: { rowCount: 220, columnCount: 5, cellData: slow } });

    wb.insertSheet('易变', {
        sheet: {
            rowCount: 20,
            columnCount: 5,
            cellData: {
                0: { 0: { f: '=NOW()' } },
                1: { 0: { f: '=TODAY()' } },
                2: { 0: { f: '=RAND()' } },
                3: { 0: { f: '=RANDBETWEEN(1,1000000)' } },
                4: { 0: { f: '=A3*2' } },
            },
        },
    });
    removeSheet(wb, '数据');
    await waitFormulas(editor);
}

export const p3SheetBuilders: Record<string, SampleBuilder> = {
    'big-1m': (editor) => buildBig(editor, 1024 * 1024),
    'big-5m': (editor) => buildBig(editor, 5 * 1024 * 1024),
    'perf-50k': buildPerf50k,
    'formula-scenarios': buildFormulaScenarios,
};
