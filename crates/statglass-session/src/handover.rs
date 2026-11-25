//! Compares a controller's bundle with the hosts already on the phone.

use statglass_proto::{
    handover::{HostBundle, UnavailableHost},
    pairing::BundleHost,
};
use statglass_schema::HostId;

pub struct CurrentHost {
    pub endpoint: BundleHost,
    pub removed_by_controller: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reconcile {
    pub new: Vec<BundleHost>,
    pub removed: Vec<HostId>,
    pub changed: Vec<BundleHost>,
    pub unavailable: Vec<UnavailableHost>,
}

pub fn reconcile(_current: &[CurrentHost], _bundle: &HostBundle) -> Reconcile {
    Reconcile::default()
}
