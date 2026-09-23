// 样本文档：fixtures/<类型>/<名称>.json，按需加载。
const loaders = import.meta.glob<{ default: Record<string, unknown> }>('/fixtures/*/*.json');

export async function loadFixture(kind: 'sheet' | 'doc', name: string): Promise<Record<string, unknown>> {
    const loader = loaders[`/fixtures/${kind}/${name}.json`];
    if (loader == null) {
        throw new Error(`样本不存在：${kind}/${name}`);
    }
    const mod = await loader();
    // 深拷贝，避免 Univer 修改模块缓存中的对象。
    return structuredClone(mod.default);
}

export function listFixtures(): { kind: string; name: string }[] {
    return Object.keys(loaders).map((path) => {
        const [, , kind, file] = path.split('/');
        return { kind, name: file.replace(/\.json$/, '') };
    });
}
