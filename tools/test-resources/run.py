#!/usr/bin/env python3
"""Run a test command with an owned scratch directory, or sweep only registered runs."""
import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

from lifecycle import Store, Run, atomic_bytes, atomic_json, contained, group_alive, locked, open_paths, read_json, RUN_ID

MIN_FREE = 12 * 1024 ** 3
MAX_LOG = 32 * 1024 ** 2
BOOTSTRAP = "import os,sys; fd=int(sys.argv[1]); ready=os.read(fd,1); os.close(fd); ready==b'1' or sys.exit(125); os.execvpe(sys.argv[2],sys.argv[2:],os.environ)"


def publication_base(store, kind):
    if kind not in ("e2e", "measure", "template", "container", "native"):
        return None
    base = store.repo / "tests/e2e"
    if kind == "measure":
        base = base / "measure"
    if kind == "native":
        base = base / "safari-results"
    return base


def rotate_reports(store, kind, current_run=None):
    base = publication_base(store, kind)
    if base is None:
        return
    # Validate the complete portable tree before moving either leaf. Partial publication
    # or an altered export is preserved for diagnosis, not silently accepted on restart.
    validated = set()
    for name in ('test-results', 'playwright-report'):
        marker = base / name / 'resource-run.json'
        if marker.is_file() and not marker.is_symlink():
            identity = read_json(marker).get('runId', '')
            if identity in validated or not RUN_ID.fullmatch(identity):
                continue
            owner = current_run if current_run is not None and identity == current_run.id else Run(store, store.root / 'runs' / identity, existing=True)
            try:
                if owner.data.get('hostedScope') is not None:
                    owner.validate_hosted_completion()
                    owner.verify_export()
                validated.add(identity)
            finally:
                if owner is not current_run:
                    owner.release()
    for name in ("test-results", "playwright-report"):
        target = contained(base / name, store.repo)
        if target.is_symlink():
            raise ValueError("旧报告不能是链接")
        if not target.exists() or not any(target.iterdir()):
            continue
        marker = target / "resource-run.json"
        if marker.is_symlink() or not marker.is_file():
            raise ValueError("已有报告未登记或仍在使用；请先归档，拒绝覆盖")
        previous = read_json(marker)["runId"]
        if not RUN_ID.fullmatch(previous):
            raise ValueError("旧报告归属无效")
        directory = contained(store.root / "runs" / previous, store.root)
        if directory.is_symlink():
            raise ValueError("旧运行不能是链接")
        relative = str(target.relative_to(store.repo))
        owner = current_run if current_run is not None and previous == current_run.id else Run(store, directory, existing=True)
        try:
            value = owner.data
            if (read_json(marker).get("runId") != previous or value.get("runId") != previous
                    or value.get("repo") != str(store.repo) or relative not in value.get("published", [])):
                raise ValueError("旧报告未登记到原运行")
            if open_paths(target, owner=owner, export_only=owner.data.get('hostedScope') is not None):
                raise ValueError("已有报告仍在使用；拒绝覆盖")
            if owner is current_run:
                continue
            old_root = directory / ('reports/portable' if owner.data.get('hostedScope') is not None else 'reports')
            old = contained(old_root / name, store.root)
            if old.exists() or old.is_symlink():
                raise ValueError("旧报告归档已存在")
            owner.scope_directory(directory / 'reports')
            if not old_root.is_dir() or old_root.is_symlink():
                raise ValueError('原导出暂存根缺失或被替换')
            owner.scope_move(target, old)
            target.rename(old)
            owner.update(published=[p for p in owner.data["published"] if p != relative])
            if owner.data.get('hostedScope') is not None and not owner.data.get('published'):
                owner.update(publicationComplete=False)
                owner.verify_export()
        finally:
            if owner is not current_run:
                owner.release()


def published_by(run, target):
    marker = target / "resource-run.json"
    if target.is_symlink() or marker.is_symlink() or not marker.is_file():
        return False
    return (read_json(marker).get("runId") == run.id
            and str(target.relative_to(run.store.repo)) in run.data.get("published", []))


