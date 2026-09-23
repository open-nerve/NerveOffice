import { createRoot } from 'react-dom/client';
import { listFixtures } from '../harness/fixtures';
import '../host/shell.css';

function Launcher() {
    const fixtures = listFixtures();
    return (
        <main className="m0-launcher">
            <h1>M0 技术验证</h1>
            <p>验证代码，不进入生产构建。每个编辑器页面整页加载、一页一份文档。</p>
            <ul>
                {fixtures.map(({ kind, name }) => (
                    <li key={`${kind}/${name}`}>
                        {kind}/{name}：
                        <a href={`/${kind}.html?sample=${name}`}>编辑</a>
                        {' · '}
                        <a href={`/${kind}.html?sample=${name}&worker=1`}>编辑（Worker）</a>
                    </li>
                ))}
            </ul>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Launcher />);
