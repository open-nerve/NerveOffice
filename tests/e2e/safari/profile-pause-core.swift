// 独立恢复循环。生产与自有空进程校准共用；暂停期间不启动命令、不等待 Node、不写磁盘。
import Foundation
import CoreFoundation
import Darwin
import IOKit

struct KernelProcess: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let ppid: UInt32
    let startedAtUs: String
    let executable: String

    var json: [String: Any] {
        ["pid": pid, "uid": uid, "ppid": ppid, "startedAtUs": startedAtUs, "executable": executable]
    }
}

struct KernelState {
    let process: KernelProcess
    let stopped: Bool
}

func pauseKernel(_ pid: Int32) -> KernelState? {
    var before = proc_bsdinfo()
    var after = proc_bsdinfo()
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, size) == size,
          before.pbi_status != UInt32(SZOMB), proc_pidpath(pid, &path, UInt32(path.count)) > 0,
          proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, size) == size,
          after.pbi_status != UInt32(SZOMB), before.pbi_uid == after.pbi_uid,
          before.pbi_ppid == after.pbi_ppid, before.pbi_start_tvsec == after.pbi_start_tvsec,
          before.pbi_start_tvusec == after.pbi_start_tvusec else { return nil }
    return KernelState(process: KernelProcess(pid: pid, uid: after.pbi_uid, ppid: after.pbi_ppid,
        startedAtUs: String(after.pbi_start_tvsec * 1_000_000 + after.pbi_start_tvusec),
        executable: String(cString: path)), stopped: after.pbi_status == UInt32(SSTOP))
}

private let pauseTimebase: mach_timebase_info_data_t = {
    var value = mach_timebase_info_data_t()
    guard mach_timebase_info(&value) == KERN_SUCCESS, value.denom != 0 else { reject("连续单调时钟不可用") }
    return value
}()

func pauseMonoMs() -> Double {
    Double(mach_continuous_time()) * Double(pauseTimebase.numer) / Double(pauseTimebase.denom) / 1_000_000
}

// NSNumber 的 Bool / 整数桥接不可混用；缺失或类型不明的会话字段不能当成解锁。
private func consoleBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

func pauseDesktopFailure() -> String? {
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    let hid = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    defer {
        if root != 0 { IOObjectRelease(root) }
        if hid != 0 { IOObjectRelease(hid) }
    }
    guard root != 0, hid != 0,
          let users = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [[String: Any]],
          !users.isEmpty, users.count <= 32,
          let idle = IORegistryEntryCreateCFProperty(hid, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber,
          CFGetTypeID(idle) != CFBooleanGetTypeID(), idle.doubleValue.isFinite, idle.doubleValue >= 0 else { return "desktop-unavailable" }
    var own: [[String: Any]] = []
    for user in users {
        guard let uid = user["kCGSSessionUserIDKey"] as? NSNumber, CFGetTypeID(uid) != CFBooleanGetTypeID(),
              uid.doubleValue >= 0, uid.doubleValue <= Double(UInt32.max), uid.doubleValue.rounded() == uid.doubleValue else { return "desktop-unavailable" }
        if uid.uint32Value == getuid() { own.append(user) }
    }
    guard own.count == 1, let onConsole = consoleBool(own[0]["kCGSSessionOnConsoleKey"]), onConsole else { return "desktop-unavailable" }
    // 本机成对探针证明：解锁时没有此键，锁屏时为 true。键存在但类型错误不能回退为 false。
    if let value = own[0]["CGSSessionScreenIsLocked"] {
        guard let locked = consoleBool(value) else { return "desktop-unavailable" }
        if locked { return "screen-locked" }
    }
    return idle.doubleValue >= 120_000_000_000 ? nil : "user-activity"
}

struct PauseStopRequest: Decodable {
    let kind: String
    let target: Identity
    let mainPid: Int32
    let observedAt: Int64
    let deadline: Int64
    let maxPauseMs: Int64
}

private func stopRequest(_ data: Data) -> PauseStopRequest? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(["kind", "target", "mainPid", "observedAt", "deadline", "maxPauseMs"]),
          let target = object["target"] as? [String: Any],
          Set(target.keys) == Set(["pid", "uid", "startedAtUs", "executable", "bundleId", "asn", "appleSigned"]),
          let request = try? JSONDecoder().decode(PauseStopRequest.self, from: data), request.kind == "stop" else { return nil }
    return request
}

private final class PauseSignals {
    private let lock = NSLock()
    private var interrupted = false
    private var sources: [DispatchSourceSignal] = []
    init() {
        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: DispatchQueue.global(qos: .userInitiated))
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.lock.lock()
                self.interrupted = true
                self.lock.unlock()
            }
            source.resume()
            sources.append(source)
        }
    }
    var received: Bool {
        lock.lock()
        defer { lock.unlock() }
        return interrupted
    }
}

