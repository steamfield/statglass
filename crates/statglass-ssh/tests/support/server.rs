use crate::SoftwareSigner;
use russh::{
    Channel, ChannelId, Pty,
    keys::{HashAlg, PrivateKey, PublicKey, ssh_key::private::Ed25519Keypair},
    server::{self, Auth, ChannelOpenHandle, Msg, PublicKeyOffer, Session, VerifiedPublicKey},
};
use statglass_session::{Endpoint, PinnedHostKey, RemoteCommand, Route, Target};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{self, AsyncWriteExt},
    net::TcpListener,
    sync::{Notify, mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    AuthOffer(String),
    Auth(String),
    Open,
    Exec(Vec<u8>),
    Data(Vec<u8>),
    Unexpected(&'static str),
    Eof,
    TcpClosed,
}

pub enum End {
    Eof,
    Close,
}

#[derive(Default)]
pub struct Script {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub end: Option<End>,
    pub delay_auth: bool,
    pub disconnect_during_auth: bool,
    pub refuse_exec: bool,
    pub output_before_exec_reply: bool,
    pub exit_before_output: Option<u32>,
}

pub struct Server {
    pub endpoint: Endpoint,
    events: mpsc::UnboundedReceiver<Event>,
    task: JoinHandle<()>,
    auth_gate: Arc<Notify>,
    mute: Option<oneshot::Sender<()>>,
}

impl Server {
    pub async fn start(key: &SoftwareSigner, script: Script) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let host_key = PrivateKey::from(Ed25519Keypair::from_seed(&[3; 32]));
        let endpoint = Endpoint {
            targets: vec![Target {
                host: address.ip().to_string(),
                route: Route::Lan,
            }],
            port: Some(address.port()),
            user: Some("statglass".into()),
            host_keys: vec![PinnedHostKey {
                algorithm: host_key.algorithm().to_string(),
                sha256: host_key
                    .public_key()
                    .fingerprint(HashAlg::Sha256)
                    .to_string(),
            }],
            command: RemoteCommand::Agent {
                bin: "/usr/local/bin/statglass-agent".into(),
                system: false,
                socket: Some("/tmp/statglass test/agent.sock".into()),
            },
        };
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let (event, events) = mpsc::unbounded_channel();
        let auth_gate = Arc::new(Notify::new());
        let handler = Handler {
            key: PublicKey::from_openssh(&key.authorized_key_line("fixture")).unwrap(),
            auth_gate: auth_gate.clone(),
            script,
            event,
        };
        let (mute, muted) = oneshot::channel();
        let task = tokio::spawn(serve(listener, config, handler, muted));
        Self {
            endpoint,
            events,
            task,
            auth_gate,
            mute: Some(mute),
        }
    }

    pub fn mute_replies(&mut self) {
        self.mute.take().unwrap().send(()).unwrap();
    }

    pub async fn next(&mut self) -> Event {
        timeout(Duration::from_secs(5), self.events.recv())
            .await
            .expect("SSH server stalled")
            .expect("SSH server ended early")
    }

    pub async fn finish(mut self) -> Vec<Event> {
        timeout(Duration::from_secs(1), &mut self.task)
            .await
            .expect("SSH peer did not close TCP within one second")
            .unwrap();
        std::iter::from_fn(|| self.events.try_recv().ok()).collect()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.auth_gate.notify_one();
        self.task.abort();
    }
}

async fn serve(
    listener: TcpListener,
    config: Arc<server::Config>,
    handler: Handler,
    muted: oneshot::Receiver<()>,
) {
    let (tcp, _) = listener.accept().await.unwrap();
    drop(listener);
    let (mut client_read, mut client_write) = tcp.into_split();
    let (relay, ssh) = io::duplex(64 * 1024);
    let (mut server_read, mut server_write) = io::split(relay);
    let event = handler.event.clone();
    let auth_gate = handler.auth_gate.clone();
    // The relay can see TCP EOF while russh is waiting for the scripted auth reply.
    let receive = async {
        let result = io::copy(&mut client_read, &mut server_write).await;
        assert!(result.is_ok(), "reading client TCP stream: {result:?}");
        let _ = server_write.shutdown().await;
        drop(server_write);
        event.send(Event::TcpClosed).unwrap();
        auth_gate.notify_one();
    };
    let send = async {
        tokio::select! {
            biased;
            Ok(()) = muted => {
                let _ = io::copy(&mut server_read, &mut io::sink()).await;
            }
            _ = io::copy(&mut server_read, &mut client_write) => {}
        }
        let _ = client_write.shutdown().await;
        drop(server_read);
    };
    let serve = async {
        if let Ok(session) = server::run_stream(config, ssh, handler).await {
            let _ = session.await;
        }
    };
    tokio::join!(receive, send, serve);
}

struct Handler {
    key: PublicKey,
    auth_gate: Arc<Notify>,
    script: Script,
    event: mpsc::UnboundedSender<Event>,
}

impl Handler {
    fn record(&self, event: Event) {
        let _ = self.event.send(event);
    }
}

impl server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        _: PublicKeyOffer<'_>,
    ) -> Result<Auth, Self::Error> {
        self.record(Event::AuthOffer(user.into()));
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.record(Event::Auth(user.into()));
        if self.script.disconnect_during_auth {
            return Err(russh::Error::Disconnect);
        }
        if self.script.delay_auth {
            self.auth_gate.notified().await;
        }
        Ok(
            if user == "statglass" && key.public_key.key_data() == self.key.key_data() {
                Auth::Accept
            } else {
                Auth::reject()
            },
        )
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<Msg>,
        reply: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Open);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Exec(command.to_vec()));
        if self.script.refuse_exec {
            return session.channel_failure(channel);
        }
        if !self.script.output_before_exec_reply {
            session.channel_success(channel)?;
        }
        if let Some(status) = self.script.exit_before_output {
            session.exit_status_request(channel, status)?;
        }
        session.data(channel, std::mem::take(&mut self.script.stdout))?;
        session.extended_data(channel, 1, std::mem::take(&mut self.script.stderr))?;
        if self.script.output_before_exec_reply {
            session.channel_success(channel)?;
        }
        match self.script.end {
            Some(End::Eof) => session.eof(channel),
            Some(End::Close) => session.close(channel),
            None => Ok(()),
        }
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Data(data.to_vec()));
        session.data(channel, data.to_vec())
    }

    async fn channel_eof(&mut self, _: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.record(Event::Eof);
        Ok(())
    }

    async fn pty_request(
        &mut self,
        _: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Unexpected("pty"));
        Ok(())
    }

    async fn env_request(
        &mut self,
        _: ChannelId,
        _: &str,
        _: &str,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Unexpected("env"));
        Ok(())
    }

    async fn shell_request(&mut self, _: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.record(Event::Unexpected("shell"));
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        _: ChannelId,
        _: &str,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Unexpected("subsystem"));
        Ok(())
    }

    async fn tcpip_forward(
        &mut self,
        _: &str,
        _: &mut u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.record(Event::Unexpected("forward"));
        Ok(false)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        _: Channel<Msg>,
        _: &str,
        _: u32,
        _: &str,
        _: u32,
        _: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(Event::Unexpected("direct-tcpip"));
        Ok(())
    }
}
