import Security

/// The code and message Expo passes to JavaScript on rejection.
enum NativeFailure: Error, CustomStringConvertible {
  case keychain(osStatus: OSStatus, message: String)
  case secureEnclave(osStatus: OSStatus?, message: String)
  case camera(message: String)

  static func phoneKey(status: OSStatus, secureEnclave: Bool, message: String) -> NativeFailure {
    if isUnavailableStatus(status) || !secureEnclave {
      return .keychain(osStatus: status, message: message)
    }
    return .secureEnclave(osStatus: status, message: message)
  }

  var isKeyUnavailable: Bool {
    switch self {
    case let .keychain(status, _), let .secureEnclave(.some(status), _):
      return Self.isUnavailableStatus(status)
    case .secureEnclave(nil, _), .camera:
      return false
    }
  }

  private static func isUnavailableStatus(_ status: OSStatus) -> Bool {
    status == errSecItemNotFound || status == errSecInteractionNotAllowed
  }

  var code: String {
    switch self {
    case .keychain: return "ERR_STATGLASS_KEYCHAIN"
    case .secureEnclave: return "ERR_STATGLASS_SECURE_ENCLAVE"
    case .camera: return "ERR_STATGLASS_CAMERA"
    }
  }

  var description: String {
    switch self {
    case let .keychain(status, message), let .secureEnclave(.some(status), message):
      return "\(message) (OSStatus \(status))"
    case let .secureEnclave(nil, message), let .camera(message):
      return message
    }
  }
}
