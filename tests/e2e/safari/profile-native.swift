// 原有读取与单 PID SIGKILL 入口；身份实现与暂停守护共用，不放宽原条件。
import Foundation
import Darwin

@main
struct ProfileNativeMain {
    static func main() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let mode = args.first else { reject("缺少操作模式") }
        if mode == "read" {
            guard args.count > 1, args.count <= 2049 else { reject("读取范围无效") }
            let pids = args.dropFirst().compactMap(Int32.init)
            guard pids.count == args.count - 1, Set(pids).count == pids.count, pids.allSatisfy({ $0 > 1 }) else { reject("读取 PID 无效") }
            let data = try JSONEncoder().encode(pids.compactMap(identity))
            FileHandle.standardOutput.write(data)
        } else if mode == "signal" || mode == "check-signal" {
            guard args.count == 1 else { reject("信号模式不接受额外参数") }
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 8192, let request = try? JSONDecoder().decode(SignalRequest.self, from: data) else { reject("信号身份格式无效") }
            let expected = request.target
            guard expected.pid > 1, request.mainPid > 1, expected.pid != request.mainPid, expected.uid == getuid(), expected.appleSigned,
                  expected.bundleId == "com.apple.WebKit.WebContent", executables.contains(expected.executable),
                  request.observedAt > 0, now() >= request.observedAt, now() - request.observedAt <= 2000, now() < request.deadline else { reject("信号身份或时限无效") }
            guard let current = identity(expected.pid), current == expected, desktopEligible(), sameKernelIdentity(expected) else { reject("临发前桌面、内核身份或签名不符") }
            let checkedAt = now()
            let age = checkedAt - request.observedAt
            guard age >= 0, age <= 2000, checkedAt < request.deadline else { reject("临发前观察过期、运行超时或时钟倒退") }
            if mode == "check-signal" {
                FileHandle.standardOutput.write(Data("{\"kind\":\"checked-only\",\"signalsSent\":0}".utf8))
            } else {
                let sentAt = now()
                guard kill(expected.pid, SIGKILL) == 0 else { reject("单 PID SIGKILL 未成功") }
                let result: [String: Any] = ["kind": "signaled", "pid": expected.pid, "startedAtUs": expected.startedAtUs, "signal": "SIGKILL", "sentAt": sentAt, "signalsSent": 1]
                FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
            }
        } else {
            reject("未知操作模式")
        }
    }
}
