use statglass_ipc::{
    error::CommandError,
    mobile::{HostAddressesInfo, PublicIpInfo},
};
use statglass_proto::{HostAddresses, PublicIp};
use statglass_schema::HostId;
use statglass_session::RemoteError;

use super::registry::Registry;

impl Registry {
    pub(super) async fn network_addresses(
        &self,
        host: HostId,
    ) -> Result<HostAddressesInfo, CommandError> {
        let entry = self.entry(host)?.running()?;
        let addresses = entry
            .source
            .network_addresses()
            .await
            .map_err(|error| match error {
                RemoteError::Unsupported(_) => CommandError::RemoteUnsupported {
                    message: "Addresses are not available from this host".into(),
                },
                other => other.into(),
            })?;
        Ok(addresses_info(addresses))
    }
}

fn addresses_info(addresses: HostAddresses) -> HostAddressesInfo {
    HostAddressesInfo {
        interface: addresses.interface,
        link_mbps: addresses.link_mbps,
        ipv4: addresses
            .ipv4
            .into_iter()
            .map(|ip| ip.to_string())
            .collect(),
        ipv6: addresses
            .ipv6
            .into_iter()
            .map(|ip| ip.to_string())
            .collect(),
        public_ip: match addresses.public_ip {
            PublicIp::Known { ip } => PublicIpInfo::Known { ip: ip.to_string() },
            PublicIp::Pending => PublicIpInfo::Pending,
            PublicIp::Unavailable { reason } => PublicIpInfo::Unavailable { reason },
            PublicIp::Unknown => PublicIpInfo::Unknown,
        },
        as_of_ms: addresses.as_of_ms,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use statglass_ipc::mobile::{MobileCall, MobileHost};
    use statglass_proto::{ADDRESSES_QUERY_FEATURE, Answer, ErrorCode, Hello, Message, Query};
    use statglass_session::codec;

    use super::super::{
        endpoint,
        tests::{Dial, Fixture, host},
    };
    use super::{CommandError, HostAddresses, PublicIp};

    async fn handshake(peer: &mut Dial, host: &MobileHost, addresses: bool) {
        let mut features = statglass_proto::local_features();
        if addresses {
            features.insert(ADDRESSES_QUERY_FEATURE.into());
        }
        codec::write(
            &mut peer.peer,
            &Message::Hello(Box::new(Hello {
                proto_version: statglass_proto::PROTO_VERSION,
                min_compatible: statglass_proto::MIN_COMPATIBLE,
                app_version: "fixture".into(),
                host: endpoint::record(host).identity(),
                db_instance_uuid: host.id.0,
                capabilities: Default::default(),
                features,
            })),
        )
        .await
        .unwrap();
        let Message::HelloAck(ack) = peer.read().await else {
            panic!("expected HelloAck");
        };
        assert_eq!(ack.features.contains(ADDRESSES_QUERY_FEATURE), addresses);
        assert!(matches!(peer.read().await, Message::Interest(_)));
        let Message::Ping { nonce, t0_ms } = peer.read().await else {
            panic!("expected the initial heartbeat");
        };
        codec::write(
            &mut peer.peer,
            &Message::Pong {
                nonce,
                t0_ms,
                t_remote_ms: t0_ms,
            },
        )
        .await
        .unwrap();
    }

    async fn reply(peer: &mut Dial, answer: Answer) {
        let message = peer.read().await;
        let Message::Request { id, query } = message else {
            panic!("expected the address request, got {message:?}");
        };
        assert_eq!(query, Query::NetworkAddresses);
        codec::write(&mut peer.peer, &Message::Reply { id, answer })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn addresses_phone_call_returns_the_hosts_addresses_and_public_ip_state() {
        let host = host(1);
        let mut fixture = Fixture::start(vec![host.clone()]);
        let mut peer = fixture.next_dial().await;
        handshake(&mut peer, &host, true).await;
        let addresses = HostAddresses {
            interface: Some("en0".into()),
            link_mbps: Some(1000),
            ipv4: vec!["192.0.2.42".parse().unwrap()],
            ipv6: vec!["2001:db8::42".parse().unwrap()],
            public_ip: PublicIp::Pending,
            as_of_ms: 30_000,
        };
        for (public_ip, expected) in [
            (PublicIp::Pending, json!({"state": "pending"})),
            (
                PublicIp::Known {
                    ip: "203.0.113.7".parse().unwrap(),
                },
                json!({"state": "known", "detail": {"ip": "203.0.113.7"}}),
            ),
            (
                PublicIp::Unavailable {
                    reason: "curl not installed".into(),
                },
                json!({"state": "unavailable", "detail": {"reason": "curl not installed"}}),
            ),
            (PublicIp::Unknown, json!({"state": "unknown"})),
        ] {
            let answer = HostAddresses {
                public_ip,
                ..addresses.clone()
            };
            let (result, ()) = tokio::join!(
                fixture
                    .sessions
                    .call(MobileCall::NetworkAddresses { host: host.id }),
                reply(&mut peer, Answer::NetworkAddresses(answer)),
            );
            assert_eq!(
                result.unwrap(),
                json!({
                    "interface": "en0", "link_mbps": 1000,
                    "ipv4": ["192.0.2.42"], "ipv6": ["2001:db8::42"],
                    "public_ip": expected, "as_of_ms": 30_000,
                })
            );
        }
    }

    #[tokio::test]
    async fn addresses_phone_call_reports_unsupported_from_feature_negotiation_or_reply() {
        let host = host(1);
        let expected = CommandError::RemoteUnsupported {
            message: "Addresses are not available from this host".into(),
        };
        for advertised in [false, true] {
            let mut fixture = Fixture::start(vec![host.clone()]);
            let mut peer = fixture.next_dial().await;
            handshake(&mut peer, &host, advertised).await;
            let call = fixture
                .sessions
                .call(MobileCall::NetworkAddresses { host: host.id });
            let result = if advertised {
                let (result, ()) = tokio::join!(
                    call,
                    reply(
                        &mut peer,
                        Answer::Error {
                            code: ErrorCode::Unsupported,
                            message: "This host does not answer that query".into(),
                        }
                    ),
                );
                result
            } else {
                let result = call.await;
                // A supported request sent afterward lets the peer check what was queued first.
                let entry = fixture
                    .sessions
                    .registry
                    .entry(host.id)
                    .unwrap()
                    .running()
                    .unwrap();
                let usage = statglass_schema::usage::UsageKey::Cpu;
                let (ordinary, ()) =
                    tokio::join!(entry.source.usage_by_app(0, 1, usage, 1), async {
                        let Message::Request { id, query } = peer.read().await else {
                            panic!("expected the usage request");
                        };
                        assert_eq!(
                            query,
                            Query::UsageByApp {
                                from_ms: 0,
                                to_ms: 1,
                                by: usage,
                                limit: 1
                            }
                        );
                        codec::write(
                            &mut peer.peer,
                            &Message::Reply {
                                id,
                                answer: Answer::Error {
                                    code: ErrorCode::Unsupported,
                                    message: "fixture".into(),
                                },
                            },
                        )
                        .await
                        .unwrap();
                    },);
                assert!(matches!(
                    ordinary,
                    Err(statglass_session::RemoteError::Unsupported(_))
                ));
                result
            };
            assert_eq!(result, Err(expected.clone()));
        }
    }

    #[tokio::test]
    async fn addresses_phone_call_distinguishes_missing_and_disconnected_hosts() {
        let known = host(1);
        let absent = host(2);
        let fixture = Fixture::start(vec![known.clone()]);
        assert_eq!(
            fixture
                .sessions
                .call(MobileCall::NetworkAddresses { host: absent.id })
                .await,
            Err(CommandError::UnknownHost { host: absent.id })
        );
        assert!(matches!(
            fixture
                .sessions
                .call(MobileCall::NetworkAddresses { host: known.id })
                .await,
            Err(CommandError::RemoteUnreachable { .. })
        ));
    }
}
