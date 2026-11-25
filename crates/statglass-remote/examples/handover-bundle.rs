use statglass_proto::handover::HostBundle;
use statglass_schema::HostId;
use uuid::Uuid;

const USAGE: &str = "usage: handover-bundle --ssh-config PATH --alias ALIAS --key KEY";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = None;
    let mut alias = None;
    let mut key = None;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let slot = match flag.as_str() {
            "--ssh-config" => &mut config,
            "--alias" => &mut alias,
            "--key" => &mut key,
            _ => return Err(USAGE.into()),
        };
        if slot.is_some() {
            return Err(USAGE.into());
        }
        *slot = Some(args.next().filter(|value| !value.is_empty()).ok_or(USAGE)?);
    }
    let (Some(_config), Some(_alias), Some(_key)) = (config, alias, key) else {
        return Err(USAGE.into());
    };

    let bundle = HostBundle {
        version: 1,
        from: HostId(Uuid::nil()),
        hosts: Vec::new(),
        unavailable: Vec::new(),
        issued_ms: 0,
    };
    println!("{}", serde_json::to_string(&bundle)?);
    Ok(())
}
