use serde::{Deserialize, Serialize};
use statglass_proto::handover::{
    HandoverReason, HostBundle, UnavailableHost, decode_bundle, encode_bundle,
};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleRoute, BundleTarget, PairError, PairReply, PairingPayload,
    decode_pair_body, encode_pair_frame, encode_payload, parse_payload,
};
use statglass_schema::HostId;
use uuid::Uuid;

fn id(n: u128) -> HostId {
    HostId(Uuid::from_u128(n))
}

fn host(n: u128) -> BundleHost {
    BundleHost {
        host_id: id(n),
        name: format!("CI {n}"),
        os: "linux".into(),
        user: "riley".into(),
        port: None,
        targets: vec![BundleTarget {
            route: BundleRoute::Lan,
            host: format!("ci-{n}.local"),
        }],
        host_keys: vec![BundleHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: format!("SHA256:{n:x}{}e8A", "Ab3z".repeat(9) + "Ab3"),
        }],
    }
}

fn bundle(hosts: Vec<BundleHost>) -> HostBundle {
    HostBundle {
        version: 1,
        from: id(100),
        hosts,
        unavailable: Vec::new(),
        issued_ms: 1_800_000_060_000,
    }
}

fn unavailable() -> UnavailableHost {
    UnavailableHost {
        host_id: id(99),
        name: "Build warehouse".into(),
        reason: HandoverReason::ProxyJump,
    }
}

#[test]
fn handover_bundle_fits_ten_hosts_in_a_qr() {
    let bundle = bundle((0..10).map(host).collect());
    let text = encode_bundle(&bundle);
    assert!(text.starts_with("SGB1:"));
    assert!(text.len() < 1200, "{} bytes", text.len());
    eprintln!("Ten-host SGB1 text: {} bytes", text.len());
    assert_eq!(decode_bundle(&text), Ok(bundle));
}

#[test]
fn handover_bundle_round_trips_multi_route_hosts_and_textual_pins() {
    let mut custom = host(2);
    custom.os = "Example OS".into();
    custom.user = "deploy".into();
    custom.port = Some(2222);
    custom.targets.push(BundleTarget {
        route: BundleRoute::Tailscale,
        host: "ci-2.example.ts.net".into(),
    });
    custom.host_keys.push(BundleHostKey {
        algorithm: "ssh-rsa".into(),
        sha256: host(4).host_keys[0].sha256.clone(),
    });
    custom.host_keys.push(BundleHostKey {
        algorithm: "different-algorithm".into(),
        sha256: "SHA256:example".into(),
    });
    let bundle = HostBundle {
        unavailable: vec![unavailable()],
        ..bundle(vec![host(1), custom])
    };
    assert_eq!(decode_bundle(&encode_bundle(&bundle)), Ok(bundle));
}

#[test]
fn handover_and_pairing_reject_each_others_codes_and_invalid_bundles() {
    let bundle = bundle(vec![host(1)]);
    let pairing = encode_payload(&PairingPayload {
        version: 1,
        host: host(1),
        pairing_key: [1; 32],
        nonce: "123456789abcdef0123456789abcdef0".into(),
        code: "ABC234".into(),
        expires_ms: bundle.issued_ms,
        can_hand_over: true,
    });
    let text = encode_bundle(&bundle);
    assert_eq!(parse_payload(&text), Err(PairError::Invalid));
    let mut corrupt = text.clone();
    if let Some(digit) = corrupt.get(5..6) {
        let replacement = if digit == "0" { "1" } else { "0" };
        corrupt.replace_range(5..6, replacement);
    }
    for bad in [
        pairing,
        corrupt,
        "SGB1:".into(),
        format!("SGB1:{}", "A".repeat(32_769)),
        encode_bundle(&HostBundle {
            version: 2,
            ..bundle
        }),
    ] {
        assert_eq!(decode_bundle(&bad), Err(PairError::Invalid));
    }
}

// The phase 5 approval layout had no unavailable field.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PhaseFiveReply {
    Approved {
        device: String,
        hosts: Vec<BundleHost>,
    },
}

#[test]
fn handover_approval_decodes_an_old_reply_without_unavailable() {
    let hosts = vec![host(1)];
    let device = "ABCDEF".to_owned();
    // Phase 5 framing and BundleHost map, frozen before decoding either reply type.
    const PHASE_FIVE: &[u8] = b"\x00\x00\x00\xe3\xa3\x64kind\x68approved\x66device\x66ABCDEF\x65hosts\x81\
        \xa7\x67host_id\x50\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\
        \x64name\x64CI 1\x62os\x65linux\x64user\x65riley\x64port\xf6\x67targets\x81\xa2\x65route\x63lan\
        \x64host\x6aci-1.local\x69host_keys\x81\xa2\x69algorithm\x6bssh-ed25519\x66sha256\x78\x32\
        SHA256:1Ab3zAb3zAb3zAb3zAb3zAb3zAb3zAb3zAb3zAb3e8A";
    let old = encode_pair_frame(&PhaseFiveReply::Approved {
        device: device.clone(),
        hosts: hosts.clone(),
    })
    .unwrap();
    assert_eq!(old, PHASE_FIVE);
    assert_eq!(
        decode_pair_body::<PairReply>(&PHASE_FIVE[4..]).unwrap(),
        PairReply::Approved {
            device,
            hosts,
            unavailable: vec![]
        }
    );
}

#[test]
fn handover_approval_is_readable_by_the_old_phone() {
    let hosts = vec![host(1), host(2)];
    let device = "ABCDEF".to_owned();
    let reply = encode_pair_frame(&PairReply::Approved {
        device: device.clone(),
        hosts: hosts.clone(),
        unavailable: vec![unavailable()],
    })
    .unwrap();
    assert_eq!(
        decode_pair_body::<PhaseFiveReply>(&reply[4..]).unwrap(),
        PhaseFiveReply::Approved { device, hosts }
    );
}
