import '../harness/events';

import { createRoot } from 'react-dom/client';
import { docBuilders } from '../experiments/v03-samples/doc-builders';
import { EditorShell } from '../host/EditorShell';
import { docProfile } from '../profiles/doc';
import '../host/shell.css';

const createWorker = () => new Worker(new URL('../workers/doc-layout.worker.ts', import.meta.url), { type: 'module' });

createRoot(document.getElementById('root')!).render(
    <EditorShell profile={docProfile} defaultSample="minimal" createWorker={createWorker} builders={docBuilders} />,
);
