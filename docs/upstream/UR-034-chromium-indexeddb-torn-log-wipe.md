# UR-034 Chromium 的 IndexedDB：进程在 LevelDB 日志写到一半时被结束，再下一次启动时整个来源的 IndexedDB 被删掉

> 状态：草稿（提交之前需求方确认；2026-09-29 的决定：全部草稿暂不提交）｜上游：Chromium（`issues.chromium.org`，组件 Blink>Storage>IndexedDB）｜提交方式：公开 issue（可靠性缺陷，不是安全问题）
> 出处：M4-P1 S7 的调查（崩溃工具的实现者，2026-10-09）；P1 设计 `docs/v0.1/M4-本地优先与离线恢复/01-P1-本机发件箱.md` §3.8；复核报告 `reviews/P1-真实浏览器复核.md`
> 发现版本：Google Chrome 154.0.8037.98（macOS 27.0，arm64）；Chrome for Testing 153.0.8010.12（macOS 27.0 与 Linux arm64 / Ubuntu 24.04）

## 摘要（中文）

Chromium 的 IndexedDB 每个来源一个 LevelDB（同一来源的全部库共用），打开时复用上一次的日志文件（LevelDB 的 `reuse_logs`）。浏览器进程在往这个日志追加一条记录的中途被结束——记录头已经写下、内容没写——之后会依次发生：

1. 下一次启动一切正常：LevelDB 把结尾这半条当作"写的进程死在中途"，悄悄丢掉，数据都在；但它接着这个文件的全长往后写，新的记录接在那半条后面。
2. 再下一次启动（上一次是正常关闭还是又被结束都一样）：那半条的记录头把后面新写的字节当成自己的内容，校验和不符（`Corruption: checksum mismatch`），IndexedDB 以 paranoid 检查打开失败，Chromium 删掉这个来源的全部 IndexedDB 重建。
3. 页面得到的是一次 `UnknownError: Internal error opening backing store`，或者删库之后第一个 `open()`（不论打开哪个库）的升级事件上 `dataLoss: "total"`；之后再打开那些丢了的库，`dataLoss` 都是 `"none"`。谁先打开谁拿到这个信号，同一来源的别的标签页、Worker、页面里的第三方库都可能抢先，应用靠不住它。
4. 变体：之后写入的字节不够那半条声明的长度时不删库，但之后每一次提交的写入，都在下一次启动时悄悄丢掉。

同样的复用日志也在 Chromium 的 localStorage 与 OPFS 的目录库里；它们不是 paranoid 打开，表现不是删库，而是那半条之后、同一个 32 KiB 块里的记录在每一次启动时都被丢掉——之后的 localStorage 改动、OPFS 里用 `createWritable` 改写的文件都悄悄丢失。

- **复现**：不注入时，Google Chrome 154 强制结束 1400 次，删库 5 次；Chrome for Testing 153（macOS）1100 次里 9 次，Linux 300 次里 1 次。每一次删库之前，那次结束之后日志结尾都恰好是一个完整的 7 字节记录头、内容 0 字节（15 次前兆对 15 次删库）；写完再结束 300 次，0 次。往日志结尾补 7 字节，就能确定地复现（不需要结束进程，见英文部分）。WebKit（每个库一个 SQLite）强制结束 290 次，0 次。
- **对平台的影响**：本机发件箱（M4）把还没同步的修改存在 IndexedDB 里；浏览器在崩溃之后重开时可能把它整个删掉，页面只看到"没有草稿"——"崩溃之后从本机恢复"的承诺在 Chromium 系的浏览器上不总成立，而且是静默的。
- **平台的规避**（M4-P1 S9，需求方 2026-10-09 决定）：IndexedDB 仍是主存储，每次写成之后同一份记录镜像进 OPFS——只在发件箱的 Worker 里用同步访问句柄改写事先建好的两个槽位文件，不碰 OPFS 的目录库；删库之后从 OPFS 写回，并如实告诉用户。
- **建议的修法**（供上游参考）：复用日志之前，把它截到最后一条完整记录的末尾；或者读到半截记录时不复用这个日志。

## 已有的上游讨论

- 没有检索：本次只用本地资源，不访问网络。【待补充：提交之前检索一次。建议的关键词：`IndexedDB recovering from a corrupted (and deleted) database`、`reuse_logs checksum mismatch`、`leveldb torn log record reuse`、`Internal error opening backing store`、`IndexedDB data loss after crash`】
- 下面"原因的判断"一节是按 LevelDB 公开源码的记忆写的，没有对照 Chromium 当前的源码核对。【待补充：提交之前核对 `DBImpl::RecoverLogFile` 的复用条件与 Chromium 在各平台上 `reuse_logs` 的取值】

---

## Issue（英文，可以直接提交）

**Title:** IndexedDB: after the browser is killed while LevelDB is appending a log record, the *next-but-one* startup deletes all IndexedDB data of the origin ("IndexedDB recovering from a corrupted (and deleted) database")

**Chrome version:** 154.0.8037.98 (Google Chrome, macOS 27.0, arm64). Also reproduced with Chrome for Testing 153.0.8010.12 on macOS 27.0 (arm64) and Linux (Ubuntu 24.04, arm64). Not tested on Windows.

**Summary**

If the browser process dies while LevelDB is appending a record to the IndexedDB log (the 7-byte record header is written, the payload is not), the next startup recovers silently (the torn tail is treated as end-of-file), but because the log is reused, new records are appended *after* the torn header. On the following startup the torn header swallows the new bytes as its payload, recovery fails with `Corruption: checksum mismatch`, and Chromium deletes the whole IndexedDB backing store of the origin. Only the first `open()` after the wipe sees `dataLoss: "total"`; every other database that was lost reports `dataLoss: "none"`.

