// 仅服务于同一父进程本次 spawn 的 QEMU/Tart。实验信号只有 SIGKILL，清理另有显式模式。
import Foundation
import Darwin

struct Identity: Codable, Equatable {
    let pid: Int32
    let ppid: UInt32
    let uid: UInt32
    let startedAtUs: String
    let executable: String
}

struct Request: Decodable {
    let target: Identity
    let observedAt: Int64
    let deadline: Int64
}

func reject(_ reason: String) -> Never {
    FileHandle.standardError.write(Data((reason + "\n").utf8))
    exit(2)
}

func identity(_ pid: Int32) -> Identity? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          info.pbi_status != UInt32(SZOMB), proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
    var after = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          after.pbi_start_tvsec == info.pbi_start_tvsec, after.pbi_start_tvusec == info.pbi_start_tvusec,
          after.pbi_uid == info.pbi_uid, after.pbi_ppid == info.pbi_ppid else { return nil }
    return Identity(pid: pid, ppid: info.pbi_ppid, uid: info.pbi_uid,
                    startedAtUs: String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec), executable: String(cString: path))
}

func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { reject("缺少操作模式") }
if mode == "read" {
    guard args.count == 2, let pid = Int32(args[1]), let result = identity(pid) else { reject("VM 进程身份不可读") }
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} else if mode == "signal" || mode == "check-signal" || mode == "normal-stop" {
    guard args.count == 1 else { reject("信号模式不接受额外参数") }
    // 多读一个字节即可判断超限，不接受无限输入。
    let data = FileHandle.standardInput.readData(ofLength: 8193)
    guard data.count <= 8192, let request = try? JSONDecoder().decode(Request.self, from: data) else { reject("VM 信号身份格式无效") }
    let expected = request.target
    let executable = URL(fileURLWithPath: expected.executable).lastPathComponent
    guard expected.pid > 1, expected.ppid == UInt32(getppid()), expected.uid == getuid(),
          ["qemu-system-x86_64", "tart"].contains(executable),
          request.observedAt > 0, request.deadline > request.observedAt, request.deadline - request.observedAt <= 2000 else { reject("VM 归属或时限无效") }
    guard identity(expected.pid) == expected else { reject("VM 临发内核身份不符") }
    let checkedAt = now()
    guard checkedAt >= request.observedAt, checkedAt - request.observedAt <= 2000, checkedAt < request.deadline else { reject("VM 信号观察已过期或时钟倒退") }
    if mode == "check-signal" {
        FileHandle.standardOutput.write(Data("{\"kind\":\"checked-only\",\"signalsSent\":0}".utf8))
    } else {
        let signal = mode == "signal" ? SIGKILL : SIGINT
        let sentAt = now()
        guard kill(expected.pid, signal) == 0 else { reject("VM 单 PID 信号失败") }
        let result: [String: Any] = ["kind": mode == "signal" ? "signaled" : "cleanup",
                                   "pid": expected.pid, "startedAtUs": expected.startedAtUs,
                                   "signal": mode == "signal" ? "SIGKILL" : "SIGINT", "sentAt": sentAt, "signalsSent": 1]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
    }
} else {
    reject("未知操作模式")
}
