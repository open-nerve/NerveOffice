// 嵌着别的内容的句子（shared/i18n 的 Phrase）：例如"已选择：<人名>"，人名要用 PersonName 呈现，不能先拼成一个字符串（M2-P6 复核 M2）。
import type { ReactNode } from 'react'
import { createElement } from 'react'

/**
 * 按顺序渲染句子的各段：文字原样，嵌进来的元素（人名等）照常渲染。
 * 整句包在一个行内的 <span> 里：句子常常放在 flex 的按钮、标签里，各段要是各自成为 flex 的子项，就会被 gap 拉开，
 * 浏览器算可读名称时也会在它们之间加空格（"账户： @amy 艾米"）。
 * 各段作为子元素逐个传入（不是一个数组）：它们是固定的几段，不是列表，不需要 key
 */
export function Phrase({ parts }: { readonly parts: readonly ReactNode[] }) {
  return createElement('span', null, ...parts)
}
