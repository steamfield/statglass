import Security

/// The code and message Expo passes to JavaScript on rejection.
enum NativeFailure: Error, CustomStringConvertible {
  case keychain(osStatus: OSStatus, message: String)
  case secureEnclave(osStatus: OSStatus?, message: String)
  case camera(message: String)

  static func phoneKey(status: OSStatus, secureEnclave: Bool, message: String) -> NativeFailure {
    if status == errSecItemNotFound || status == errSecInteractionNotAllowed || !secureEnclave {
      return .keychain(osStatus: status, message: message)
    }
    return .secureEnclave(osStatus: status, message: message)
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
