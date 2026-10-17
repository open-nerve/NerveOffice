// 本任务自然隐藏夹具；精确绑定单一 Safari 测试窗口，不向 Safari 发进程信号。
import AppKit
import ApplicationServices
import Foundation
import Darwin

enum FixtureError: Error { case refused(String) }
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 5, ["minimize", "hide", "space"].contains(args[0]), args[1].hasPrefix("NerveOffice M4-P6 ") else { exit(2) }
let windowID = Int(args[2]) ?? 0
let safariPID = Int32(args[3]) ?? 0
let url = URL(string: args[4])
guard windowID > 0, safariPID > 1, url?.scheme == "http", url?.host == "127.0.0.1", (url?.port ?? 0) >= 1024,
      url?.path.hasPrefix("/documents/") == true, url?.user == nil, url?.password == nil, url?.fragment == nil,
      NSRunningApplication(processIdentifier: safariPID)?.bundleIdentifier == "com.apple.Safari" else { exit(2) }
let mode = args[0]
let owner = getppid()
let safari = NSRunningApplication(processIdentifier: safariPID)!
let safariAX = AXUIElementCreateApplication(safariPID)
let controlLock = NSLock()
var control: String?
DispatchQueue.global().async {
    let line = readLine()
    controlLock.lock(); control = line == "restore" ? "requested" : "owner-ended"; controlLock.unlock()
}
signal(SIGPIPE, SIG_IGN)

func applicationHidden() throws -> Bool {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(safariAX, kAXHiddenAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw FixtureError.refused("application hidden state unavailable") }
    return CFBooleanGetValue((value as! CFBoolean))
}
func setApplicationHidden(_ hidden: Bool) throws {
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(safariAX, kAXHiddenAttribute as CFString, &settable) == .success, settable.boolValue,
          AXUIElementSetAttributeValue(safariAX, kAXHiddenAttribute as CFString, hidden ? kCFBooleanTrue : kCFBooleanFalse) == .success else {
        throw FixtureError.refused("application visibility operation unavailable")
    }
}
func windowOperation(_ operation: String) throws -> Bool {
    let script = """
    function run(a) {
      const s=Application('Safari'), windows=s.windows();
      if(windows.length!==1) throw Error('not exclusive');
      const w=windows[0], tabs=w.tabs();
      if(w.id()!==Number(a[0]) || !w.name().startsWith(a[1]+' — ') || tabs.length!==1 || tabs[0].url()!==a[2]) throw Error('binding changed');
      if(a[3]==='minimize') w.miniaturized=true;
      if(a[3]==='restore') w.miniaturized=false;
      if(a[3]==='activate') s.activate();
      return JSON.stringify({miniaturized:w.miniaturized()});
    }
    """
    let task = Process(); let pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = ["-l", "JavaScript", "-e", script, String(windowID), args[1], args[4], operation]
    task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
    try task.run()
    let until = Date().addingTimeInterval(5)
    while task.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.02) }
    if task.isRunning { task.terminate(); task.waitUntilExit(); throw FixtureError.refused("window query timeout") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard task.terminationStatus == 0, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let minimized = result["miniaturized"] as? Bool else { throw FixtureError.refused("window binding refused") }
    return minimized
}

