// 继续使用 P2 原有浏览器内计时口径；与真实 Safari 复用同一个无闭包函数。
import type { Page } from '@playwright/test'
import type { LocalSaveTiming, MeasuredEdit } from '../../../apps/web/src/editor/testing/local-save-timing.ts'
import type {} from './editor-probe.ts'
import { observeLocalSaveEdit } from '../../../apps/web/src/editor/testing/local-save-timing.ts'

export type { LocalSaveTiming, MeasuredEdit }

export async function measureLocalEdit(page: Page, edit: MeasuredEdit): Promise<LocalSaveTiming> {
  return page.evaluate(observeLocalSaveEdit, edit)
}
