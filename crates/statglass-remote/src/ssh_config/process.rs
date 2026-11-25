use std::{
    io,
    os::unix::process::CommandExt,
    process::{Command, Output, Stdio},
    thread,
    time::Duration,
};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const DEADLINE: Duration = Duration::from_secs(5);

pub(super) fn output(command: Command, input: Option<Vec<u8>>) -> io::Result<Output> {
    output_by(command, input, DEADLINE)
}

fn output_by(
    mut command: Command,
    input: Option<Vec<u8>>,
    deadline: Duration,
) -> io::Result<Output> {
    command
        .process_group(0)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The API is synchronous and can also be called by threads using a Tokio runtime.
    thread::Builder::new()
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(run(command, input, deadline))
        })?
        .join()
        .map_err(|_| io::Error::other("SSH config runner panicked"))?
}

async fn run(command: Command, input: Option<Vec<u8>>, deadline: Duration) -> io::Result<Output> {
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()?;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing SSH stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("missing SSH stderr"))?;
    let result = tokio::time::timeout(deadline, async {
        let (stdout, stderr, ()) = tokio::try_join!(read_all(stdout), read_all(stderr), async {
            if let (Some(mut stdin), Some(input)) = (stdin, input)
                && let Err(error) = stdin.write_all(&input).await
                && error.kind() != io::ErrorKind::BrokenPipe
            {
                return Err(error);
            }
            Ok(())
        })?;
        let status = child.wait().await?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    })
    .await;
    match result {
        Ok(Ok(output)) => Ok(output),
        failure => {
            // Match exec can have a child keeping the pipe open. The group was
            // created for this command, and we have not reaped its leader.
            if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
                // SAFETY: negative pid names this command's isolated process group.
                if unsafe { libc::kill(-pid, libc::SIGKILL) } < 0
                    && let Err(error) = child.start_kill()
                {
                    tracing::warn!(%error, "killing the SSH config command");
                }
            }
            if let Ok(Err(error)) =
                tokio::time::timeout(Duration::from_millis(200), child.wait()).await
            {
                tracing::warn!(%error, "reaping the SSH config command");
            }
            failure.unwrap_or_else(|_| {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "SSH config command timed out",
                ))
            })
        }
    }
}

async fn read_all(mut reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_waiting_on_a_fifo_times_out() {
        let directory = tempfile::tempdir().unwrap();
        let fifo = directory.path().join("stall");
        assert!(
            Command::new("/usr/bin/mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "/bin/cat \"$1\" & wait", "sh"])
            .arg(&fifo);
        let error = output_by(command, None, Duration::from_millis(250)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
}
