//! An in-process SSH dialer for hosts the phone has paired: russh over TCP, pinned host
//! keys, and public-key authentication through a [`Signer`] (the Secure Enclave on a
//! device). It implements `statglass_session::Dialer`.
mod dialer;
mod signer;

pub use dialer::{RusshConfig, RusshDialer};
#[cfg(any(test, feature = "software-signer"))]
pub use signer::SoftwareSigner;
pub use signer::{Signer, SignerError, der_to_ssh_signature};
