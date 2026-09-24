import '../harness/events';

import { createRoot } from 'react-dom/client';
import { sheetBuilders } from '../experiments/v03-samples/sheet-builders';
import { p3SheetBuilders } from '../experiments/p3-samples/sheet-builders';
import { EditorShell } from '../host/EditorShell';
import { sheetProfile } from '../profiles/sheet';
import '../host/shell.css';
import type { ImageFunctionPolicy } from '../harness/image-function-policy';

// 公式 Worker：IMAGE() 的处理经 Worker 的 name 传入（P4）。每种写法都要是静态的 new Worker(new URL(...))，Vite 才会把它打包成 Worker。
const createWorker = ({ imageFunction }: { imageFunction: ImageFunctionPolicy }) => {
    if (imageFunction === 'off') return new Worker(new URL('../workers/sheet-formula.worker.ts', import.meta.url), { type: 'module', name: 'imagefn=off' });
    if (imageFunction === 'restricted') return new Worker(new URL('../workers/sheet-formula.worker.ts', import.meta.url), { type: 'module', name: 'imagefn=restricted' });
    return new Worker(new URL('../workers/sheet-formula.worker.ts', import.meta.url), { type: 'module' });
};

createRoot(document.getElementById('root')!).render(
    <EditorShell profile={sheetProfile} defaultSample="minimal" createWorker={createWorker} builders={{ ...sheetBuilders, ...p3SheetBuilders }} />,
);
