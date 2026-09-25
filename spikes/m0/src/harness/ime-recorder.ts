// 输入法记录页（P5，页面参数 imelog=1）：无头浏览器无法驱动系统输入法，真实 Safari 与 Chrome 的输入法事件由人工输入、页面记录。
// 记录隐藏输入元素上的键盘、输入与组合事件，以及每次提交、撤销、重做之后的正文；显示操作清单，定时交回验证服务（/__imelog）。
// 记录的事件序列用于核对 WebKit 的提交顺序，并由 e2e 的合成驱动回放（P5 报告附录）。
import type { IDisposable } from '@univerjs/core';
import type { EditorHandle } from './create-editor';

export interface ImeLogEvent {
    /** 距开始记录的毫秒数。 */
    t: number;
    type: string;
    target: string;
    key?: string;
    code?: string;
    keyCode?: number;
    isComposing?: boolean;
    inputType?: string;
    data?: string | null;
    trusted: boolean;
    meta?: boolean;
    shift?: boolean;
}

export interface ImeLogCheckpoint {
    t: number;
    reason: string;
    text: string;
    paragraphs: number;
    undo: { undos: number; redos: number };
}

export interface ImeLog {
    session: string;
    userAgent: string;
    url: string;
    startedAt: string;
    events: ImeLogEvent[];
    checkpoints: ImeLogCheckpoint[];
}

const STEPS = [
    '把系统输入法切换到"简体拼音"。',
    '点击正文末尾，输入 nihao，按空格上屏。留意候选框是否贴着正在输入的文字。',
    '按 ⌘Z 撤销一次，再按 ⇧⌘Z 重做一次。',
    '输入 zhongwenshuru，按空格上屏（整句）。',
    '拖选刚输入的两个字，输入 tihuan，按空格上屏（替换选中的文字）。',
    '输入中文逗号与句号。',
    '在中文标点状态下按 / 键（得到顿号），再按 Shift 切到英文标点后按 / 键。',
    '输入 ceshi 后按 Esc 取消；再输入 ceshi 后按 Shift 切换中英文；再输入 ceshi 后点一下工具栏（焦点切走）。',
    '（如已安装五笔）切换到五笔，输入 a 加空格，再输入 khlg。',
    '点"上传记录"。换另一个浏览器（Safari / Chrome）重复一遍。',
];

const TYPES = ['keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'] as const;

export function installImeRecorder(editor: EditorHandle): IDisposable {
    const t0 = performance.now();
    const log: ImeLog = {
        session: `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
        userAgent: navigator.userAgent,
        url: location.href,
        startedAt: new Date().toISOString(),
        events: [],
        checkpoints: [],
    };
    const now = () => Math.round((performance.now() - t0) * 10) / 10;

    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed', right: '12px', bottom: '40px', width: '360px', zIndex: '3000', background: '#fffbe6',
        border: '1px solid #d4b106', borderRadius: '6px', padding: '10px', font: '12px/1.6 sans-serif', color: '#333',
    });
    const title = document.createElement('div');
    title.textContent = '输入法记录（P5）';
    title.style.fontWeight = 'bold';
    const list = document.createElement('ol');
    list.style.margin = '6px 0';
    list.style.paddingLeft = '18px';
    for (const s of STEPS) {
        const li = document.createElement('li');
        li.textContent = s;
        list.append(li);
    }
    const status = document.createElement('div');
    const last = document.createElement('div');
    last.style.whiteSpace = 'pre-wrap';
    last.style.maxHeight = '80px';
    last.style.overflow = 'auto';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '上传记录';
    button.dataset.testid = 'imelog-upload';
    panel.append(title, list, status, last, button);
    document.body.append(panel);

    const docText = () => {
        const doc = editor.univerAPI.getActiveDocument();
        const body = doc?.getBody();
        return { text: (body?.dataStream ?? '').replace(/\r\n$/, '').slice(0, 500), paragraphs: body?.paragraphs?.length ?? 0 };
    };
    const checkpoint = (reason: string) => {
        setTimeout(() => {
            log.checkpoints.push({ t: now(), reason, ...docText(), undo: editor.undoStatus() });
            refresh();
        }, 400);
    };
    const refresh = () => {
        const compositions = log.events.filter((e) => e.type === 'compositionstart').length;
        status.textContent = `事件 ${log.events.length}，组合 ${compositions}，检查点 ${log.checkpoints.length}`;
        last.textContent = log.checkpoints.length > 0 ? `最近：${log.checkpoints[log.checkpoints.length - 1].text.slice(-60)}` : '';
    };
    const upload = async () => {
        try {
            const res = await fetch('/__imelog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(log) });
            button.textContent = res.ok ? `已上传（${new Date().toLocaleTimeString()}）` : `上传失败：${res.status}`;
        } catch (error) {
            button.textContent = `上传失败：${error instanceof Error ? error.message : String(error)}`;
        }
    };
    button.addEventListener('click', () => void upload());

    const listeners: [string, (e: Event) => void][] = TYPES.map((type) => [type, (e: Event) => {
        const target = e.target as HTMLElement | null;
        const isEditor = target?.id?.startsWith('__editor_') === true;
        const k = e as KeyboardEvent;
        // 键盘事件只记编辑器上的，以及带 ⌘ / Ctrl 的快捷键（撤销、重做）
        if (!isEditor && !(e.type.startsWith('key') && (k.metaKey || k.ctrlKey))) return;
        const ie = e as InputEvent;
        const ce = e as CompositionEvent;
        log.events.push({
            t: now(),
            type: e.type,
            target: target?.id || target?.tagName || '',
            key: k.key,
            code: k.code,
            keyCode: k.keyCode,
            isComposing: (k.isComposing ?? ie.isComposing) as boolean | undefined,
            inputType: ie.inputType,
            data: e.type.startsWith('composition') ? ce.data : ie.data,
            trusted: e.isTrusted,
            meta: k.metaKey,
            shift: k.shiftKey,
        });
        if (e.type === 'compositionend') checkpoint('compositionend');
        if (e.type === 'keydown' && (k.metaKey || k.ctrlKey) && k.key.toLowerCase() === 'z') checkpoint(k.shiftKey ? 'redo' : 'undo');
        refresh();
    }]);
    for (const [type, fn] of listeners) document.addEventListener(type, fn, true);
    const timer = setInterval(() => void upload(), 5000);
    checkpoint('start');

    return {
        dispose: () => {
            clearInterval(timer);
            for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
            panel.remove();
        },
    };
}
