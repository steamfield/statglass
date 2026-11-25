use crate::dialer::HostKeyCheck;
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect, client};
use statglass_session::{BoxFuture, Close, DialedStream, RemoteError, Result, StderrTail};
use std::{io, net, time::Duration};
use tokio::{
    io::{self as tokio_io, AsyncWriteExt, DuplexStream},
    net::TcpStream,
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};

/// russh hides the task spawned by `connect_stream`, including during key exchange.
/// Shutting down a duplicate descriptor wakes its socket I/O even if the Handle
/// has yet to be returned or a channel writer still holds a sender.
pub(crate) struct SocketGuard(net::TcpStream);

impl SocketGuard {
    pub fn new(socket: TcpStream) -> io::Result<(TcpStream, Self)> {
        let socket = socket.into_std()?;
        let guard = Self(socket.try_clone()?);
        Ok((TcpStream::from_std(socket)?, guard))
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = self.0.shutdown(net::Shutdown::Both);
    }
}

pub(crate) struct SessionStream {
    session: client::Handle<HostKeyCheck>,
    channel: ChannelWriteHalf<client::Msg>,
    stop_stdout: Option<oneshot::Sender<()>>,
    pump: JoinHandle<()>,
    _socket: SocketGuard,
}

impl SessionStream {
    pub async fn open(
        session: client::Handle<HostKeyCheck>,
        mut channel: Channel<client::Msg>,
        socket: SocketGuard,
        command: String,
        host: &str,
    ) -> Result<DialedStream> {
        let stderr = StderrTail::default();
        let early_stdout = exec(&mut channel, command, host, &stderr).await?;
        let (read, channel) = channel.split();
        let (reader, stdout) = tokio_io::duplex(64 * 1024);
        let (stop_stdout, stop) = oneshot::channel();
        let pump = tokio::spawn(pump(read, stdout, stderr.clone(), stop, early_stdout));
        Ok(DialedStream {
            reader: Box::pin(reader),
            writer: Box::pin(channel.make_writer()),
            stderr,
            close: Box::new(Self {
                session,
                channel,
                stop_stdout: Some(stop_stdout),
                pump,
                _socket: socket,
            }),
        })
    }
}

async fn exec(
    channel: &mut Channel<client::Msg>,
    command: String,
    host: &str,
    stderr: &StderrTail,
) -> Result<Vec<u8>> {
    // A peer can send data before confirming exec, while the caller has no reader
    // yet. Accept up to one default SSH receive window before requiring a reply.
    const MAX_EARLY_STDOUT: usize = 2 * 1024 * 1024;
    channel
        .exec(true, command)
        .await
        .map_err(|err| RemoteError::Transport(format!("{host}: SSH exec: {err}")))?;
    let mut early_stdout = Vec::new();
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Success => return Ok(early_stdout),
            ChannelMsg::Failure => {
                return Err(RemoteError::Transport(format!("{host}: SSH exec refused")));
            }
            ChannelMsg::Data { data } => {
                if early_stdout.len() + data.len() > MAX_EARLY_STDOUT {
                    return Err(RemoteError::Transport(format!(
                        "{host}: the host sent over 2 MiB of stdout before confirming SSH exec"
                    )));
                }
                early_stdout.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { ext: 1, data } => stderr.push(&data),
            ChannelMsg::Close | ChannelMsg::Eof => break,
            ChannelMsg::ExitStatus { exit_status } => {
                tracing::debug!(exit_status, "remote command exited")
            }
            _ => {}
        }
    }
    Err(RemoteError::Transport(format!(
        "{host}: SSH channel closed before accepting exec"
    )))
}

impl Close for SessionStream {
    fn close(mut self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            // A handshake that stopped reading stdout may have filled the pipe.
            // Drain the remaining channel messages so stderr can still reach classify.
            if let Some(stop) = self.stop_stdout.take() {
                let _ = stop.send(());
            }
            let graceful = async {
                let _ = self.channel.eof().await;
                let _ = self
                    .session
                    .disconnect(Disconnect::ByApplication, "", "")
                    .await;
                let _ = (&mut self.session).await;
                if let Err(err) = (&mut self.pump).await {
                    tracing::debug!(error = %err, "russh output pump ended");
                }
            };
            let _ = timeout(Duration::from_secs(1), graceful).await;
        })
    }
}

impl Drop for SessionStream {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

async fn pump(
    mut channel: ChannelReadHalf,
    stdout: DuplexStream,
    stderr: StderrTail,
    mut stop: oneshot::Receiver<()>,
    early_stdout: Vec<u8>,
) {
    let mut stdout = Some(stdout);
    write_stdout(&mut stdout, &mut stop, &early_stdout).await;
    drop(early_stdout);
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => write_stdout(&mut stdout, &mut stop, &data).await,
            ChannelMsg::ExtendedData { ext: 1, data } => stderr.push(&data),
            ChannelMsg::Eof => stdout = None,
            ChannelMsg::Close => break,
            // OpenSSH can report exit status before it finishes reading the child's pipes.
            ChannelMsg::ExitStatus { exit_status } => {
                tracing::debug!(exit_status, "remote command exited")
            }
            _ => {}
        }
    }
}

async fn write_stdout(
    stdout: &mut Option<DuplexStream>,
    stop: &mut oneshot::Receiver<()>,
    data: &[u8],
) {
    if let Some(pipe) = stdout {
        let written = tokio::select! {
            biased;
            _ = stop => false,
            result = pipe.write_all(data) => result.is_ok(),
        };
        if !written {
            *stdout = None;
        }
    }
}
