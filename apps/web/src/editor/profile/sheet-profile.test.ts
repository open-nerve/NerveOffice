import type { Univer } from '@univerjs/core'
import type { PluginEntry } from './plugin-entry.ts'
import { DOCUMENT_PROFILE_OF, profileResourceNames } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { formulaWorkerPluginEntries } from './formula-worker-profile.ts'
import { sheetMenuConfig } from './menu-config.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS, declaredSheetResources, SHEET_PLUGIN_GROUPS, SHEET_PROFILE_ID, sheetPluginEntries } from './sheet-profile.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：数据验证的界面包在模块求值时就创建它。这里只展开档案，不运行 Univer
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const container = document.createElement('div')
const formulaWorker = {} as Worker

function names(entries: readonly PluginEntry[]): string[] {
  return entries.map(entry => entry.plugin.pluginName)
}

function configOf(entries: readonly PluginEntry[], pluginName: string): unknown {
  const entry = entries.find(candidate => candidate.plugin.pluginName === pluginName)
  if (entry === undefined)
    throw new Error(`档案里没有 ${pluginName}`)
  return entry.config
}

describe('插件档案 sheet@1：注册顺序（插件档案 v1 §1，公式在 Worker 里计算）', () => {
  const entries = sheetPluginEntries({ container, formulaWorker, access: 'edit' })

  it('按组注册，组内与组间的顺序按官方 preset', () => {
    expect(SHEET_PROFILE_ID).toBe('sheet@1')
    expect(SHEET_PLUGIN_GROUPS.map(group => group.id)).toEqual(['core', 'numfmt', 'formula', 'drawing', 'cf', 'filter', 'hyperlink', 'dv', 'find-replace', 'note', 'sort'])
    expect(names(entries)).toEqual([
      // core：Docs、RenderEngine、UI、DocsUI、RPCMainThread、FormulaEngine、Sheets、SheetsUI
      'DOCS_PLUGIN',
      'UNIVER_RENDER_ENGINE_PLUGIN',
      'UNIVER_UI_PLUGIN',
      'DOC_UI_PLUGIN',
      'UNIVER_RPC_MAIN_THREAD_PLUGIN',
      'UNIVER_ENGINE_FORMULA_PLUGIN',
      'SHEET_PLUGIN',
      'SHEET_UI_PLUGIN',
      'SHEET_NUMFMT_PLUGIN',
      'SHEET_NUMFMT_UI_PLUGIN',
      'SHEETS_FORMULA_PLUGIN',
      'SHEET_FORMULA_UI_PLUGIN',
      // drawing：Drawing、DocsDrawing、DrawingUI、SheetsDrawing、SheetsDrawingUI
      'UNIVER_DRAWING_PLUGIN',
      'DOC_DRAWING_PLUGIN',
      'UNIVER_DRAWING_UI_PLUGIN',
      'SHEET_DRAWING_PLUGIN',
      'SHEET_IMAGE_UI_PLUGIN',
      'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
      'SHEET_CONDITIONAL_FORMATTING_PLUGIN_UI_PLUGIN',
      'SHEET_FILTER_PLUGIN',
      'SHEET_FILTER_UI_PLUGIN',
      'SHEET_HYPER_LINK_PLUGIN',
      'SHEET_HYPER_LINK_UI_PLUGIN',
      'UNIVER_DATA_VALIDATION_PLUGIN',
      'SHEET_DATA_VALIDATION_PLUGIN',
      'SHEET_DATA_VALIDATION_UI_PLUGIN',
      'UNIVER_FIND_REPLACE_PLUGIN',
      'SHEET_FIND_REPLACE_PLUGIN',
      'SHEET_NOTE_PLUGIN',
      'SHEET_NOTE_UI_PLUGIN',
      'SHEET_SORT_PLUGIN',
      'SHEET_SORT_UI_PLUGIN',
    ])
  })

  it('不注册网络、遥测、评论、水印、表格 table、十字高亮等（插件档案 v1 §1"不注册"）', () => {
    expect(names(entries).filter(name => /NETWORK|TELEMETRY|COMMENT|WATERMARK|TABLE|CROSSHAIR|ACTION_RECORDER|SLIDE/i.test(name))).toEqual([])
    expect(new Set(names(entries)).size).toBe(entries.length)
  })

  it('只读时注册的插件与顺序相同：打开方式只影响界面的配置', () => {
    expect(names(sheetPluginEntries({ container, formulaWorker, access: 'read' }))).toEqual(names(entries))
  })
})

describe.each(['edit', 'read'] as const)('插件档案 sheet@1：影响数据的配置（access = %s，两种方式相同）', (access) => {
  const entries = sheetPluginEntries({ container, formulaWorker, access })

  it('公式在 Worker 里计算：主线程的引擎、表格与表格公式都不执行公式，RPC 插件拿到传入的 Worker 实例', () => {
    expect(configOf(entries, 'UNIVER_ENGINE_FORMULA_PLUGIN')).toEqual({ notExecuteFormula: true })
    expect(configOf(entries, 'SHEETS_FORMULA_PLUGIN')).toEqual({ notExecuteFormula: true })
    expect((configOf(entries, 'UNIVER_RPC_MAIN_THREAD_PLUGIN') as { workerURL: unknown }).workerURL).toBe(formulaWorker)
  })

  it('表格插件关掉大表操作的拆分，不写 onlyRegisterFormulaRelatedMutations（它的类型只允许 true）', () => {
    expect(configOf(entries, 'SHEET_PLUGIN')).toStrictEqual({
      notExecuteFormula: true,
      largeSheetOperation: { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER },
    })
  })

  it('注册时把配置原样交给 Univer', () => {
    const registerPlugin = vi.fn<(plugin: PluginEntry['plugin'], config?: unknown) => void>()
    const univer = { registerPlugin } as unknown as Univer
    for (const entry of entries)
      entry.register(univer)
    expect(registerPlugin.mock.calls.map(([plugin, config]) => [plugin.pluginName, config])).toEqual(entries.map(entry => [entry.plugin.pluginName, entry.config]))
  })
})

