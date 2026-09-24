// 阅读模式的候选实现（V09，Phase 文档 §3.3；审查后修订）。所有方案都拦截撤销与重做，默认清空撤销栈。
// - facade：00 号计划书 §6.5 的做法。表格 setEditable(false) + 每个工作表 setReadOnly()；1.0.0 要求先 protect()，会写保护规则；
//           文字文档 getPermission().setReadOnly()。
// - points：只设权限点，不创建任何规则。表格用 IPermissionService（内部 API）关掉工作表的编辑类权限点，保留"查看"与"复制"；
//           文字文档用公开的 getPermission().setReadOnly()（平台没有配置 objectPermissionTypes，它只设本地权限点，不写资源）。
// - firewall：BeforeCommandExecute 取消作用于本文档（或参数里没有 unitId）的非本地 mutation。
//             不能不看 unitId：单元格编辑器（内部文档单元）的同步也是非本地 mutation，挡住它会让之后的编辑写错内容（审查 R2）。
// - combined：points + firewall（P3 的推荐）。
// 原地进入时可以同时在运行时切换界面（ui: true）：隐藏工具栏、停用右键菜单、隐藏阅读模式专用的菜单项。
import type { IDisposable } from '@univerjs/core';
import type { EditorHandle } from './create-editor';

import { CommandType, IPermissionService, IUndoRedoService } from '@univerjs/core';
import { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, WorksheetCopyPermission, WorksheetViewPermission } from '@univerjs/sheets';
import { IContextMenuService, IMenuManagerService } from '@univerjs/ui';
import { SHEET_READ_MODE_RUNTIME_MENUS } from '../profiles/ui-config';

export type ReadStrategy = 'facade' | 'points' | 'firewall' | 'combined';

export const READ_STRATEGIES: readonly ReadStrategy[] = ['facade', 'points', 'firewall', 'combined'];

export interface ReadModeStep {
    step: string;
    ok: boolean;
    error?: string;
}

export interface ReadModeReport {
    strategy: ReadStrategy;
    steps: ReadModeStep[];
    /** 被拦截的撤销、重做与（firewall、combined 方案下）mutation。 */
    canceled: { id: string; kind: string; unitId?: string }[];
    undoStackAfterClear: { undos: number; redos: number };
}

export interface ReadModeHandle {
    report: ReadModeReport;
    /** 原地退出阅读模式（V09 比较"原地切换"与"销毁重建"）。 */
    exit(): Promise<ReadModeStep[]>;
}

type WorksheetPointCtor = new (unitId: string, subUnitId: string) => { id: string };

