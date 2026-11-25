import ExpoModulesCore

extension NativeFailure {
  var exception: Exception {
    switch self {
    case .keychain: return KeychainException(self)
    case .secureEnclave: return SecureEnclaveException(self)
    case .camera: return CameraException(self)
    case .localNetwork: return LocalNetworkException(self)
    }
  }
}

private class NativeFailureException: GenericException<NativeFailure>, @unchecked Sendable {
  override var reason: String { param.description }
}

private final class KeychainException: NativeFailureException, @unchecked Sendable {
  override var code: String { "ERR_STATGLASS_KEYCHAIN" }
}

private final class SecureEnclaveException: NativeFailureException, @unchecked Sendable {
  override var code: String { "ERR_STATGLASS_SECURE_ENCLAVE" }
}

private final class CameraException: NativeFailureException, @unchecked Sendable {
  override var code: String { "ERR_STATGLASS_CAMERA" }
}

private final class LocalNetworkException: NativeFailureException, @unchecked Sendable {
  override var code: String { "ERR_STATGLASS_LOCAL_NETWORK" }
}
