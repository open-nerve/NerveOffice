// 阅读模式的候选实现（V09，Phase 文档 §3.3）。三种方案都拦截撤销与重做，并清空撤销栈。
// - facade：00 号计划书 §6.5 的做法。表格 setEditable(false) + 每个工作表 setReadOnly()；1.0.0 要求先 protect()，会写保护规则；
//           文字文档 getPermission().setReadOnly()。
// - points：只在本地设置权限点（IPermissionService，内部 API），不创建任何规则。
// - firewall：兜底。BeforeCommandExecute 取消所有不带 onlyLocal 的 mutation，单独评估它能挡住哪些入口。
import type { IDisposable } from '@univerjs/core';
import type { EditorHandle } from './create-editor';

import { CommandType, IPermissionService, IUndoRedoService } from '@univerjs/core';
import { setDocumentPermissionValue } from '@univerjs/docs';
import { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, WorksheetViewPermission } from '@univerjs/sheets';

export type ReadStrategy = 'facade' | 'points' | 'firewall';

export const READ_STRATEGIES: readonly ReadStrategy[] = ['facade', 'points', 'firewall'];

/** @univerjs/protocol 的 UnitAction.Edit（验证工程没有直接依赖 protocol 包）。 */
const UNIT_ACTION_EDIT = 1;

export interface ReadModeStep {
    step: string;
    ok: boolean;
    error?: string;
}

export interface ReadModeReport {
    strategy: ReadStrategy;
    steps: ReadModeStep[];
    /** 被拦截的撤销、重做与（firewall 方案下）mutation。 */
    canceled: { id: string; kind: string }[];
    undoStackAfterClear: { undos: number; redos: number };
}

export interface ReadModeHandle {
    report: ReadModeReport;
    /** 原地退出阅读模式（V09 比较"原地切换"与"销毁重建"）。 */
    exit(): Promise<ReadModeStep[]>;
}

type WorksheetPointCtor = new (unitId: string, subUnitId: string) => { id: string };

function worksheetPointCtors(): WorksheetPointCtor[] {
    const all = [...getAllWorksheetPermissionPoint(), ...getAllWorksheetPermissionPointByPointPanel()] as unknown as WorksheetPointCtor[];
    return all.filter((ctor) => ctor !== (WorksheetViewPermission as unknown as WorksheetPointCtor));
}

