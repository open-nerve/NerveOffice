import '../harness/events';

import { createRoot } from 'react-dom/client';
import { sheetBuilders } from '../experiments/v03-samples/sheet-builders';
import { EditorShell } from '../host/EditorShell';
import { sheetProfile } from '../profiles/sheet';
import '../host/shell.css';

const createWorker = () => new Worker(new URL('../workers/sheet-formula.worker.ts', import.meta.url), { type: 'module' });

createRoot(document.getElementById('root')!).render(
    <EditorShell profile={sheetProfile} defaultSample="minimal" createWorker={createWorker} builders={sheetBuilders} />,
);
