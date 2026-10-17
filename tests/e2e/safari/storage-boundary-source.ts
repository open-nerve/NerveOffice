// 独立来源中的合成标记探针；不导入产品存储代码，不改产品 IndexedDB 或 OPFS。
export const STORAGE_BOUNDARY_WORKER = `
onmessage = async ({data}) => {
  const result = { operation: data.operation, stages: [], matched: null, bytes: null };
  let handle;
  let stage = 'getDirectory';
  try {
    const root = await navigator.storage.getDirectory(); result.stages.push(stage);
    stage = 'getFileHandle';
    const file = await root.getFileHandle('s4-' + data.runId, {create: data.operation === 'write'}); result.stages.push(stage);
    stage = 'createSyncAccessHandle';
    handle = await file.createSyncAccessHandle(); result.stages.push(stage);
    const expected = new TextEncoder().encode('NerveOffice S4 synthetic marker ' + data.runId);
    if (data.operation === 'write') {
      stage = 'truncate'; handle.truncate(0); result.stages.push(stage);
      stage = 'write'; result.bytes = handle.write(expected, {at: 0}); result.stages.push(stage);
      if (result.bytes !== expected.length) throw Error('ShortWrite');
      stage = 'flush'; handle.flush(); result.stages.push(stage);
    }
    stage = 'read';
    const bytes = new Uint8Array(handle.getSize());
    const count = handle.read(bytes, {at: 0}); result.stages.push(stage);
    result.matched = count === expected.length && bytes.length === expected.length && expected.every((value,index) => value === bytes[index]);
    result.readBytes = count;
    stage = 'close'; handle.close(); handle = undefined; result.stages.push(stage);
    result.outcome = 'completed';
  } catch (error) {
    result.outcome = 'error'; result.error = {stage, name: error && typeof error.name === 'string' ? error.name : 'UnknownError'};
  } finally {
    if (handle !== undefined) { try {handle.close(); result.stages.push('cleanupClose');} catch {result.cleanupFailed = true;} }
  }
  postMessage(result);
};
`

export function storageBoundaryPage(options: { runId: string, caseId: string, operation: 'write' | 'read', workerPath: string, controlPath: string }): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>NerveOffice S4 存储边界 ${options.caseId}</title><main><h1>NerveOffice S4 存储边界</h1><p id="state">${options.caseId}：等待宿主确认窗口模式及连续空闲 120 秒</p><pre id="result"></pre></main><script>
const options = ${JSON.stringify(options)};
const bootId = crypto.randomUUID();
const visibility = [{at: Date.now(), state: document.visibilityState}];
document.addEventListener('visibilitychange', () => visibility.push({at: Date.now(), state: document.visibilityState}));
const errorName = error => error && typeof error.name === 'string' ? error.name : 'UnknownError';
async function attempt(action) {
  let timer;
  const timeout = Symbol('timeout');
  try {
    const value = await Promise.race([Promise.resolve().then(action), new Promise(resolve => {timer=setTimeout(()=>resolve(timeout),10000);})]);
    return value===timeout ? {outcome:'timeout'} : {outcome:'completed',value};
  } catch (error) { return {outcome:'error',error:{name:errorName(error)}}; }
  finally {clearTimeout(timer);}
}
async function send(kind, report) {
  const response = await fetch(options.controlPath, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({kind, runId: options.runId, caseId: options.caseId, bootId, ...(report ? {report} : {})}), signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw Error('ControlRefused');
  return response.json();
}
async function idb() {
  let created = false;
  const request = indexedDB.open('nerve-s4-boundary-' + options.runId, 1);
  const db = await new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      if (options.operation === 'read') {created = true; request.transaction.abort();}
      else request.result.createObjectStore('marker');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => created ? resolve(null) : reject(request.error);
    request.onblocked = () => reject(Error('Blocked'));
  });
  if (db === null) return {outcome:'missing', upgradedThenAborted:true};
  try {
    if (options.operation === 'write') await new Promise((resolve,reject) => {
      const tx = db.transaction('marker','readwrite',{durability:'strict'});
      tx.objectStore('marker').put(options.runId,'synthetic');
      tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
    });
    const tx = db.transaction('marker','readonly');
    const value = tx.objectStore('marker').get('synthetic');
    return await new Promise((resolve,reject) => {
      tx.oncomplete=()=>resolve({outcome:'completed',matched:value.result===options.runId});
      tx.onabort=()=>reject(tx.error);
    });
  } finally { db.close(); }
}
async function run() {
  for (;;) {
    const reply = await send('begin');
    if (reply.kind === 'start') break;
    if (reply.kind !== 'wait') throw Error('HostStopped');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  document.querySelector('#state').textContent = options.caseId + '：真实存储接口运行中';
  const report = {startedAt: Date.now(), userAgent: navigator.userAgent, secureContext: isSecureContext, origin: location.origin, operation: options.operation};
  report.persistedBefore = await attempt(() => navigator.storage.persisted());
  report.persist = await attempt(() => navigator.storage.persist());
  report.persistedAfter = await attempt(() => navigator.storage.persisted());
  report.estimate = await attempt(() => navigator.storage.estimate());
  report.opfs = await new Promise((resolve) => {
    const worker = new Worker(options.workerPath);
    const timer = setTimeout(() => {worker.terminate(); resolve({outcome:'timeout'});}, 10000);
    worker.onmessage = event => {clearTimeout(timer); worker.terminate(); resolve(event.data);};
    worker.onerror = () => {clearTimeout(timer); worker.terminate(); resolve({outcome:'worker-error'});};
    worker.postMessage({runId: options.runId,operation: options.operation});
  });
  report.indexedDB = await attempt(idb);
  report.estimateAfter = await attempt(() => navigator.storage.estimate());
  report.finishedAt = Date.now(); report.visibility = visibility;
  await send('complete',report);
  document.querySelector('#result').textContent = JSON.stringify(report,null,2);
  document.querySelector('#state').textContent = options.caseId + '：结果已交给宿主';
}
run().catch(error => {document.querySelector('#state').textContent = '探针失败：' + errorName(error); send('failed').catch(()=>{});});
</script></html>`
}