final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow?
    var stage = "preparing"
    var changed = false
    var failed = false
    var reason = "requested"
    var deadline = Date().addingTimeInterval(20)
    var spaceChanges = 0
    var hiddenSpaceChanges = 0
    var enteredFullScreen = false
    var exitedFullScreen = false
    var lastSample = Date.distantPast
    var timer: Timer?
    var spaceObserver: NSObjectProtocol?
    var keyObserver: Any?
    var signalSources: [DispatchSourceSignal] = []

    func emit(_ kind: String, _ extra: [String: Any] = [:]) {
        var value: [String: Any] = ["kind": kind, "at": Int(Date().timeIntervalSince1970 * 1000), "mode": mode, "windowId": windowID, "safariPid": safariPID,
            "appHidden": safari.isHidden, "spaceChanges": spaceChanges, "fixtureLaunched": NSRunningApplication.current.isFinishedLaunching]
        if let hidden = try? applicationHidden() { value["axHidden"] = hidden }
        if let window {
            value["fullScreen"] = window.styleMask.contains(.fullScreen)
            value["onActiveSpace"] = window.isOnActiveSpace
            value["windowVisible"] = window.isVisible
            value["enteredFullScreen"] = enteredFullScreen
            value["exitedFullScreen"] = exitedFullScreen
        }
        for (key, item) in extra { value[key] = item }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.spaceChanges += 1 }
        keyObserver = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.beginRestore("user-escape"); return nil }
            return event
        }
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.beginRestore("signal") }
            source.resume(); signalSources.append(source)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        do {
            guard try !applicationHidden(), try !windowOperation("check") else { throw FixtureError.refused("not initially visible") }
            emit("before")
            changed = true
            stage = "hiding"
            deadline = Date().addingTimeInterval(20)
            if mode == "minimize" { _ = try windowOperation("minimize") }
            else if mode == "hide" { try setApplicationHidden(true) }
            else {
                let created = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1000, height: 700), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
                created.isReleasedWhenClosed = false
                created.title = "NerveOffice 自然后台观察：本任务测试桌面"
                created.collectionBehavior = [.fullScreenPrimary]
                created.delegate = self
                let label = NSTextField(labelWithString: "Safari 留在原桌面；本窗口观察自然后台行为。按 Esc 中止。")
                label.frame = NSRect(x: 40, y: 300, width: 920, height: 80)
                created.contentView?.addSubview(label)
                window = created
                created.makeKeyAndOrderFront(nil)
                NSApplication.shared.activate(ignoringOtherApps: true)
                created.toggleFullScreen(nil)
            }
        } catch { reject(error) }
    }
    func reject(_ error: Error) {
        let message: String
        if case FixtureError.refused(let text) = error { message = text } else { message = "native operation failed" }
        failed = true
        emit("failed", ["reason": message])
        if stage == "restoring" { finish(false) } else { beginRestore("condition-failed") }
    }
    func beginRestore(_ why: String) {
        if stage == "restoring" || stage == "finished" { return }
        reason = why
        failed = failed || why != "requested"
        stage = "restoring"
        deadline = Date().addingTimeInterval(20)
        if !changed { finish(false); return }
        do {
            _ = try windowOperation(mode == "minimize" ? "restore" : "check")
            if mode == "hide", try applicationHidden() { try setApplicationHidden(false) }
            if mode == "space", let window {
                hiddenSpaceChanges = spaceChanges
                if window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
                else { window.close(); exitedFullScreen = true }
            }
        } catch { reject(error) }
    }
    func tick() {
        if stage == "finished" { return }
        controlLock.lock(); let requested = control; controlLock.unlock()
        if stage != "restoring", let requested { beginRestore(requested); return }
        if stage != "restoring", getppid() != owner { beginRestore("owner-ended"); return }
        if Date() >= deadline {
            if stage == "restoring" { emit("restore-failed", ["reason": "restore deadline"]); finish(false) }
            else { emit("deadline"); beginRestore("deadline") }
            return
        }
        do {
            if stage == "hiding" {
                let ready: Bool
                if mode == "minimize" { ready = try windowOperation("check") }
                else if mode == "hide" { ready = try applicationHidden() }
                else { ready = enteredFullScreen && window?.styleMask.contains(.fullScreen) == true && window?.isOnActiveSpace == true && spaceChanges > 0 }
                if ready {
                    stage = "observing"
                    deadline = Date().addingTimeInterval(300)
                    emit("hidden", ["miniaturized": mode == "minimize"])
                }
            } else if stage == "observing" {
                if Date().timeIntervalSince(lastSample) >= 5 { lastSample = Date(); emit("sample") }
            } else if stage == "restoring" {
                if mode == "space", (!exitedFullScreen || spaceChanges <= hiddenSpaceChanges) { return }
                if mode == "space", let window, window.isVisible { window.close() }
                guard try !windowOperation("check"), try !applicationHidden() else { return }
                _ = try windowOperation("activate")
                emit("restored", ["miniaturized": false])
                finish(!failed)
            }
        } catch { reject(error) }
    }
    func windowDidEnterFullScreen(_ notification: Notification) { enteredFullScreen = true; emit("entered-full-screen") }
    func windowDidExitFullScreen(_ notification: Notification) { exitedFullScreen = true; emit("exited-full-screen") }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) { reject(FixtureError.refused("full screen entry failed")) }
    func windowDidFailToExitFullScreen(_ window: NSWindow) { reject(FixtureError.refused("full screen exit failed")) }
    func finish(_ success: Bool) {
        stage = "finished"
        timer?.invalidate()
        window?.orderOut(nil); window?.close()
        if let spaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(spaceObserver) }
        if let keyObserver { NSEvent.removeMonitor(keyObserver) }
        emit("finished", ["success": success, "reason": reason, "ownerStillPresent": getppid() == owner])
        exit(success ? 0 : 1)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
app.delegate = fixture
app.run()