/** 阅读模式要关掉的工作表权限点：除"查看"与"复制"之外的全部（复制要求 WorksheetCopyPermission，审查 R6）。 */
function worksheetPointCtors(): WorksheetPointCtor[] {
    const keep = [WorksheetViewPermission, WorksheetCopyPermission] as unknown as WorksheetPointCtor[];
    const all = [...getAllWorksheetPermissionPoint(), ...getAllWorksheetPermissionPointByPointPanel()] as unknown as WorksheetPointCtor[];
    return [...new Set(all)].filter((ctor) => !keep.includes(ctor));
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
    /** 原地进入时在运行时切换界面：隐藏工具栏、停用右键菜单、隐藏阅读模式专用的菜单项（内部 API：IContextMenuService、IMenuManagerService）。 */
    ui?: boolean;
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

    if (strategy === 'facade' && editor.kind === 'sheet') {
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
    }
    if ((strategy === 'points' || strategy === 'combined') && editor.kind === 'sheet') {
        const wb = univerAPI.getActiveWorkbook()!;
        await run(steps, 'workbook.setEditable(false)', () => wb.setEditable(false));
        await run(steps, '工作表编辑类权限点 = false（本地，保留查看与复制）', () => {
            for (const subUnitId of sheetIds()) {
                for (const Ctor of worksheetPointCtors()) {
                    const point = new Ctor(unitId, subUnitId);
                    if (permissionService.getPermissionPoint(point.id) == null) permissionService.addPermissionPoint(point as never);
                    permissionService.updatePermissionPoint(point.id, false);
                }
            }
        });
    }
    if (strategy !== 'firewall' && editor.kind === 'doc') {
        // 公开 API；平台没有配置 objectPermissionTypes，它只设本地权限点，不写 DOC_OBJECT_PERMISSION_PLUGIN（P3 报告 §5.3）
        await run(steps, 'document.getPermission().setReadOnly()', () => univerAPI.getActiveDocument()!.getPermission().setReadOnly());
    }
    if (strategy === 'firewall' || strategy === 'combined') {
        disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (e) => {
            if (e.type !== CommandType.MUTATION || e.options?.onlyLocal === true) return;
            const target = (e.params as { unitId?: unknown } | undefined)?.unitId;
            if (typeof target === 'string' && target !== unitId) return;
            e.cancel = true;
            canceled.push({ id: e.id, kind: 'mutation', unitId: typeof target === 'string' ? target : undefined });
        }));
        steps.push({ step: 'BeforeCommandExecute：取消作用于本文档的非本地 mutation', ok: true });
    }

    // 运行时切换界面（原地进入时）
    const menuService = injector.get(IMenuManagerService);
    const contextMenu = injector.get(IContextMenuService);
    const runtimeMenus = editor.kind === 'sheet' ? SHEET_READ_MODE_RUNTIME_MENUS : [];
    if (options.ui) {
        await run(steps, '隐藏工具栏（setUIVisible）', () => univerAPI.setUIVisible(univerAPI.Enum.BuiltInUIPart.TOOLBAR, false));
        await run(steps, '停用右键菜单（IContextMenuService.disable）', () => contextMenu.disable());
        await run(steps, '隐藏阅读模式专用的菜单项（updateMenuConfig）', () =>
            menuService.updateMenuConfig(Object.fromEntries(runtimeMenus.map((id) => [id, { hidden: true }]))));
    }

    // 失去编辑权时清空撤销栈（00 号计划书 §6.5；Facade 没有暴露，通过注入器获取）
    const undoRedo = injector.get(IUndoRedoService);
    if (options.clearUndo !== false) undoRedo.clearUndoRedo(unitId);
    const undoStackAfterClear = undoRedo.getUndoRedoStatus(unitId);

    const report: ReadModeReport = { strategy, steps, canceled, undoStackAfterClear };

    const exit = async (): Promise<ReadModeStep[]> => {
        const exitSteps: ReadModeStep[] = [];
        if (strategy === 'facade' && editor.kind === 'sheet') {
            const wb = univerAPI.getActiveWorkbook()!;
            for (const ws of wb.getSheets()) {
                const permission = ws.getWorksheetPermission();
                await run(exitSteps, `${ws.getSheetName()}: unprotect()`, () => permission.unprotect());
            }
            await run(exitSteps, 'workbook.setEditable(true)', () => wb.setEditable(true));
        }
        if ((strategy === 'points' || strategy === 'combined') && editor.kind === 'sheet') {
            await run(exitSteps, '工作表编辑类权限点 = true（本地）', () => {
                for (const subUnitId of sheetIds()) {
                    for (const Ctor of worksheetPointCtors()) permissionService.updatePermissionPoint(new Ctor(unitId, subUnitId).id, true);
                }
            });
            await run(exitSteps, 'workbook.setEditable(true)', () => univerAPI.getActiveWorkbook()!.setEditable(true));
        }
        if (strategy !== 'firewall' && editor.kind === 'doc') {
            await run(exitSteps, 'document.getPermission().setEditable(true)', () => univerAPI.getActiveDocument()!.getPermission().setEditable(true));
        }
        if (options.ui) {
            await run(exitSteps, '显示工具栏', () => univerAPI.setUIVisible(univerAPI.Enum.BuiltInUIPart.TOOLBAR, true));
            await run(exitSteps, '启用右键菜单', () => contextMenu.enable());
            await run(exitSteps, '恢复阅读模式专用的菜单项', () =>
                menuService.updateMenuConfig(Object.fromEntries(runtimeMenus.map((id) => [id, { hidden: false }]))));
        }
        disposables.forEach((d) => d.dispose());
        disposables.length = 0;
        return exitSteps;
    };

    return { report, exit };
}
