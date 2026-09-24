// 菜单审计（V09）：遍历菜单服务中各位置的菜单项，读出当前的隐藏与禁用状态（内部 API，只用于验证）。
// 右键菜单的 DOM 不带命令 id，所以在服务层核对；工具栏另在 DOM 中按 data-u-command 核对。
import type { Univer } from '@univerjs/core';
import type { Observable } from 'rxjs';

import { IMenuManagerService } from '@univerjs/ui';

export interface MenuAuditItem {
    id: string;
    path: string;
    hidden: boolean | null;
    disabled: boolean | null;
}

const POSITIONS = ['ribbon', 'contextMenu', 'floatingObjectToolbar.sheet', 'floatingObjectToolbar.doc'];

interface SchemaNode {
    key: string;
    item?: { id: string; hidden$?: Observable<boolean>; disabled$?: Observable<boolean> };
    children?: SchemaNode[];
}

/** 读出 BehaviorSubject 一类可观察对象的当前值（订阅时同步发出）；不同步发出则为 null。 */
function current(value$: Observable<boolean> | undefined): boolean | null {
    if (value$ == null) return null;
    let value: boolean | null = null;
    value$.subscribe((x) => { value = x; }).unsubscribe();
    return value;
}

export function auditMenus(univer: Univer): MenuAuditItem[] {
    const menus = univer.__getInjector().get(IMenuManagerService);
    const out: MenuAuditItem[] = [];
    const walk = (nodes: SchemaNode[], path: string) => {
        for (const node of nodes) {
            const p = `${path}/${node.key}`;
            if (node.item != null) out.push({ id: node.item.id, path: p, hidden: current(node.item.hidden$), disabled: current(node.item.disabled$) });
            if (node.children != null) walk(node.children, p);
        }
    };
    for (const key of POSITIONS) walk(menus.getMenuByPositionKey(key) as unknown as SchemaNode[], key);
    return out;
}
