use std::sync::Arc;

use statglass_ipc::mobile::{HostAddressesInfo, PublicIpInfo};
use statglass_proto::{HostAddresses, PublicIp};
use statglass_remote::{RemoteSource, ServedHost};
use statglass_schema::HostId;
use tauri::State;

use crate::commands::spawn_blocking;
use crate::error::CommandError;
use crate::state::{AppState, Route};

/// The monitored host's local and public addresses.
#[tauri::command]
#[specta::specta]
pub async fn get_host_addresses(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<HostAddressesInfo, CommandError> {
    read_addresses(
        state.route(host)?,
        async || {
            let entry = state.host(host)?;
            // Use the resolver on the same host entry that serves phone requests.
            spawn_blocking(move || entry.network_addresses()).await
        },
        async |source| source.network_addresses().await,
    )
    .await
}

async fn read_addresses(
    route: Route,
    local: impl AsyncFnOnce() -> Result<HostAddresses, CommandError>,
    remote: impl AsyncFnOnce(Arc<RemoteSource>) -> statglass_remote::Result<HostAddresses>,
) -> Result<HostAddressesInfo, CommandError> {
    let addresses = match route {
        Route::Local => local().await?,
        Route::Remote(source) => remote(source).await?,
    };
    Ok(addresses_info(addresses))
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
    use super::*;
    use statglass_remote::{EndpointConfig, OpenSshDialer, RemoteError};

    fn fixture_source() -> Arc<RemoteSource> {
        let local = HostId(uuid::Uuid::from_u128(1));
        let mut record = statglass_engine::host_record(HostId(uuid::Uuid::from_u128(2)));
        record.is_local = false;
        let endpoint = EndpointConfig {
            lan: Some("studio.local".into()),
            tailscale: None,
            command: Default::default(),
        };
        RemoteSource::new(
            record,
            local,
            Arc::new(OpenSshDialer::default()),
            endpoint.endpoint(),
            Arc::new(|_| {}),
            None,
        )
    }

    fn answer(public_ip: PublicIp) -> HostAddresses {
        HostAddresses {
            interface: Some("eth0".into()),
            link_mbps: Some(1000),
            ipv4: vec!["192.0.2.20".parse().unwrap()],
            ipv6: vec!["2001:db8::20".parse().unwrap()],
            public_ip,
            as_of_ms: 42,
        }
    }

    #[tokio::test]
    async fn local_reply_preserves_addresses_and_all_public_ip_states() {
        let ip = "203.0.113.20";
        let reason = "curl not installed".to_owned();
        for (public_ip, expected) in [
            (
                PublicIp::Known {
                    ip: ip.parse().unwrap(),
                },
                PublicIpInfo::Known { ip: ip.into() },
            ),
            (PublicIp::Pending, PublicIpInfo::Pending),
            (
                PublicIp::Unavailable {
                    reason: reason.clone(),
                },
                PublicIpInfo::Unavailable { reason },
            ),
            (PublicIp::Unknown, PublicIpInfo::Unknown),
        ] {
            assert_eq!(
                read_addresses(
                    Route::Local,
                    async || Ok(answer(public_ip)),
                    async |_| panic!("local address command dialed a remote host"),
                )
                .await
                .unwrap(),
                HostAddressesInfo {
                    interface: Some("eth0".into()),
                    link_mbps: Some(1000),
                    ipv4: vec!["192.0.2.20".into()],
                    ipv6: vec!["2001:db8::20".into()],
                    public_ip: expected,
                    as_of_ms: 42,
                }
            );
        }
    }

    #[tokio::test]
    async fn a_remote_reply_comes_from_the_selected_session() {
        let source = fixture_source();
        let reply = read_addresses(
            Route::Remote(Arc::clone(&source)),
            async || panic!("remote address command read this Mac"),
            async |selected| {
                assert!(Arc::ptr_eq(&selected, &source));
                Ok(answer(PublicIp::Pending))
            },
        )
        .await
        .unwrap();
        assert_eq!(reply.ipv4, ["192.0.2.20"]);
        assert_eq!(reply.public_ip, PublicIpInfo::Pending);
    }

    #[tokio::test]
    async fn an_old_remote_returns_a_typed_refusal() {
        let result = read_addresses(
            Route::Remote(fixture_source()),
            async || panic!("unsupported remote address command read this Mac"),
            async |_| Err(RemoteError::Unsupported("query.addresses.v1".into())),
        )
        .await;
        assert!(matches!(
            result,
            Err(CommandError::RemoteUnsupported { message })
                if message.contains("query.addresses.v1")
        ));
    }
}
