// 专用校准入口：只能操纵此程序内部创建的 /bin/sleep；没有外部目标 PID 或路径参数。
import Foundation
import Darwin

@main
struct ProfilePauseCalibration {
    static func main() throws {
        let cases = Set(["normal", "deadline", "eof", "invalid-command", "oversized-input", "output-closed", "sigterm", "sigint", "sighup",
                         "user-activity", "screen-locked", "desktop-unavailable", "clock-changed", "target-exited", "externally-resumed", "initial-stopped", "controller-death", "production-refusal"])
        guard CommandLine.arguments.count == 2, let name = CommandLine.arguments.last, cases.contains(name) else { reject("校准只接受已列明的自有空进程用例") }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["600"]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        guard let target = pauseKernel(child.processIdentifier)?.process,
              target.ppid == UInt32(getpid()), target.uid == getuid(), target.executable == "/bin/sleep" else {
            child.terminate()
            child.waitUntilExit()
            reject("无法确认自有空进程出生身份")
        }
        var cleanupContinueSignals = 0
        var guardSucceeded = false
        // 这里只回收已登记出生身份的自有子进程。恢复计数另记，不能掩盖守护者漏发 CONT。
        defer {
            if let state = pauseKernel(target.pid), state.process == target {
                if state.stopped, kill(target.pid, SIGCONT) == 0 { cleanupContinueSignals += 1 }
                _ = kill(target.pid, SIGTERM)
            }
            child.waitUntilExit()
            let value: [String: Any] = ["reaped": !child.isRunning, "cleanupContinueSignals": cleanupContinueSignals]
            if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
                _ = data.withUnsafeBytes { write(5, $0.baseAddress, $0.count) }
                _ = fsync(5)
            }
        }
        if name == "initial-stopped" {
            guard kill(target.pid, SIGSTOP) == 0 else { return }
            let deadline = pauseMonoMs() + 1000
            while pauseMonoMs() < deadline && pauseKernel(target.pid)?.stopped != true { usleep(1000) }
            guard pauseKernel(target.pid)?.stopped == true else { return }
        }
        let metadata = try JSONSerialization.data(withJSONObject: ["target": target.json, "observedAt": now()], options: [.sortedKeys]) + Data([10])
        guard metadata.withUnsafeBytes({ write(4, $0.baseAddress, $0.count) == $0.count }) else { return }
        _ = close(4)
        var stoppedAt: Double?
        let triggered = { stoppedAt.map { pauseMonoMs() - $0 >= 500 } ?? false }
        let guardian = ProfilePauseGuard(qualify: { request in
            guard request.target.pid == target.pid, request.target.uid == target.uid,
                  request.target.startedAtUs == target.startedAtUs, request.target.executable == target.executable,
                  request.target.bundleId == "calibration-owned-sleep", request.target.asn == "calibration-owned-sleep", !request.target.appleSigned,
                  let current = pauseKernel(target.pid), current.process == target else { return nil }
            return current.process
        }, desktop: {
            if triggered(), ["user-activity", "screen-locked", "desktop-unavailable"].contains(name) { return name }
            return nil
        }, wall: {
            now() - (name == "clock-changed" && triggered() ? 10_000 : 0)
        }, didStop: { stoppedAt = pauseMonoMs() })
        guardSucceeded = guardian.run()
        // 原件完成后保留两秒供外部驱动独立核对真实内核状态，然后才执行上面的 owner cleanup。
        usleep(2_000_000)
        if !guardSucceeded { FileHandle.standardError.write(Data("原生守护没有完成原件\n".utf8)) }
    }
}
