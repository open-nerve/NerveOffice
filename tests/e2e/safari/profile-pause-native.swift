// 真实 Safari 入口，不接受测试模式、任意进程或省略身份的信号请求。
import Foundation
import Darwin

@main
struct ProfilePauseMain {
    static func main() {
        guard CommandLine.arguments.count == 1 else { reject("暂停守护不接受额外参数") }
        let guardian = ProfilePauseGuard(qualify: { request in
            let expected = request.target
            guard expected.appleSigned, expected.bundleId == "com.apple.WebKit.WebContent",
                  executables.contains(expected.executable), identity(expected.pid) == expected,
                  let current = pauseKernel(expected.pid), !current.stopped else { return nil }
            return current.process
        }, desktop: pauseDesktopFailure)
        if !guardian.run() { reject("暂停守护初始化或原件落盘失败") }
    }
}
