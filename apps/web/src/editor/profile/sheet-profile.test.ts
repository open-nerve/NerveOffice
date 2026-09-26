import type { Univer } from '@univerjs/core'
import type { PluginEntry } from './plugin-entry.ts'
import { describe, expect, it, vi } from 'vitest'
import { formulaWorkerPluginEntries } from './formula-worker-profile.ts'
import { sheetEditMenuConfig } from './menu-config.ts'
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
  const entries = sheetPluginEntries({ container, formulaWorker })

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
})

describe('插件档案 sheet@1：影响数据的配置', () => {
  const entries = sheetPluginEntries({ container, formulaWorker })

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

  it('界面插件挂到给定的容器，菜单用编辑模式的隐藏配置', () => {
    const config = configOf(entries, 'UNIVER_UI_PLUGIN') as { container: unknown, menu: unknown }
    expect(config.container).toBe(container)
    expect(config.menu).toEqual(sheetEditMenuConfig())
  })

  it('其余插件使用默认配置', () => {
    const configured = new Set(['UNIVER_UI_PLUGIN', 'UNIVER_RPC_MAIN_THREAD_PLUGIN', 'UNIVER_ENGINE_FORMULA_PLUGIN', 'SHEET_PLUGIN', 'SHEETS_FORMULA_PLUGIN'])
    expect(entries.filter(entry => !configured.has(entry.plugin.pluginName) && entry.config !== undefined).map(entry => entry.plugin.pluginName)).toEqual([])
  })

  it('注册时把配置原样交给 Univer', () => {
    const registerPlugin = vi.fn<(plugin: PluginEntry['plugin'], config?: unknown) => void>()
    const univer = { registerPlugin } as unknown as Univer
    for (const entry of entries)
      entry.register(univer)
    expect(registerPlugin.mock.calls.map(([plugin, config]) => [plugin.pluginName, config])).toEqual(entries.map(entry => [entry.plugin.pluginName, entry.config]))
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
