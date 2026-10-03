import ExpoModulesCore
import Foundation

public final class PiSshModule: Module {
  private let bridge = PiSshBridge()

  private func completion(_ promise: Promise) -> PiSshCompletion {
    return { result, code, message in
      if let code = code {
        promise.reject(code, message ?? "SSH operation failed")
      } else {
        promise.resolve(result)
      }
    }
  }

  // Keep Objective-C conversion and callback bodies outside Expo's result
  // builder. This also gives Swift a concrete function type for each binding.
  private func createBridge() {
    bridge.emitter = { [weak self] name, body in
      self?.sendEvent(name, body)
    }
  }

  private func connect(_ options: [String: Any], _ promise: Promise) {
    bridge.connect(options, completion: completion(promise))
  }

  private func respondHostKey(_ requestId: String, _ accept: Bool) -> Bool {
    return bridge.respondHostKey(requestId, accept: accept)
  }

  private func execute(
    _ connectionId: String,
    _ command: String,
    _ stdin: String?,
    _ timeoutMs: Double?,
    _ promise: Promise
  ) {
    let timeout: NSNumber? = timeoutMs.map { NSNumber(value: $0) }
    bridge.exec(connectionId, command: command, input: stdin,
                timeoutMs: timeout, completion: completion(promise))
  }

  private func isConnected(_ connectionId: String) -> Bool {
    return bridge.isConnected(connectionId)
  }

  private func disconnect(_ connectionId: String) {
    bridge.disconnect(connectionId)
  }

  private func generateKeyPair(_ comment: String, _ promise: Promise) {
    bridge.generateKeyPair(comment, completion: completion(promise))
  }

  public func definition() -> ModuleDefinition {
    Name("PiSsh")
    Events("onHostKey", "onConnectionClose")
    OnCreate(self.createBridge)
    AsyncFunction("connect", self.connect)
    Function("respondHostKey", self.respondHostKey)
    AsyncFunction("exec", self.execute)
    Function("isConnected", self.isConnected)
    Function("disconnect", self.disconnect)
    AsyncFunction("generateKeyPair", self.generateKeyPair)
    OnDestroy { self.bridge.destroy() }
  }
}
