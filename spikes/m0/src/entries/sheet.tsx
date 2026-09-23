import '../harness/events';

import { createRoot } from 'react-dom/client';
import { EditorShell } from '../host/EditorShell';
import { sheetCandidateProfile } from '../profiles/sheet';
import '../host/shell.css';

const createWorker = () => new Worker(new URL('../workers/sheet-formula.worker.ts', import.meta.url), { type: 'module' });

createRoot(document.getElementById('root')!).render(
    <EditorShell profile={sheetCandidateProfile} defaultSample="minimal" createWorker={createWorker} />,
);