async function run(steps: ReadModeStep[], step: string, fn: () => unknown): Promise<void> {
    try {
        await fn();
        steps.push({ step, ok: true });
    } catch (e) {
        steps.push({ step, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
}

export interface EnterReadModeOptions {
    /** 是否清空撤销栈（默认清空，00 号计划书 §6.5）。实验中关掉它，用来单独验证撤销重做的拦截。 */
    clearUndo?: boolean;
}

export async function enterReadMode(editor: EditorHandle, strategy: ReadStrategy, options: EnterReadModeOptions = {}): Promise<ReadModeHandle> {
    const { univerAPI, univer } = editor;
    const injector = univer.__getInjector();
    const permissionService = injector.get(IPermissionService);
    const steps: ReadModeStep[] = [];
    const canceled: ReadModeReport['canceled'] = [];
    const disposables: IDisposable[] = [];
    const unitId = editor.unitId();

    // 撤销与重做：重做会直接重放 mutation，绕过权限检查（00 号计划书 §6.5）
    disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeUndo, (e) => {
        e.cancel = true;
        canceled.push({ id: 'univer.command.undo', kind: 'command' });
    }));
    disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeRedo, (e) => {
        e.cancel = true;
        canceled.push({ id: 'univer.command.redo', kind: 'command' });
    }));

    const sheetIds = (): string[] => univerAPI.getActiveWorkbook()?.getSheets().map((s) => s.getSheetId()) ?? [];

    if (strategy === 'facade') {
        if (editor.kind === 'sheet') {
            const wb = univerAPI.getActiveWorkbook()!;
            await run(steps, 'workbook.setEditable(false)', () => wb.setEditable(false));
            for (const ws of wb.getSheets()) {
                const permission = ws.getWorksheetPermission();
                const before = steps.length;
                await run(steps, `${ws.getSheetName()}: setReadOnly()`, () => permission.setReadOnly());
                if (!steps[before].ok) {
                    // 1.0.0 要求先有工作表保护：按官方文档的顺序补上 protect()，再设只读
                    await run(steps, `${ws.getSheetName()}: protect()`, () => permission.protect());
                    await run(steps, `${ws.getSheetName()}: setReadOnly()（protect 之后）`, () => permission.setReadOnly());
                }
            }
        } else {
            const doc = univerAPI.getActiveDocument()!;
            await run(steps, 'document.getPermission().setReadOnly()', () => doc.getPermission().setReadOnly());
        }
    } else if (strategy === 'points') {
        if (editor.kind === 'sheet') {
            const wb = univerAPI.getActiveWorkbook()!;
            await run(steps, 'workbook.setEditable(false)', () => wb.setEditable(false));
            await run(steps, '工作表编辑类权限点 = false（本地）', () => {
                for (const subUnitId of sheetIds()) {
                    for (const Ctor of worksheetPointCtors()) {
                        const point = new Ctor(unitId, subUnitId);
                        if (permissionService.getPermissionPoint(point.id) == null) permissionService.addPermissionPoint(point as never);
                        permissionService.updatePermissionPoint(point.id, false);
                    }
                }
            });
        } else {
            await run(steps, '文档编辑权限点 = false（本地）', () => setDocumentPermissionValue(permissionService, unitId, unitId, UNIT_ACTION_EDIT as never, false));
        }
    } else {
        disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (e) => {
            if (e.type === CommandType.MUTATION && e.options?.onlyLocal !== true) {
                e.cancel = true;
                canceled.push({ id: e.id, kind: 'mutation' });
            }
        }));
        steps.push({ step: 'BeforeCommandExecute：取消非本地 mutation', ok: true });
    }

    // 失去编辑权时清空撤销栈（00 号计划书 §6.5；Facade 没有暴露，通过注入器获取）
    const undoRedo = injector.get(IUndoRedoService);
    if (options.clearUndo !== false) undoRedo.clearUndoRedo(unitId);
    const undoStackAfterClear = undoRedo.getUndoRedoStatus(unitId);

    const report: ReadModeReport = { strategy, steps, canceled, undoStackAfterClear };

    const exit = async (): Promise<ReadModeStep[]> => {
        const exitSteps: ReadModeStep[] = [];
        if (strategy === 'facade') {
            if (editor.kind === 'sheet') {
                const wb = univerAPI.getActiveWorkbook()!;
                for (const ws of wb.getSheets()) {
                    const permission = ws.getWorksheetPermission();
                    await run(exitSteps, `${ws.getSheetName()}: unprotect()`, () => permission.unprotect());
                }
                await run(exitSteps, 'workbook.setEditable(true)', () => wb.setEditable(true));
            } else {
                await run(exitSteps, 'document.getPermission().setEditable(true)', () => univerAPI.getActiveDocument()!.getPermission().setEditable(true));
            }
        } else if (strategy === 'points') {
            if (editor.kind === 'sheet') {
                await run(exitSteps, '工作表编辑类权限点 = true（本地）', () => {
                    for (const subUnitId of sheetIds()) {
                        for (const Ctor of worksheetPointCtors()) permissionService.updatePermissionPoint(new Ctor(unitId, subUnitId).id, true);
                    }
                });
                await run(exitSteps, 'workbook.setEditable(true)', () => univerAPI.getActiveWorkbook()!.setEditable(true));
            } else {
                await run(exitSteps, '文档编辑权限点 = true（本地）', () => setDocumentPermissionValue(permissionService, unitId, unitId, UNIT_ACTION_EDIT as never, true));
            }
        }
        disposables.forEach((d) => d.dispose());
        disposables.length = 0;
        return exitSteps;
    };

    return { report, exit };
}