def publish(run, kind, reports=None):
    base = publication_base(run.store, kind)
    if base is None:
        return
    if run.data.get('hostedScope') is not None:
        run.validate_hosted_completion()
        run.verify_export()
    reports = reports or run.directory / ('reports/portable' if run.data.get('hostedScope') is not None else 'reports')
    relative_reports = str(reports.relative_to(run.directory))
    if relative_reports not in ("reports", "reports/recovery", "reports/portable"):
        raise ValueError("报告暂存归属不符")
    run.update(publicationReports=relative_reports)
    # A self-contained receipt and bounded diagnostics travel with CI/handoff artifacts.
    results = reports / "test-results"
    if not published_by(run, contained(base / "test-results", run.store.repo)):
        results.mkdir(parents=True, exist_ok=True)
        atomic_json(results / "cleanup-receipt.json", {
            **run.data, "policy": {"failureDays": 7, "failureRunMiB": 256, "failureTotalGiB": 2,
                                  "reportDays": 14, "reportTotalGiB": 5},
            "rawProfiles": "local ephemeral only; portable diagnostics are in failure-diagnostics",
        })
    for name in ("test-results", "playwright-report"):
        source = reports / name
        target = contained(base / name, run.store.repo)
        if published_by(run, target):
            if source.exists():
                raise ValueError("同轮报告同时存在于发布和暂存位置，拒绝覆盖")
            continue
        if not source.exists():
            continue
        if target.is_symlink() or (target.exists() and any(target.iterdir())):
            raise ValueError("发布位置非空或是链接；保留本轮原件")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.rmdir()
        relative = str(target.relative_to(run.store.repo))
        run.scope_move(source, target)
        run.update(published=list(dict.fromkeys([*run.data.get("published", []), relative])))
        atomic_json(source / "resource-run.json", {"version": 1, "runId": run.id,
                    "receipt": str(run.directory / "run.json"), "status": run.data["status"]})
        # Directory rename is atomic; a crash cannot leave an unowned half-copy.
        source.rename(target)
    run.update(publicationComplete=True)
    if run.data.get('hostedScope') is not None:
        run.verify_export()
        run.update(resourceBudget=run.store.hosted_budget())


def evidence_snapshot(run):
    """Quiescent but incomplete OPFS/cleanup proof: export bounded diagnostics, no raw profile."""
    run.assert_quiescent()
    destination = contained(run.directory / "reports/recovery", run.store.root)
    if destination.is_symlink():
        raise ValueError("恢复诊断目录不得是链接")
    run.scope_directory(run.directory / "reports")
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "test-results").mkdir(exist_ok=True)
    copied, omitted, total = [], [], 0
    for name in ("test-results", "playwright-report"):
        sources = [run.scratch / "tests/e2e" / name, run.directory / "reports" / name]
        for source in sources:
            contained(source, run.store.root)
            if source.is_symlink():
                raise ValueError("恢复报告源不能是链接")
            if not source.exists():
                continue
            for directory, dirs, files in os.walk(source, followlinks=False):
                dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
                for filename in sorted(files):
                    path = Path(directory) / filename
                    relative = path.relative_to(source)
                    if path.is_symlink():
                        continue
                    if relative.parts[0] == "persistent-profiles" and "opfs-archive" not in relative.parts and filename not in ("resource-owner.json", "retention.json"):
                        continue
                    size = path.stat().st_size
                    if size > 256 * 1024**2 or total + size > 512 * 1024**2:
                        if len(omitted) < 10000:
                            omitted.append({"path": str(relative), "bytes": size})
                        continue
                    target = contained(destination / name / relative, destination)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    atomic_bytes(target, path.read_bytes())
                    total += size; copied.append(str(Path(name) / relative))
    atomic_json(destination / "test-results/recovery-evidence.json", {
        "runId": run.id, "status": "diagnostic-only", "cleanupError": run.data.get("cleanupError"),
        "copied": copied, "omitted": omitted, "bytes": total,
        "policy": "256 MiB/file, 512 MiB total; no raw profiles; incomplete proofs are not acceptance",
    })
    return destination


