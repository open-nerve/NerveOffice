// 文档所在的空间在界面上的名字（M2-P5 设计 §3.5）：搜索结果与"与我共享"共用（契约的 spaceIdentitySchema）。
// 只由按需加载的页面引用，按路径引用（不经 shared/ui 的桶文件），不进首屏。
import type { SpaceIdentity } from '@nerve-office/contracts'
import { messages } from '../i18n/index.ts'
import { PersonName } from './person-name.tsx'
import { Phrase } from './phrase.tsx'

interface SpaceLabelProps {
  readonly space: SpaceIdentity
  /** 看的人：所有者是他自己的个人空间写"我的空间"；会话还没有加载好时为 undefined（按别人的个人空间呈现） */
  readonly viewerId: string | undefined
}

/**
 * - 团队空间：名称（<bdi> 隔离，从右到左的名称不打乱旁边的字）；
 * - 自己的个人空间："我的空间"；
 * - 别人的个人空间：所有者的人名（人名组件，登录名在前）加"的个人空间"。有了单独授权，别人的个人空间里的文档也会出现在这两处，
 *   不能再一律当成"我的空间"；个人空间存的名称是所有者建号时的显示名、可以伪造（规范 §2.4），契约里根本不给
 */
export function SpaceLabel({ space, viewerId }: SpaceLabelProps) {
  if (space.type === 'team')
    return <bdi>{space.name}</bdi>
  if (space.owner.id === viewerId)
    return messages.documents.title
  return <Phrase parts={messages.spaces.personalSpaceOf(<PersonName person={space.owner} />)} />
}
