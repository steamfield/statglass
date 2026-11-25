import Security
import XCTest
@testable import NativeFailure

final class NativeFailureTests: XCTestCase {
  // These are the same Expo codes and messages that native-error.test.ts decodes.
  func testMissingPhoneKey() {
    let failure = NativeFailure.phoneKey(
      status: errSecItemNotFound, secureEnclave: true, message: "Could not load the phone key"
    )
    XCTAssertEqual(failure.code, "ERR_STATGLASS_KEYCHAIN")
    XCTAssertEqual(failure.description, "Could not load the phone key (OSStatus -25300)")
  }

  func testLockedPhoneKey() {
    let failure = NativeFailure.phoneKey(
      status: errSecInteractionNotAllowed, secureEnclave: true, message: "Could not sign with the phone key"
    )
    XCTAssertEqual(failure.code, "ERR_STATGLASS_KEYCHAIN")
    XCTAssertEqual(failure.description, "Could not sign with the phone key (OSStatus -25308)")
  }

  func testSecureEnclaveFailure() {
    let failure = NativeFailure.phoneKey(
      status: errSecParam, secureEnclave: true, message: "Could not create the phone key"
    )
    XCTAssertEqual(failure.code, "ERR_STATGLASS_SECURE_ENCLAVE")
    XCTAssertEqual(failure.description, "Could not create the phone key (OSStatus -50)")
  }

  func testCameraFailureWithoutStatus() {
    let failure = NativeFailure.camera(message: "Could not access the camera")
    XCTAssertEqual(failure.code, "ERR_STATGLASS_CAMERA")
    XCTAssertEqual(failure.description, "Could not access the camera")
  }
}
