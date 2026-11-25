use anyhow::Context;
use qrcode::{EcLevel, QrCode, render::unicode::Dense1x2};
use statglass_proto::pairing::{PairReply, PairingPayload, encode_payload};
use statglass_remote::PairingHost;
use std::io::{self, IsTerminal, Write};
use tokio::{sync::Notify, time::Instant};

pub(super) async fn terminal_decision(
    pairing: &PairingHost,
    payload: &PairingPayload,
    pending: &Notify,
    deadline: Instant,
) -> anyhow::Result<bool> {
    let text = encode_payload(payload);
    let qr = terminal_qr(&text)?;
    {
        let mut stdout = io::stdout().lock();
        if stdout.is_terminal() {
            let width = qr_columns(&qr);
            let columns = std::env::var("COLUMNS")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(80);
            if width > columns {
                eprintln!("Widen the terminal to {width} columns before scanning this QR.");
            }
        }
        writeln!(stdout, "{text}\n{qr}\nPairing code: {}", payload.code)?;
        stdout.flush()?;
    }
    let received = tokio::time::timeout_at(deadline, pending.notified())
        .await
        .is_ok();
    let nonce = &payload.nonce;
    let answer = pairing.pending(nonce, statglass_engine::wall_ms());
    if let PairReply::Pending {
        device_name,
        model,
        code,
    } = answer
    {
        writeln!(
            io::stdout(),
            "Approve {device_name} ({model}), code {code}? [y/N]"
        )?;
        io::stdout().flush()?;
        let input = tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            io::stdin().read_line(&mut line).map(|_| line)
        });
        match tokio::time::timeout_at(deadline, input).await {
            Ok(input) => {
                let input = input
                    .context("reading the approval prompt")?
                    .context("reading the terminal")?;
                if input.trim().eq_ignore_ascii_case("y") {
                    pairing
                        .approve(nonce, statglass_engine::wall_ms())
                        .context("installing the approved device key")?;
                } else {
                    pairing.deny(nonce).context("denying the pairing")?;
                }
            }
            Err(_) => pairing.expire(payload.expires_ms),
        }
    } else if !received {
        pairing.expire(payload.expires_ms);
    }
    match pairing.status(nonce, statglass_engine::wall_ms()) {
        PairReply::Approved { .. } => writeln!(io::stdout(), "Pairing approved")?,
        PairReply::Denied => writeln!(io::stdout(), "Pairing denied")?,
        PairReply::Expired => writeln!(io::stdout(), "Pairing expired")?,
        _ => {}
    }
    Ok(received)
}

fn terminal_qr(text: &str) -> anyhow::Result<String> {
    Ok(QrCode::with_error_correction_level(text, EcLevel::L)
        .map_err(|error| anyhow::anyhow!("encoding the pairing QR: {error:?}"))?
        .render::<Dense1x2>()
        .build())
}

fn qr_columns(qr: &str) -> usize {
    qr.lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_proto::pairing::{BundleHost, BundleHostKey, BundleRoute, BundleTarget};

    #[test]
    fn pair_prints_an_ordinary_three_pin_qr_within_an_eighty_column_terminal() {
        let host = BundleHost {
            host_id: statglass_schema::HostId(uuid::Uuid::from_u128(456)),
            name: "workstation".into(),
            os: "linux".into(),
            user: "statglass".into(),
            port: None,
            targets: vec![
                BundleTarget {
                    route: BundleRoute::Lan,
                    host: "workstation.local".into(),
                },
                BundleTarget {
                    route: BundleRoute::Lan,
                    host: "192.168.1.40".into(),
                },
            ],
            host_keys: ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"]
                .into_iter()
                .map(|algorithm| BundleHostKey {
                    algorithm: algorithm.into(),
                    sha256: format!("SHA256:{}", "a".repeat(43)),
                })
                .collect(),
        };
        let offer = PairingPayload {
            version: 1,
            host,
            pairing_key: [245; 32],
            nonce: "0123456789abcdef0123456789abcdef".into(),
            code: "ABC234".into(),
            expires_ms: 1_800_000_060_000,
        };
        let qr = terminal_qr(&encode_payload(&offer)).unwrap();
        let width = qr_columns(&qr);
        assert!(width <= 80, "terminal QR is {width} columns wide");
    }
}
