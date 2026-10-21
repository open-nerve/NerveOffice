// 普通/富文本链接的写命令取实际 SDK 标识；参数地址路径在平台策略中逐项核对。
import { AddHyperLinkCommand, AddRichHyperLinkCommand, UpdateHyperLinkCommand, UpdateRichHyperLinkCommand } from '@univerjs/sheets-hyper-link'

export const LINK_INPUT_COMMANDS = Object.freeze({
  add: AddHyperLinkCommand.id,
  addRich: AddRichHyperLinkCommand.id,
  update: UpdateHyperLinkCommand.id,
  updateRich: UpdateRichHyperLinkCommand.id,
})
