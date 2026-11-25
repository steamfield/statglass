import Foundation
import os
import Security

/// A failure of the native signer, with the Security framework's status when available.
enum NativeFailure: Error, CustomStringConvertible {
  case keychain(osStatus: OSStatus, message: String)
  case secureEnclave(osStatus: OSStatus?, message: String)
  case camera(message: String)
  case localNetwork(message: String)

  var description: String {
    switch self {
    case let .keychain(status, message), let .secureEnclave(.some(status), message):
      return "\(message) (OSStatus \(status))"
    case let .secureEnclave(nil, message), let .camera(message), let .localNetwork(message):
      return message
    }
  }
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

/// A Secure Enclave P-256 key, created on first use under a fixed Keychain tag.
struct SecureEnclaveKey: PhoneKey {
  private static let storage = KeychainPhoneKey(secureEnclave: true)

  func publicKey() throws -> Data { try Self.storage.publicKey() }
  func sign(_ data: Data) throws -> Data { try Self.storage.sign(data) }
}

/// A Keychain `ThisDeviceOnly` software P-256 key for the simulator, which has no Secure
/// Enclave.
struct SimulatorKey: PhoneKey {
  private static let storage = KeychainPhoneKey(secureEnclave: false)

  func publicKey() throws -> Data { try Self.storage.publicKey() }
  func sign(_ data: Data) throws -> Data { try Self.storage.sign(data) }
}

/// The key this build signs with.
func currentPhoneKey() -> PhoneKey {
  #if targetEnvironment(simulator)
    return SimulatorKey()
  #else
    return SecureEnclaveKey()
  #endif
}

private struct KeychainPhoneKey {
  let secureEnclave: Bool
  private let cachedKey = OSAllocatedUnfairLock<SecKey?>(initialState: nil)
  private let tag = Data("app.statglass.phone-key".utf8)

  func publicKey() throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(try privateKey()) else {
      throw keyFailure(errSecInvalidKeyRef, "Could not get the phone's public key")
    }
    var error: Unmanaged<CFError>?
    guard let point = SecKeyCopyExternalRepresentation(publicKey, &error) else {
      throw keyFailure(status(error), "Could not export the phone's public key")
    }
    return point as Data
  }

  func sign(_ data: Data) throws -> Data {
    let key = try privateKey()
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) else {
      throw keyFailure(status(error), "Could not sign with the phone key")
    }
    return signature as Data
  }

  private func privateKey() throws -> SecKey {
    try cachedKey.withLock { key in
      if let key { return key }
      let loaded = try loadOrCreate()
      key = loaded
      return loaded
    }
  }

  private func loadOrCreate() throws -> SecKey {
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag as String: tag,
      kSecReturnRef as String: true,
    ]
    if secureEnclave {
      query[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    }
    var result: CFTypeRef?
    let lookup = SecItemCopyMatching(query as CFDictionary, &result)
    if lookup == errSecItemNotFound { return try create() }
    guard lookup == errSecSuccess else {
      throw NativeFailure.keychain(osStatus: lookup, message: "Could not load the phone key")
    }
    guard let result, CFGetTypeID(result) == SecKeyGetTypeID() else {
      throw NativeFailure.keychain(osStatus: errSecInvalidKeyRef, message: "Keychain returned an invalid phone key")
    }
    // Security returns a CFTypeRef even when the query requests a key reference.
    return (result as! SecKey)
  }

  private func create() throws -> SecKey {
    let accessibility = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    var privateAttributes: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
    ]
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var error: Unmanaged<CFError>?
    if secureEnclave {
      guard let access = SecAccessControlCreateWithFlags(nil, accessibility, .privateKeyUsage, &error) else {
        throw keyFailure(status(error), "Could not set access for the Secure Enclave key")
      }
      privateAttributes[kSecAttrAccessControl as String] = access
      attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    } else {
      privateAttributes[kSecAttrAccessible as String] = accessibility
    }
    attributes[kSecPrivateKeyAttrs as String] = privateAttributes

    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw keyFailure(status(error), "Could not create the phone key")
    }
    return key
  }

  private func keyFailure(_ status: OSStatus, _ message: String) -> NativeFailure {
    secureEnclave
      ? .secureEnclave(osStatus: status, message: message)
      : .keychain(osStatus: status, message: message)
  }

  private func status(_ error: Unmanaged<CFError>?) -> OSStatus {
    error.map { OSStatus(truncatingIfNeeded: CFErrorGetCode($0.takeRetainedValue())) } ?? errSecInternalComponent
  }
}
