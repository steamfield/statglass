import Foundation

/// A typed failure of the Swift side, sent to JS as a coded exception (`NativeModuleError`
/// in `src/StatglassNative.types.ts`).
enum NativeFailure: Error {
  case keychain(osStatus: OSStatus, message: String)
  case secureEnclave(osStatus: OSStatus?, message: String)
  case localNetwork(message: String)
}

/// The phone's SSH key. One implementation per build environment, chosen at compile time
/// so a device build can never fall back to a software key.
protocol PhoneKey {
  /// The SEC1 uncompressed P-256 public key, 65 bytes.
  func publicKey() throws -> Data
  /// ECDSA P-256 over SHA-256 of `data`, ASN.1 DER
  /// (`SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)`), returned unchanged.
  func sign(_ data: Data) throws -> Data
}

/// A Secure Enclave P-256 key, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
/// created on first use under a fixed Keychain tag (phase 4 lane b).
struct SecureEnclaveKey: PhoneKey {
  func publicKey() throws -> Data {
    throw NativeFailure.secureEnclave(osStatus: nil, message: "not implemented")
  }

  func sign(_ data: Data) throws -> Data {
    _ = data
    throw NativeFailure.secureEnclave(osStatus: nil, message: "not implemented")
  }
}

/// A Keychain `ThisDeviceOnly` software P-256 key for the simulator, which has no Secure
/// Enclave (phase 4 lane b).
struct SimulatorKey: PhoneKey {
  func publicKey() throws -> Data {
    throw NativeFailure.keychain(osStatus: errSecUnimplemented, message: "not implemented")
  }

  func sign(_ data: Data) throws -> Data {
    _ = data
    throw NativeFailure.keychain(osStatus: errSecUnimplemented, message: "not implemented")
  }
}

/// The key this build signs with.
func currentPhoneKey() -> PhoneKey {
  #if targetEnvironment(simulator)
    return SimulatorKey()
  #else
    return SecureEnclaveKey()
  #endif
}
