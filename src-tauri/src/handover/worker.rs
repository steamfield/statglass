use std::{collections::BTreeMap, future::Future, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use statglass_remote::{
    command::{helper_command, sh_c, sh_word, shell_quote},
    install::run_remote,
};
use tokio::{
    task::JoinSet,
    time::{Instant, MissedTickBehavior, interval_at, timeout_at},
};

use super::*;

const INTERVAL: Duration = Duration::from_secs(5 * 60);
const HOST_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) enum Apply {
    Host(HostId),
    Pending,
    Retry(oneshot::Sender<Result<(), CommandError>>),
}

pub(super) async fn run(
    controller: Arc<Controller>,
    requests: mpsc::UnboundedReceiver<Apply>,
    stop: watch::Receiver<bool>,
) {
    run_with(controller, requests, stop, |alias, command| async move {
        run_remote(&alias, &command)
            .await
            .map_err(|error| error.to_string())
    })
    .await;
}

pub(super) async fn run_with<F>(
    controller: Arc<Controller>,
    mut requests: mpsc::UnboundedReceiver<Apply>,
    mut stop: watch::Receiver<bool>,
    ssh: impl Fn(String, String) -> F + Clone + Send + Sync + 'static,
) where
    F: Future<Output = Result<String, String>> + Send + 'static,
{
    let mut ticks = interval_at(Instant::now() + INTERVAL, INTERVAL);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let work = async {
        loop {
            let request = tokio::select! {
                request = requests.recv() => match request {
                    Some(request) => request,
                    None => break,
                },
                _ = ticks.tick() => Apply::Pending,
            };
            let host = match &request {
                Apply::Host(host) => Some(*host),
                _ => None,
            };
            let result = apply_pass(&controller, host, ssh.clone()).await;
            if let Apply::Retry(done) = request {
                let _ = done.send(result);
            } else if let Err(error) = result {
                tracing::warn!(?error, "applying device intents");
            }
        }
    };
    tokio::select! {
        _ = work => {},
        _ = stop.wait_for(|stopped| *stopped) => {},
    }
}

