import type { DocumentDataModel } from '@univerjs/core'
import { DrawingTypeEnum, ICommandService, ImageSourceType, LocaleType, ObjectRelativeFromH, ObjectRelativeFromV, PositionedObjectLayoutType, Univer, UniverInstanceType } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsPlugin } from '@univerjs/docs'
import { InsertDocDrawingCommand, UniverDocsDrawingPlugin } from '@univerjs/docs-drawing'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { expect, it } from 'vitest'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { installEntryGuards } from '../profile/entry-guards.ts'
import { injectorOf } from './injector.ts'

it('真实文档图片命令可写进内部文档；入口守卫在 handler 前阻止此未支持路径', async () => {
  for (const guarded of [false, true]) {
    const univer = new Univer({ locale: LocaleType.ZH_CN, override: editorIdentityOverride('edit') })
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverDocsDrawingPlugin)
    const api = FUniver.newAPI(univer)
    const guard = guarded ? installEntryGuards(api) : undefined
    try {
      const doc = univer.createUnit<unknown, DocumentDataModel>(UniverInstanceType.UNIVER_DOC, { id: 'inner-doc', body: { dataStream: '\r\n', paragraphs: [{ startIndex: 0 }] } })
      const before = structuredClone(doc.getSnapshot())
      const result = await injectorOf(univer).get(ICommandService).executeCommand(InsertDocDrawingCommand.id, {
        unitId: 'inner-doc',
        textRange: { startOffset: 0, endOffset: 0 },
        drawings: [{ unitId: 'inner-doc', subUnitId: 'inner-doc', drawingId: 'image', drawingType: DrawingTypeEnum.DRAWING_IMAGE, source: '/api/assets/11111111-1111-4111-8111-111111111111', imageSourceType: ImageSourceType.URL, layoutType: PositionedObjectLayoutType.INLINE, docTransform: { size: { width: 100, height: 100 }, angle: 0, positionH: { relativeFrom: ObjectRelativeFromH.PAGE }, positionV: { relativeFrom: ObjectRelativeFromV.PAGE } } }],
      })
      expect(result).toBe(!guarded)
      if (guarded)
        expect(doc.getSnapshot()).toEqual(before)
      else
        expect(doc.getSnapshot().drawings?.image).toHaveProperty('source', '/api/assets/11111111-1111-4111-8111-111111111111')
    }
    finally {
      guard?.dispose()
      univer.dispose()
    }
  }
})