private enum PauseInput {
    case idle, eof, invalid, line(Data)
}

final class ProfilePauseGuard {
    private let qualify: (PauseStopRequest) -> KernelProcess?
    private let desktop: () -> String?
    private let wall: () -> Int64
    private let didStop: () -> Void
    private let signals: PauseSignals
    private var input = Data()
    private var journal: [Data] = []
    private var target: KernelProcess?
    private var stopSignals = 0
    private var stoppedConfirmed = false
    private var continueSignals = 0
    private var resumedConfirmed = false
    private var continueAt: Int64?
    private var continueMonoMs: Double?
    private var readyMonoMs = 0.0
    private var clockOffset = 0.0

    init(qualify: @escaping (PauseStopRequest) -> KernelProcess?, desktop: @escaping () -> String?,
         wall: @escaping () -> Int64 = now, didStop: @escaping () -> Void = {}) {
        self.qualify = qualify
        self.desktop = desktop
        self.wall = wall
        self.didStop = didStop
        // 在任何 STOP 之前安装全部退出信号处理；主循环不依赖主队列调度。
        self.signals = PauseSignals()
    }

    private func prepareDescriptors() -> Bool {
        var info = stat()
        let journalFlags = fcntl(3, F_GETFL)
        guard fstat(3, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600, info.st_uid == getuid(), info.st_nlink == 1, info.st_size == 0,
              journalFlags != -1, journalFlags & O_ACCMODE != O_RDONLY, lseek(3, 0, SEEK_CUR) == 0 else { return false }
        for fd: Int32 in [0, 1] {
            guard fstat(fd, &info) == 0, [S_IFIFO, S_IFSOCK].contains(info.st_mode & S_IFMT) else { return false }
            let flags = fcntl(fd, F_GETFL)
            guard flags != -1, fcntl(fd, F_SETFL, flags | O_NONBLOCK) != -1 else { return false }
        }
        return true
    }

    private func emit(_ value: [String: Any]) -> Bool {
        guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count < 4096 else { return false }
        data.append(10)
        journal.append(data)
        // 非阻塞，一次写；部分写、满管道和 EPIPE 都立即进入恢复流程。
        return data.withUnsafeBytes { write(1, $0.baseAddress, $0.count) == $0.count }
    }

    private func nextInput() -> PauseInput {
        if let newline = input.firstIndex(of: 10) {
            let line = Data(input[..<newline])
            input.removeSubrange(...newline)
            return line.isEmpty || line.count > 8192 ? .invalid : .line(line)
        }
        var buffer = [UInt8](repeating: 0, count: 8193)
        let count = read(0, &buffer, buffer.count)
        if count == 0 { return input.isEmpty ? .eof : .invalid }
        if count < 0 { return errno == EAGAIN || errno == EINTR ? .idle : .invalid }
        input.append(contentsOf: buffer.prefix(count))
        if input.count > 8192 { return .invalid }
        return nextInput()
    }

    private func transportFailure() -> String? {
        if signals.received { return "controller-signal" }
        var fd = pollfd(fd: 1, events: Int16(POLLOUT), revents: 0)
        let result = poll(&fd, 1, 0)
        if result < 0 && errno != EINTR { return "output-unavailable" }
        if fd.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 { return "output-unavailable" }
        return nil
    }

    private func clockChanged() -> Bool {
        abs((Double(wall()) - pauseMonoMs()) - clockOffset) > 2000
    }

    private func idleTick() {
        var fd = pollfd(fd: 0, events: Int16(POLLIN), revents: 0)
        _ = poll(&fd, 1, 100)
    }

    private func pause(_ request: PauseStopRequest) -> String {
        let checkedAt = wall()
        guard request.target.pid > 1, request.mainPid > 1, request.target.pid != request.mainPid,
              request.target.pid != getpid(), request.target.uid == getuid(),
              request.observedAt > 0, checkedAt >= request.observedAt, checkedAt - request.observedAt <= 2000,
              checkedAt < request.deadline, request.maxPauseMs > 0, request.maxPauseMs <= 180_000,
              let selected = qualify(request), selected.pid == request.target.pid, selected.uid == request.target.uid,
              selected.startedAtUs == request.target.startedAtUs, selected.executable == request.target.executable else { return "initial-refused" }
        if let failure = desktop() { return failure }
        if let failure = transportFailure() { return failure }
        if clockChanged() { return "clock-changed" }
        let signalAt = wall()
        let signalMonoMs = pauseMonoMs()
        guard signalAt >= request.observedAt, signalAt - request.observedAt <= 2000,
              signalAt < request.deadline, signalMonoMs - readyMonoMs <= 10_000,
              let state = pauseKernel(selected.pid), state.process == selected, !state.stopped else { return "initial-refused" }
        let maxPauseMs = min(request.maxPauseMs, request.deadline - signalAt)
        let deadline = signalMonoMs + Double(maxPauseMs)
        guard kill(selected.pid, SIGSTOP) == 0 else { return "initial-refused" }
        target = selected
        stopSignals = 1
        let confirmDeadline = min(deadline, pauseMonoMs() + 500)
        while pauseMonoMs() < confirmDeadline {
            guard let observed = pauseKernel(selected.pid), observed.process == selected else { return "stop-unconfirmed" }
            if observed.stopped {
                stoppedConfirmed = true
                didStop()
                if !emit(["kind": "stopped", "target": selected.json, "signalAt": signalAt, "signalMonoMs": signalMonoMs,
                          "at": wall(), "monoMs": pauseMonoMs(), "stopSignals": 1, "maxPauseMs": maxPauseMs]) { return "output-unavailable" }
                break
            }
            usleep(1000)
        }
        guard stoppedConfirmed else { return "stop-unconfirmed" }
        while true {
            if clockChanged() { return "clock-changed" }
            if let failure = transportFailure() { return failure }
            guard let state = pauseKernel(selected.pid) else { return "target-exited" }
            guard state.process == selected else { return "target-changed" }
            guard state.stopped else { return "externally-resumed" }
            if pauseMonoMs() >= deadline { return "deadline" }
            if let failure = desktop() { return failure }
            switch nextInput() {
            case .eof: return "controller-eof"
            case .invalid: return "invalid-command"
            case .line(let data):
                guard let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      Set(command.keys) == Set(["kind"]), command["kind"] as? String == "resume", input.isEmpty else { return "invalid-command" }
                return "requested"
            case .idle: idleTick()
            }
        }
    }

    private func restore(_ originalReason: String) -> String {
        guard stopSignals == 1, let target else { return originalReason }
        // 未证实 STOP 的异常路径仍尝试恢复自己的信号；回执保持 stop-unconfirmed。
        func replacement(_ reason: String) -> String { stoppedConfirmed ? reason : "stop-unconfirmed" }
        guard let state = pauseKernel(target.pid) else { return replacement("target-exited") }
        guard state.process == target else { return replacement("target-changed") }
        guard state.stopped else { return replacement("externally-resumed") }
        let at = wall()
        let monoMs = pauseMonoMs()
        guard kill(target.pid, SIGCONT) == 0 else { return replacement("resume-unconfirmed") }
        continueSignals = 1
        continueAt = at
        continueMonoMs = monoMs
        let confirmDeadline = pauseMonoMs() + 1000
        while pauseMonoMs() < confirmDeadline {
            guard let after = pauseKernel(target.pid), after.process == target else { return replacement("resume-unconfirmed") }
            if !after.stopped {
                resumedConfirmed = true
                return originalReason
            }
            usleep(1000)
        }
        return replacement("resume-unconfirmed")
    }

    private func persistJournal() -> Bool {
        // 只有 restore 返回后才允许写普通文件或 fsync，磁盘等待不能延长暂停。
        for data in journal {
            let complete = data.withUnsafeBytes { bytes -> Bool in
                var offset = 0
                while offset < bytes.count {
                    let count = write(3, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { return false }
                    offset += count
                }
                return true
            }
            if !complete { return false }
        }
        return fsync(3) == 0
    }

    func run() -> Bool {
        guard prepareDescriptors(), let own = pauseKernel(getpid())?.process else { return false }
        readyMonoMs = pauseMonoMs()
        let readyAt = wall()
        clockOffset = Double(readyAt) - readyMonoMs
        var reason = "output-unavailable"
        if emit(["kind": "ready", "guardian": ["pid": own.pid, "uid": own.uid, "startedAtUs": own.startedAtUs],
                 "at": readyAt, "monoMs": readyMonoMs]) {
            control: while true {
                if clockChanged() { reason = "clock-changed"; break }
                if let failure = transportFailure() { reason = failure; break }
                if pauseMonoMs() - readyMonoMs >= 10_000 { reason = "deadline"; break }
                switch nextInput() {
                case .eof: reason = "controller-eof"; break control
                case .invalid: reason = "invalid-command"; break control
                case .line(let data):
                    if let request = stopRequest(data), input.isEmpty { reason = pause(request) }
                    else { reason = "invalid-command" }
                    break control
                case .idle: idleTick()
                }
            }
        }
        reason = restore(reason)
        _ = emit(["kind": "finished", "target": target.map { $0.json as Any } ?? NSNull(), "reason": reason,
                  "at": wall(), "monoMs": pauseMonoMs(), "continueAt": continueAt.map { $0 as Any } ?? NSNull(),
                  "continueMonoMs": continueMonoMs.map { $0 as Any } ?? NSNull(), "stopSignals": stopSignals,
                  "continueSignals": continueSignals, "stoppedConfirmed": stoppedConfirmed, "resumedConfirmed": resumedConfirmed])
        return persistJournal()
    }
}