async fn apply_pass<F>(
    controller: &Arc<Controller>,
    host: Option<HostId>,
    ssh: impl Fn(String, String) -> F + Clone + Send + Sync + 'static,
) -> Result<(), CommandError>
where
    F: Future<Output = Result<String, String>> + Send + 'static,
{
    let pending = controller.read_pending().await?;
    let mut batches: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for intent in pending
        .into_iter()
        .filter(|intent| host.is_none_or(|id| intent.host == id))
    {
        batches.entry(intent.host).or_default().push(intent);
    }
    if batches.is_empty() {
        return Ok(());
    }
    let mut hosts: BTreeMap<_, _> = (controller.hosts)()
        .into_iter()
        .map(|host| (host.input.host_id, host))
        .collect();
    let mut work = JoinSet::new();
    for (id, intents) in batches {
        work.spawn(apply_host(
            controller.clone(),
            hosts.remove(&id),
            intents,
            ssh.clone(),
        ));
    }
    let mut failure = None;
    // Finish the other hosts even if a log write fails for one of them.
    while let Some(result) = work.join_next().await {
        if let Err(error) = result.map_err(handover_error).and_then(|result| result) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

async fn apply_host<F>(
    controller: Arc<Controller>,
    host: Option<RemoteHost>,
    mut intents: Vec<PendingIntent>,
    ssh: impl Fn(String, String) -> F + Sync,
) -> Result<(), CommandError>
where
    F: Future<Output = Result<String, String>>,
{
    // Rotate through the batch if one device repeatedly uses the host's whole budget.
    intents.sort_by_key(|intent| (intent.attempts, intent.seq));
    let deadline = Instant::now() + HOST_TIMEOUT;
    let mut outcomes = Vec::with_capacity(intents.len());
    let mut failure = None;
    for intent in intents {
        if Instant::now() >= deadline {
            break;
        }
        // A revoke or re-pair may supersede operations queued behind earlier SSH work.
        match controller.read_pending().await {
            Ok(pending) if pending.iter().any(|latest| latest.seq == intent.seq) => {}
            Ok(_) => continue,
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        let result = match &host {
            Some(host) => send(&controller, host, &intent, deadline, &ssh).await,
            None => Err("This host is no longer saved on this Mac.".into()),
        };
        outcomes.push((intent.seq, result));
    }
    tokio::task::spawn_blocking(move || {
        let log = controller.log()?;
        for (seq, outcome) in outcomes {
            if let Err(error) = log.finish(seq, outcome, wall_ms()) {
                failure.get_or_insert_with(|| {
                    handover_error(format!(
                        "Couldn’t record the result for device intent {seq}. {error}"
                    ))
                });
            }
        }
        failure.map_or(Ok(()), Err)
    })
    .await
    .map_err(handover_error)?
}

async fn send<F>(
    controller: &Arc<Controller>,
    host: &RemoteHost,
    intent: &PendingIntent,
    deadline: Instant,
    ssh: impl Fn(String, String) -> F,
) -> Result<(), String>
where
    F: Future<Output = Result<String, String>>,
{
    if !host.enabled && intent.install.is_some() {
        return Err("Monitoring is disabled for this host.".into());
    }
    let aliases = host.aliases.as_ref().map_err(Clone::clone)?;
    let command = device_command(&host.command, intent)?;
    let mut error = "This host has no saved SSH alias.".to_owned();
    for (attempt, alias) in aliases.iter().enumerate() {
        if attempt > 0 {
            let pending = controller
                .read_pending()
                .await
                .map_err(|error| format!("{error:?}"))?;
            if !pending.iter().any(|latest| latest.seq == intent.seq) {
                // Logging an outcome for a superseded sequence is a no-op.
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err("The host’s 20-second retry timed out.".into());
        }
        let reply = timeout_at(deadline, ssh(alias.clone(), command.clone()))
            .await
            .map_err(|_| "The host’s 20-second retry timed out.".to_owned())?;
        match reply {
            Ok(tag) if DeviceTag::parse(tag.trim()) == Some(intent.device) => return Ok(()),
            Ok(_) => error = "The SSH command didn’t confirm the device tag.".into(),
            Err(reason) => error = reason,
        }
    }
    Err(error)
}

fn operation(intent: &PendingIntent, quote_name: impl FnOnce(&str) -> String) -> String {
    match &intent.install {
        Some((key, name)) => format!(
            "authorize-key --key {} --name {}",
            STANDARD.encode(key.0),
            quote_name(name)
        ),
        None => format!("revoke-key --device {}", intent.device),
    }
}

pub(super) fn device_command(
    command: &RemoteCommand,
    intent: &PendingIntent,
) -> Result<String, String> {
    match command {
        RemoteCommand::MacHelper(path) => Ok(helper_command(
            path,
            &operation(intent, |name| {
                name.split('\\')
                    .map(shell_quote)
                    .collect::<Vec<_>>()
                    .join(r"\\")
            }),
        )),
        RemoteCommand::Agent {
            bin,
            system,
            socket,
        } => {
            let word = |value: &str| sh_word(value).map_err(|error| error.to_string());
            let operation = operation(intent, |name| {
                // Octal escapes carry arbitrary names through the login shell's quoted script.
                let bytes: String = name.bytes().map(|byte| format!(r"\0{byte:03o}")).collect();
                format!(r#""$(printf %b "{bytes}")""#)
            });
            let mut script = format!("exec {} {operation}", word(bin)?);
            if intent.install.is_some() {
                if *system {
                    script.push_str(" --system");
                }
                if let Some(socket) = socket {
                    script.push_str(" --socket ");
                    script.push_str(&word(socket)?);
                }
            }
            sh_c(&script).map_err(|error| error.to_string())
        }
        RemoteCommand::Restricted { .. } => {
            Err("A full SSH key is required to edit device access.".into())
        }
    }
}
