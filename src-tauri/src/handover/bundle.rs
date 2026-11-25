use base64::{Engine as _, engine::general_purpose::STANDARD};
use qrcode::{QrCode, render::svg};
use statglass_proto::{
    handover::{HandoverReason, HostBundle, UnavailableHost, encode_bundle},
    pairing::BundleHost,
};
use statglass_remote::{AuthorizedKeys, EcdsaP256Public, Handover, ssh_config::handover_host};

use super::*;

pub(super) struct PreparedOffer {
    bundle: HostBundle,
    text: String,
    qr_svg: String,
}

fn resolve_hosts(
    hosts: Vec<RemoteHost>,
    resolve: impl Fn(&HandoverInput) -> Result<BundleHost, HandoverReason>,
) -> Handover {
    let mut handover = Handover {
        hosts: Vec::new(),
        unavailable: Vec::new(),
    };
    for host in hosts.into_iter().filter(|host| host.enabled) {
        match resolve(&host.input) {
            Ok(host) => handover.hosts.push(host),
            Err(reason) => handover.unavailable.push(UnavailableHost {
                host_id: host.input.host_id,
                name: host.input.name,
                reason,
            }),
        }
    }
    handover
}

fn install(key: &EcdsaP256Public, name: &str) -> IntentOp {
    IntentOp::Install {
        key: STANDARD.encode(key.0),
        name: name.into(),
    }
}

impl HandoverSource for Controller {
    fn handover(&self, device: DeviceTag, key: &EcdsaP256Public, name: &str) -> Handover {
        self.approve(device, key, name, |input| handover_host(input, None))
    }
}

impl Controller {
    pub(super) fn approve(
        &self,
        device: DeviceTag,
        key: &EcdsaP256Public,
        name: &str,
        resolve: impl Fn(&HandoverInput) -> Result<BundleHost, HandoverReason>,
    ) -> Handover {
        let mut snapshot = resolve_hosts((self.hosts)(), resolve);
        let op = install(key, name);
        snapshot.hosts.retain(|host| {
            match self.record(host.host_id, device, op.clone()) {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(host = %host.host_id, %device, ?error, "recording device install");
                    snapshot.unavailable.push(UnavailableHost {
                        host_id: host.host_id,
                        name: host.name.clone(),
                        reason: HandoverReason::Unresolvable,
                    });
                    false
                }
            }
        });
        if !snapshot.hosts.is_empty() {
            self.wake();
        }
        snapshot
    }

    pub(super) fn prepare_offer(&self) -> Result<PreparedOffer, CommandError> {
        self.prepare_with(|input| handover_host(input, None))
    }

    pub(super) fn prepare_with(
        &self,
        resolve: impl Fn(&HandoverInput) -> Result<BundleHost, HandoverReason>,
    ) -> Result<PreparedOffer, CommandError> {
        let snapshot = resolve_hosts((self.hosts)(), resolve);
        let bundle = HostBundle {
            version: 1,
            from: self.from,
            hosts: snapshot.hosts,
            unavailable: snapshot.unavailable,
            issued_ms: wall_ms(),
        };
        let text = encode_bundle(&bundle);
        let qr = QrCode::new(&text).map_err(|error| {
            handover_error(format!("Couldn’t generate the update QR code. {error}"))
        })?;
        Ok(PreparedOffer {
            bundle,
            text,
            qr_svg: qr.render::<svg::Color>().build(),
        })
    }

    pub(super) fn finish_offer(
        &self,
        offer: PreparedOffer,
        keys: &AuthorizedKeys,
    ) -> Result<HandoverOffer, CommandError> {
        let PreparedOffer {
            bundle,
            text,
            qr_svg,
        } = offer;
        if !bundle.hosts.is_empty() {
            self.provision(&bundle.hosts, keys)?;
        }
        Ok(HandoverOffer {
            text,
            qr_svg,
            hosts: bundle.hosts.into_iter().map(|host| host.name).collect(),
            unavailable: bundle.unavailable.into_iter().map(Into::into).collect(),
            issued_ms: bundle.issued_ms,
        })
    }

    fn provision(&self, hosts: &[BundleHost], keys: &AuthorizedKeys) -> Result<(), CommandError> {
        let log = self.log()?;
        let devices = keys.list_device_keys().map_err(handover_error)?;
        let mut queued = false;
        let result = devices.into_iter().try_for_each(|(device, name, key)| {
            let installed = log.installed_hosts(&device).map_err(handover_error)?;
            let op = install(&key, &name);
            for host in hosts
                .iter()
                .filter(|host| !installed.contains(&host.host_id))
            {
                self.record(host.host_id, device, op.clone())?;
                queued = true;
            }
            Ok(())
        });
        if queued {
            self.wake();
        }
        result
    }
}

impl From<UnavailableHost> for HandoverUnavailableInfo {
    fn from(host: UnavailableHost) -> Self {
        let reason = match host.reason {
            HandoverReason::ProxyJump => HandoverReasonInfo::ProxyJump,
            HandoverReason::ProxyCommand => HandoverReasonInfo::ProxyCommand,
            HandoverReason::LanLiteral => HandoverReasonInfo::LanLiteral,
            HandoverReason::NoHostKey => HandoverReasonInfo::NoHostKey,
            HandoverReason::Unresolvable => HandoverReasonInfo::Unresolvable,
        };
        Self {
            id: host.host_id,
            name: host.name,
            reason,
        }
    }
}
