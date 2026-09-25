export type EditorMode = 'edit' | 'read';

export interface PageParams {
    sample: string;
    /** 从验证服务的文档存储加载（优先于 sample）。 */
    doc?: string;
    /** 去掉的插件组。 */
    without: string[];
    /** 覆盖样本的 unitId（只用于从空白样本生成新样本，此时还没有任何资源引用它）。 */
    unit?: string;
    /** 启用资源加载错误捕获（V04）。 */
    guard: boolean;
    mode: EditorMode;
    /** 阅读模式的方案（V09）：facade / points / firewall。 */
    ro: string;
    /** 公式计算模式：forced 表示打开时强制重算全部公式（V07 的基准）。 */
    calc: 'default' | 'forced';
    /** 大表操作拆分：split=0 关掉（V06）。 */
    split: boolean;
    /** 公式引擎每执行多少个公式让出一次主线程（interval=N；缺省用 SDK 的 500，V10 比较让出间隔）。 */
    interval?: number;
    /** 图片服务（P4）：default 为 SDK 的默认实现（图片读成 data URL）；platform 为上传到平台、只存同源地址，并安装粘贴钩子与命令守卫。 */
    img: 'default' | 'platform';
    /** IMAGE() 公式的处理（P4）：default、off（反注册）、restricted（只允许平台资源地址）。 */
    imagefn: 'default' | 'off' | 'restricted';
    worker: boolean;
    /** 文字文档的平台策略（P5）：default 为 SDK 行为；platform 安装 `/` 键、输入法事件归一、命令守卫、粘贴清洗与版式规范（src/harness/doc-policy.ts）。 */
    docpolicy: 'default' | 'platform';
    /** 输入法记录页（P5）：记录真实输入法的事件序列，交回验证服务。 */
    imelog: boolean;
    /** 文字文档的大纲侧栏（P5，docs-ui 的 toc 配置）。 */
    outline: boolean;
    /** 目录块插件（P5 评估用，docs-toc 与 docs-toc-ui）：doc@1 不注册，tocblock=1 时注册。 */
    tocblock: boolean;
    /** 真实 Safari 自检：场景名；完成后跳转到 next。 */
    selftest?: string;
    next?: string;
}

export function readPageParams(defaultSample: string): PageParams {
    const q = new URLSearchParams(location.search);
    return {
        sample: q.get('sample') ?? defaultSample,
        doc: q.get('doc') ?? undefined,
        without: (q.get('without') ?? '').split(',').filter((x) => x !== ''),
        unit: q.get('unit') ?? undefined,
        guard: q.get('guard') === '1',
        mode: q.get('mode') === 'read' ? 'read' : 'edit',
        ro: q.get('ro') ?? 'points',
        calc: q.get('calc') === 'forced' ? 'forced' : 'default',
        split: q.get('split') !== '0',
        interval: q.get('interval') == null ? undefined : Number(q.get('interval')),
        img: q.get('img') === 'platform' ? 'platform' : 'default',
        imagefn: q.get('imagefn') === 'off' ? 'off' : q.get('imagefn') === 'restricted' ? 'restricted' : 'default',
        worker: q.get('worker') === '1',
        docpolicy: q.get('docpolicy') === 'platform' ? 'platform' : 'default',
        imelog: q.get('imelog') === '1',
        outline: q.get('outline') === '1',
        tocblock: q.get('tocblock') === '1',
        selftest: q.get('selftest') ?? undefined,
        next: q.get('next') ?? undefined,
    };
}