**Deterministic steps (no process kill needed — 7 bytes simulate the torn header)**

1. Serve an empty page from a fixed origin, e.g. `http://127.0.0.1:8000/`, and launch Chrome with a fresh profile: `--user-data-dir=/tmp/idb-repro http://127.0.0.1:8000/`.
2. In the page, create two databases and write one record to each:
   ```js
   async function put(db, key, value) {
     const conn = await new Promise((ok, no) => { const r = indexedDB.open(db, 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
     await new Promise((ok, no) => { const tx = conn.transaction('s', 'readwrite', { durability: 'strict' }); tx.objectStore('s').put(value, key); tx.oncomplete = ok; tx.onabort = () => no(tx.error) })
     conn.close()
   }
   await put('a', 'k1', 'one'); await put('b', 'k1', 'other database')
   ```
3. Close the browser normally.
4. Append a header-only record (arbitrary checksum, length 64, type FULL, no payload) to the origin's current log:
   ```sh
   printf '\x11\x22\x33\x44\x40\x00\x01' >> /tmp/idb-repro/Default/IndexedDB/http_127.0.0.1_8000.indexeddb.leveldb/000003.log
   ```
5. Start again with the same profile. `indexedDB.databases()` returns `["a","b"]`, data is intact; the LevelDB `LOG` shows `Reusing MANIFEST …`, `Recovering log #3`, `Reusing old log …/000003.log`. Write one more record — `await put('a', 'k2', 'x'.repeat(200))` — it succeeds. Close normally.
6. Start again with the same profile.

**Expected:** both databases and all three records are still there (or, at worst, only the torn tail is discarded).

**Actual:** the first `indexedDB.databases()` rejects with `UnknownError: Internal error opening backing store for indexedDB.open.`, the second returns `[]`. `indexedDB.open('a')` creates a new empty database whose upgrade event has `oldVersion=0`, `dataLoss="total"`, `dataLossMessage="IndexedDB (database was corrupt): Internal error opening backing store for indexedDB.open."`. Database `b` is gone. If the first call after the wipe is `indexedDB.open('a')`, it succeeds directly with `dataLoss="total"`, `dataLossMessage="IndexedDB (database was corrupt): checksum mismatch"`; if the first call opens an unrelated new database `c`, then `c` gets `dataLoss="total"` and the lost `b` and `a` both report `dataLoss="none"`.

Browser log (`--enable-logging=stderr`, profile path replaced with `<profile>`), Google Chrome 154:
```
ERROR:content/browser/indexed_db/instance/leveldb/backing_store.cc:237] Failed to open LevelDB database from <profile>/Default/IndexedDB/http_127.0.0.1_53246.indexeddb.leveldb,Corruption: checksum mismatch
ERROR:content/browser/indexed_db/instance/leveldb/backing_store.cc:1642] Got corruption for { origin: http://127.0.0.1:53246, top-level site: http://127.0.0.1, nonce: <null>, ancestor chain bit: Same-Site }, checksum mismatch
ERROR:content/browser/indexed_db/instance/leveldb/backing_store.cc:1502] IndexedDB recovering from a corrupted (and deleted) database.
```
(Chrome for Testing 153 prints the same three lines at `backing_store.cc:237`, `:1638`, `:1498`.)

**Natural occurrence (no injection)**

Persistent profile; the page repeatedly writes one readwrite transaction with `durability: 'strict'` (a ~3.8 MiB or a 64 KiB value); around the commit, the whole browser process tree is stopped and then killed (SIGSTOP, SIGKILL); the profile is reopened and read back; after each kill the tail of the log is inspected.

| Browser | Kills | Origin wiped |
|---|---|---|
| Google Chrome 154 (macOS) | 1400 | 5 |
| Chrome for Testing 153 (macOS) | 1100 | 9 |
| Chrome for Testing 153 (Linux) | 300 | 1 |

Before every one of the 15 wipes, the log ended with exactly one complete 7-byte record header and no payload after the kill before (one case: the first fragment of a large record was complete and the last fragment's header had no payload). Killing after the write had completed: 0 of 300. A naturally torn tail from Google Chrome 154 (`000012.log`, last 7 bytes): `53 ef aa fb 81 00 01` (checksum 0xfbaaef53, length 129, type 1), nothing after it.

**Analysis (from our reading of LevelDB, not verified against the current Chromium source)**

- `leveldb::log::Reader` treats a truncated record at the end of the log (incomplete header or payload) as end-of-file rather than corruption — the writer died mid-record.
- Chromium opens the IndexedDB LevelDB with `reuse_logs` (the `LOG` line "Reusing old log" confirms it on macOS and Linux). `DBImpl::RecoverLogFile` keeps the last log and the new `log::Writer` continues at the file's full length — i.e. right after the torn header.
- On the next recovery the torn header claims the following bytes as its payload, the checksum fails, IndexedDB opens with paranoid checks, recovery fails, and the backing store of the origin is deleted. When fewer bytes than the claimed length follow, every later record in that block is silently dropped on each recovery instead.
- The same reused-log pattern exists in Chromium's localStorage (`Default/Local Storage/leveldb`) and the OPFS directory database (`Default/File System/<n>/t/Paths`); there it does not wipe the store, but every later change in the same 32 KiB block is silently lost on each recovery (localStorage updates, files rewritten via `createWritable`).

**Possible fix:** before reusing a log, truncate it to the end of the last complete record, or do not reuse a log whose tail was torn.

**Impact:** web apps that rely on IndexedDB for crash recovery (offline-first editors, outboxes) lose all of their data for the origin a few startups after a crash, and cannot reliably detect it (`dataLoss` is delivered only to whichever `open()` comes first).