describe('插件档案 sheet@1：界面的配置按打开方式（插件档案 v1 §5.2，M2-P3 设计 §3.4）', () => {
  /** 数据相关的配置之外，只有界面插件与表格界面插件按打开方式配置 */
  const DATA_CONFIGURED = ['UNIVER_RPC_MAIN_THREAD_PLUGIN', 'UNIVER_ENGINE_FORMULA_PLUGIN', 'SHEET_PLUGIN', 'SHEETS_FORMULA_PLUGIN']

  function otherConfigured(entries: readonly PluginEntry[], configured: readonly string[]): string[] {
    return entries.filter(entry => !configured.includes(entry.plugin.pluginName) && entry.config !== undefined).map(entry => entry.plugin.pluginName)
  }

  it('能编辑：界面插件挂到给定的容器，菜单只隐藏两种方式都隐藏的；工具栏、右键菜单与底栏都用默认配置', () => {
    const entries = sheetPluginEntries({ container, formulaWorker, access: 'edit' })
    expect(configOf(entries, 'UNIVER_UI_PLUGIN')).toStrictEqual({ container, menu: sheetMenuConfig('edit') })
    expect(configOf(entries, 'SHEET_UI_PLUGIN')).toBeUndefined()
    expect(otherConfigured(entries, [...DATA_CONFIGURED, 'UNIVER_UI_PLUGIN'])).toEqual([])
  })

  it('只读：关掉工具栏与右键菜单，保留编辑栏（header 不写，用默认的显示）；菜单另外隐藏工作表标签的 5 项', () => {
    const entries = sheetPluginEntries({ container, formulaWorker, access: 'read' })
    expect(configOf(entries, 'UNIVER_UI_PLUGIN')).toStrictEqual({ container, menu: sheetMenuConfig('read'), toolbar: false, contextMenu: false })
  })

  it('只读：底栏只关掉菜单（网格线开关会写进快照）与新增工作表按钮，工作表标签、统计栏与缩放保持默认', () => {
    const entries = sheetPluginEntries({ container, formulaWorker, access: 'read' })
    expect(configOf(entries, 'SHEET_UI_PLUGIN')).toStrictEqual({ footer: { menus: false, addSheetButtonConfig: { show: false } } })
    expect(otherConfigured(entries, [...DATA_CONFIGURED, 'UNIVER_UI_PLUGIN', 'SHEET_UI_PLUGIN'])).toEqual([])
  })
})

describe('插件档案 sheet@1：声明的资源（插件档案 v1 §3，去掉 SHEET_AuthzIoMockService_PLUGIN）', () => {
  it('各组声明的资源', () => {
    expect(Object.fromEntries(SHEET_PLUGIN_GROUPS.map(group => [group.id, [...group.resources].sort()]))).toEqual({
      'core': ['SHEET_DEFINED_NAME_PLUGIN', 'SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_RANGE_THEME_MODEL_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN'],
      'numfmt': [],
      'formula': [],
      'drawing': ['SHEET_DRAWING_PLUGIN'],
      'cf': ['SHEET_CONDITIONAL_FORMATTING_PLUGIN'],
      'filter': ['SHEET_FILTER_PLUGIN'],
      'hyperlink': [],
      'dv': ['SHEET_DATA_VALIDATION_PLUGIN'],
      'find-replace': [],
      'note': ['SHEET_NOTE_PLUGIN'],
      'sort': [],
    })
  })

  it('合起来是 10 项，按名称排序，没有本地授权服务的资源', () => {
    const declared = declaredSheetResources()
    expect(declared).toHaveLength(10)
    expect(declared).toEqual([...declared].sort())
    expect(declared).not.toContain('SHEET_AuthzIoMockService_PLUGIN')
  })

  it('M3-P3：档案注册的插件声明的资源 = contracts 的白名单（服务端的快照检查按它核对资源名，设计 §3.2）', () => {
    expect(SHEET_PROFILE_ID).toBe(DOCUMENT_PROFILE_OF.sheet)
    expect(declaredSheetResources()).toEqual(profileResourceNames(SHEET_PROFILE_ID))
    // 一项资源只由一组声明
    const all = SHEET_PLUGIN_GROUPS.flatMap(group => group.resources)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('公式 Worker 的插件（与官方 Worker preset 相同）', () => {
  it('Sheets（只注册公式相关的 mutation）、FormulaEngine、RPCWorkerThread、RemoteSheetsFormula、SheetsFilter', () => {
    const entries = formulaWorkerPluginEntries()
    expect(names(entries)).toEqual(['SHEET_PLUGIN', 'UNIVER_ENGINE_FORMULA_PLUGIN', 'UNIVER_RPC_WORKER_THREAD_PLUGIN', 'SHEET_FORMULA_REMOTE_PLUGIN', 'SHEET_FILTER_PLUGIN'])
    expect(entries.map(entry => entry.config)).toEqual([{ onlyRegisterFormulaRelatedMutations: true }, undefined, undefined, undefined, undefined])
  })
})

describe('变更检测的排除名单（插件档案 v1 §5.3）', () => {
  it('只有清除图片变换框的那一条', () => {
    expect(CHANGE_DETECTION_EXCLUDED_MUTATIONS).toEqual(['sheet.operation.clear-drawing-transformer'])
  })
})
