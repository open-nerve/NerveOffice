import '../harness/events';

import { createRoot } from 'react-dom/client';
import { EditorShell } from '../host/EditorShell';
import { docCandidateProfile } from '../profiles/doc';
import '../host/shell.css';

const createWorker = () => new Worker(new URL('../workers/doc-layout.worker.ts', import.meta.url), { type: 'module' });

createRoot(document.getElementById('root')!).render(
    <EditorShell profile={docCandidateProfile} defaultSample="minimal" createWorker={createWorker} />,
);