def recover_ci(store, state):
    if state is None or state.is_symlink() or state.resolve() != state.absolute():
        raise ValueError("需要本轮 CI 的真实监督目录")
    for name in ("owner.json", "quiescence.json"):
        if (state / name).is_symlink():
            raise ValueError("CI 证明不得是链接")
    owner = read_json(state / "owner.json")
    if owner.get("root") != str(store.repo) or not RUN_ID.fullmatch(owner.get("token", "")) or read_json(state / "quiescence.json").get("quiescent") is not True:
        raise ValueError("CI 身份或全部退出证明不符")
    matches = []
    for directory in (store.root / "runs").iterdir():
        if directory.is_symlink() or not RUN_ID.fullmatch(directory.name):
            continue
        try:
            if (directory / "run.json").is_symlink():
                continue
            value = read_json(directory / "run.json")
        except (OSError, ValueError):
            continue
        if value.get("ciOwner") == owner["token"] and value.get("ciState") == str(state):
            matches.append(directory)
    if len(matches) > 1:
        raise ValueError("同一个 CI 身份关联多轮，拒绝猜测")
    if not matches:
        return 0  # No resource command started; the existing CI report check still fails.
    with locked(store.root / "publication.lock", blocking=False):
        run = Run(store, matches[0], existing=True)
        try:
            if run.data.get("publicationComplete"):
                if run.data.get('hostedScope') is not None:
                    run.validate_hosted_completion()
                    run.assert_exportable()
                    run.verify_export()
                return 0
            prior_reports = run.data.get("publicationReports")
            if run.data.get('hostedScope') is not None and run.data.get('cleanupStage') == 'host-disposal-pending':
                run.validate_hosted_completion()
                run.assert_exportable()
                run.verify_export()
                reports = run.directory / 'reports/portable'
            elif prior_reports is not None:
                if prior_reports not in ("reports", "reports/recovery", "reports/portable"):
                    raise ValueError("中断发布暂存位置不符")
                reports = contained(run.directory / prior_reports, store.root)
            else:
                run.finish("interrupted", release=False)
                reports = evidence_snapshot(run) if run.data.get("status") == "cleanup-pending" else None
            rotate_reports(store, run.data["kind"], current_run=run)
            publish(run, run.data["kind"], reports)
            print("已按本轮 CI 身份恢复报告；中断状态不作为验收通过。")
            return 0
        finally:
            run.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--ci-state", type=Path)
    parser.add_argument("kind")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    store = Store(args.repo)
    if args.kind == "recover-ci":
        return recover_ci(store, args.ci_state)
    if args.kind == "cleanup":
        print(store.sweep())
        return 0
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("需要测试命令")
    store.sweep()
    store.hosted_budget()
    if shutil.disk_usage(store.repo).free < MIN_FREE:
        raise RuntimeError("可用磁盘不足 12 GiB，未创建本轮环境")
    for manifest in (store.root / "runs").glob("*/run.json"):
        if not manifest.is_symlink():
            prior = read_json(manifest)
            if prior.get("kind") == args.kind and prior.get("status") == "cleanup-pending":
                raise RuntimeError("同类上一轮仍待安全回收；先处理记录中的原因，不继续堆积环境")
    # Fixed CI publication paths are serialized; resources themselves use UUID directories.
    with locked(store.root / "publication.lock", blocking=False):
        rotate_reports(store, args.kind)
        run = store.create(args.kind)
        stopped = []
        child = None
        output_thread = None
        read_fd = write_fd = -1
        original = {}
        def request_stop(signum, frame):
            stopped.append(signum)
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signum)
        try:
            for sig in (signal.SIGINT, signal.SIGTERM):
                original[sig] = signal.signal(sig, request_stop)
            if os.environ.get("NERVE_TEST_CI_E2E_OWNER") and os.environ.get("NERVE_CI_E2E_STATE"):
                run.update(ciOwner=os.environ["NERVE_TEST_CI_E2E_OWNER"],
                           ciState=str(Path(os.environ["NERVE_CI_E2E_STATE"]).resolve()))
            temp = run.create_short_tmp()
            output = run.scratch / "tests/e2e/test-results"
            output.mkdir(parents=True)
            env = dict(os.environ, NERVE_TEST_RUN_ID=run.id, NERVE_TEST_SCRATCH=str(run.scratch),
                       NERVE_TEST_OUTPUT_DIR=str(output), NERVE_TEST_REPORT_DIR=str(output),
                       TMPDIR=str(temp), TMP=str(temp), TEMP=str(temp))
            env.pop("NERVE_TEST_SHORT_ROOT", None)
            env.pop('NERVE_TEST_COVERAGE_DIR', None)
            if run.data.get('hostedScope') is not None and args.kind == 'integration':
                env['NERVE_TEST_COVERAGE_DIR'] = str(output / 'coverage')
            if args.kind == "vm":
                env["NERVE_TEST_SHORT_ROOT"] = run.data["shortRoot"]
            if stopped:
                return 128 + int(stopped[0])
            # Refuse to start work when the same owned-root cleanup check cannot run.
            if run.data.get('hostedScope') is not None:
                run.assert_exportable()
                run.update(resourceBudget=store.hosted_budget())
            else:
                run.assert_quiescent()
            if stopped:
                return 128 + int(stopped[0])
            read_fd, write_fd = os.pipe()
            child = subprocess.Popen([sys.executable, "-c", BOOTSTRAP, str(read_fd), *command],
                                     env=env, pass_fds=(read_fd,), start_new_session=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            os.close(read_fd); read_fd = -1
            run.update(status="running", childGroup=child.pid, command=command, cwd=os.getcwd())
            os.write(write_fd, b"1"); os.close(write_fd); write_fd = -1
            log_problem = []
            def copy_output():
                written = 0
                try:
                    with (run.directory / "command.log").open("wb") as log:
                        while True:
                            chunk = os.read(child.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            if written + len(chunk) <= MAX_LOG:
                                log.write(chunk); log.flush()
                            elif not log_problem:
                                log_problem.append("command-log-cap")
                            written += len(chunk)
                            try:
                                sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
                            except BrokenPipeError:
                                pass
                except (OSError, ValueError) as error:
                    log_problem.append('output-io-error:' + type(error).__name__)
            output_thread = threading.Thread(target=copy_output, daemon=True)
            output_thread.start()
            stop_at = None
            budget_at = time.monotonic()
            while child.poll() is None:
                if shutil.disk_usage(store.repo).free < MIN_FREE or log_problem:
                    if not stopped:
                        stopped.append(signal.SIGTERM); os.killpg(child.pid, signal.SIGTERM)
                        run.update(stopReason="disk-reserve-or-log-cap")
                if run.data.get('hostedScope') is not None and time.monotonic() - budget_at >= 2:
                    budget_at = time.monotonic()
                    try:
                        run.update(resourceBudget=store.hosted_budget())
                    except (OSError, ValueError, RuntimeError) as error:
                        if not stopped:
                            stopped.append(signal.SIGTERM)
                            if child.poll() is None:
                                os.killpg(child.pid, signal.SIGTERM)
                        run.update(stopReason='hosted-resource-budget', budgetError=str(error))
                if stopped:
                    stop_at = stop_at or time.monotonic()
                    if time.monotonic() - stop_at > 10:
                        os.killpg(child.pid, signal.SIGKILL)
                time.sleep(.1)
            code = child.wait()
            # Give normal browser shutdown time; never delete while descendants or handles remain.
            deadline = time.monotonic() + 3
            while group_alive(child.pid) and time.monotonic() < deadline:
                time.sleep(.1)
            if group_alive(child.pid):
                # The leader is gone: a PID/group number alone is not a new signal authorization.
                run.update(status="cleanup-pending", cleanupError="首进程已退出但仍有同组进程；保留并等待归属复核")
                return code or 1
            output_thread.join(timeout=5)
            if output_thread.is_alive():
                run.update(status="cleanup-pending", cleanupError="输出仍有写入者")
                return code or 1
            result = 128 + int(stopped[0]) if stopped else (128 - code if code < 0 else code)
            # The final output chunk may arrive after the child already exited;
            # joining the thread is not evidence of successful log capture.
            if log_problem:
                result = result or 1
                run.update(stopReason='log-cap-or-output-error', outputErrors=log_problem[:4])
            run.update(commandExitCode=code, exitCode=result, interrupted=bool(stopped), producerQuiescent=True)
            receipt = run.finish("interrupted" if stopped else ("passed" if result == 0 else "failed"), release=False)
            if receipt["status"] == "cleanup-pending":
                print("测试环境尚不能安全回收；原件与归属已保留。" + receipt.get("cleanupError", ""), file=sys.stderr)
                return result or 1
            publish(run, args.kind)
            return result
        finally:
            try:
                for fd in (read_fd, write_fd):
                    if fd >= 0:
                        os.close(fd)
                if child is not None and child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
                if run.data.get("status") in ("prepared", "running"):
                    if output_thread is not None:
                        output_thread.join(timeout=5)
                    if output_thread is None or not output_thread.is_alive():
                        run.update(exitCode=128 + int(stopped[0]) if stopped else 1, interrupted=True,
                                   producerQuiescent=not group_alive(run.data.get('childGroup')))
                        run.finish("interrupted", release=False)
                    else:
                        run.update(status="cleanup-pending", cleanupError="异常退出后输出仍有写入者")
            finally:
                if child is not None and child.stdout is not None and (output_thread is None or not output_thread.is_alive()):
                    child.stdout.close()
                run.release()
                for sig, handler in original.items():
                    signal.signal(sig, handler)
            with locked(store.root / "gc.lock"):
                store.prune(time.time())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print("测试资源管理停止：" + str(error), file=sys.stderr)
        sys.exit(1)
