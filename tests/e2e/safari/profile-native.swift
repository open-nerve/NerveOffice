// macOS 专用测试适配器：读取内核/签名/LS 身份；信号模式只接受一个完整且新鲜的 WebContent 身份。
// profile/window/URL 的归属先由 profile-process 判定，不能由此文件单独认领进程。
import Foundation
import CoreFoundation
import Darwin
import Security

struct Identity: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let startedAtUs: String
    let executable: String
    let bundleId: String
    let asn: String
    let appleSigned: Bool
}

struct SignalRequest: Decodable {
    let target: Identity
    let mainPid: Int32
    let observedAt: Int64
    let deadline: Int64
}

typealias Match = @convention(c) (Int32, CFIndex, UnsafeMutablePointer<CFTypeRef?>?, UnsafeMutablePointer<CFTypeRef?>?) -> Unmanaged<CFArray>?
typealias Item = @convention(c) (Int32, CFTypeRef, CFTypeRef) -> Unmanaged<CFTypeRef>?
let webContent = "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"
let executables = Set([webContent, "/System/Volumes/Preboot/Cryptexes/App" + webContent, "/System/Volumes/Preboot/Cryptexes/Incoming/OS" + webContent])

func reject(_ reason: String) -> Never {
    // 仅固定原因，不输出进程参数、URL、用户页面或收到的 JSON。
    FileHandle.standardError.write(Data((reason + "\n").utf8))
    exit(2)
}

guard let library = dlopen("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/LaunchServices", RTLD_NOW),
      let matchSymbol = dlsym(library, "_LSCopyMatchingApplicationsWithItems"),
      let itemSymbol = dlsym(library, "_LSCopyApplicationInformationItem") else { reject("LaunchServices 身份接口不可用") }
let match = unsafeBitCast(matchSymbol, to: Match.self)
let item = unsafeBitCast(itemSymbol, to: Item.self)

func identity(_ pid: Int32) -> Identity? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          info.pbi_status != UInt32(SZOMB) else { return nil }
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
    var keys: [CFTypeRef?] = ["pid" as CFString]
    var values: [CFTypeRef?] = [NSNumber(value: pid)]
    guard let applications = match(-2, 1, &keys, &values)?.takeRetainedValue(), CFArrayGetCount(applications) == 1 else { return nil }
    let asn = Unmanaged<CFTypeRef>.fromOpaque(CFArrayGetValueAtIndex(applications, 0)).takeUnretainedValue()
    guard let description = CFCopyDescription(asn) as String?,
          description.hasPrefix("LSASN:{"), description.hasSuffix("}"),
          let bundle = item(-2, asn, "CFBundleIdentifier" as CFString)?.takeRetainedValue() as? String else { return nil }
    let normalizedAsn = "ASN:" + description.dropFirst(7).dropLast() + ":"
    var code: SecCode?
    var requirement: SecRequirement?
    let guestStatus = SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary, [], &code)
    let requirementStatus = SecRequirementCreateWithString("anchor apple and identifier \"com.apple.WebKit.WebContent\"" as CFString, [], &requirement)
    let signed: Bool
    if guestStatus == errSecSuccess, requirementStatus == errSecSuccess, let code, let requirement {
        signed = SecCodeCheckValidity(code, [], requirement) == errSecSuccess
    } else {
        signed = false
    }
    // 再取一次出生身份，避免多次系统查询期间 PID 已经退出重用。
    var after = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          after.pbi_start_tvsec == info.pbi_start_tvsec, after.pbi_start_tvusec == info.pbi_start_tvusec, after.pbi_uid == info.pbi_uid else { return nil }
    return Identity(pid: pid, uid: info.pbi_uid, startedAtUs: String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec), executable: String(cString: path), bundleId: bundle, asn: normalizedAsn, appleSigned: signed)
}

func ioreg(_ arguments: [String]) -> String? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
    task.arguments = arguments
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { return nil }
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    return task.terminationStatus == 0 ? String(data: output, encoding: .utf8) : nil
}

func desktopEligible() -> Bool {
    guard let hid = ioreg(["-r", "-k", "HIDIdleTime", "-d", "1"]),
          let expression = try? NSRegularExpression(pattern: "\"HIDIdleTime\" = ([0-9]+)"),
          let found = expression.firstMatch(in: hid, range: NSRange(hid.startIndex..., in: hid)),
          let range = Range(found.range(at: 1), in: hid), let nanoseconds = Double(hid[range]), nanoseconds >= 120_000_000_000,
          let console = ioreg(["-n", "Root", "-d1"]) else { return false }
    return !console.contains("\"CGSSessionScreenIsLocked\"=Yes") && console.contains("\"kCGSSessionOnConsoleKey\"=Yes")
}

func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

// 最后的桌面检查之后只执行便宜的内核读取，不再调用 LS 或签名服务。
func sameKernelIdentity(_ expected: Identity) -> Bool {
    var info = proc_bsdinfo()
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidinfo(expected.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          info.pbi_status != UInt32(SZOMB), info.pbi_uid == expected.uid,
          String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec) == expected.startedAtUs,
          proc_pidpath(expected.pid, &path, UInt32(path.count)) > 0 else { return false }
    return String(cString: path) == expected.executable
}

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
