//! What a session starts on the remote host, and the quoting that carries it through any
//! login shell. Every dialer sends the same command line.
use crate::{RemoteError, Result};
use serde::{Deserialize, Serialize};

/// The program an SSH session starts on the remote host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RemoteCommand {
    /// The app's bundled `statglass-remote-helper` at this absolute path. Empty uses the
    /// normal per-user installation. Serialized as the bare path string, the format of
    /// the old `helper_path` field.
    MacHelper(String),
    /// The headless Linux agent (D-116). `system` selects the root layout; `socket`, when
    /// set, is the daemon's socket, passed explicitly so the session and the user
    /// manager agree on it whatever the login environment says.
    Agent {
        bin: String,
        system: bool,
        #[serde(default)]
        socket: Option<String>,
    },
    /// A restricted key whose `authorized_keys` line forces the command on the host
    /// (RFC 2.3). The session sends only the bare token, which the forced command reads
    /// from `SSH_ORIGINAL_COMMAND`.
    Restricted { forced: ForcedToken },
}

/// The bare `SSH_ORIGINAL_COMMAND` a forced-command key sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForcedToken {
    /// Start the restricted stdio session.
    Serve,
    /// Run the one-time pairing exchange (RFC 2.4).
    Pair,
}

impl ForcedToken {
    /// The token as the host's forced command compares it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Serve => "serve",
            Self::Pair => "pair",
        }
    }
}

impl Default for RemoteCommand {
    fn default() -> Self {
        Self::MacHelper(String::new())
    }
}

impl RemoteCommand {
    /// The remote command line that starts the stdio session.
    pub fn serve_command(&self) -> Result<String> {
        match self {
            Self::MacHelper(path) => Ok(helper_command(path, "serve --stdio")),
            Self::Agent {
                bin,
                system,
                socket,
            } => {
                let mut inner = format!("exec {} serve --stdio", sh_word(bin)?);
                if *system {
                    inner.push_str(" --system");
                }
                if let Some(socket) = socket {
                    inner.push_str(" --socket ");
                    inner.push_str(&sh_word(socket)?);
                }
                sh_c(&inner)
            }
            Self::Restricted { forced } => Ok(forced.as_str().to_owned()),
        }
    }
}

/// `script` for the remote login shell to hand to `/bin/sh` untouched, whatever that
/// shell is (zsh, fish and nu each have their own syntax). The script travels as one
/// single-quoted word, so it may hold no `'`, and no double backslash, which fish reads
/// as an escape even inside single quotes. Values go in through [`sh_word`].
pub fn sh_c(script: &str) -> Result<String> {
    if script.contains('\'') || script.contains("\\\\") {
        return Err(RemoteError::Protocol(
            "remote script cannot be quoted for every login shell".into(),
        ));
    }
    Ok(format!("exec /bin/sh -c '{script}'"))
}

/// `value` as one double-quoted `/bin/sh` word that survives [`sh_c`]'s outer quotes:
/// `"`, `$` and backquote are escaped; `'`, backslashes and control characters are
/// refused, since no quoting carries them through every login shell.
pub fn sh_word(value: &str) -> Result<String> {
    if value.is_empty()
        || value
            .chars()
            .any(|c| c == '\'' || c == '\\' || c.is_control())
    {
        return Err(RemoteError::Protocol(format!(
            "unsupported characters in remote path {value:?}"
        )));
    }
    let mut word = String::with_capacity(value.len() + 2);
    word.push('"');
    for c in value.chars() {
        if matches!(c, '"' | '$' | '`') {
            word.push('\\');
        }
        word.push(c);
    }
    word.push('"');
    Ok(word)
}

/// Quotes a literal as one POSIX shell word. Infallible.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Builds the helper invocation with a quoted path and a trusted operation. Infallible.
pub fn helper_command(path: &str, operation: &str) -> String {
    let path = if path.is_empty() {
        "\"$HOME\"/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper".to_string()
    } else {
        shell_quote(path)
    };
    format!("exec {path} {operation}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_remote_paths_without_expansion() {
        assert_eq!(shell_quote("/a'b/$x"), "'/a'\\''b/$x'");
    }

    #[test]
    fn agent_serve_command_is_one_word_for_any_login_shell() {
        let system = RemoteCommand::Agent {
            bin: "/usr/local/bin/statglass-agent".into(),
            system: true,
            socket: None,
        };
        assert_eq!(
            system.serve_command().unwrap(),
            r#"exec /bin/sh -c 'exec "/usr/local/bin/statglass-agent" serve --stdio --system'"#
        );
        let user = RemoteCommand::Agent {
            bin: "/home/my user/.local/bin/statglass-agent".into(),
            system: false,
            socket: Some("/run/user/1000/k\"$x`/metrics.sock".into()),
        };
        let command = user.serve_command().unwrap();
        assert_eq!(
            command,
            r#"exec /bin/sh -c 'exec "/home/my user/.local/bin/statglass-agent" serve --stdio --socket "/run/user/1000/k\"\$x\`/metrics.sock"'"#
        );
        // What /bin/sh actually receives: the words come back exactly.
        let script = command
            .strip_prefix("exec /bin/sh -c '")
            .and_then(|s| s.strip_suffix('\''))
            .unwrap()
            .replace("exec ", "printf '%s\\n' ");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            "/home/my user/.local/bin/statglass-agent\nserve\n--stdio\n--socket\n/run/user/1000/k\"$x`/metrics.sock\n"
        );
        for bad in ["/a'b", "/a\\b", "/a\nb", ""] {
            let command = RemoteCommand::Agent {
                bin: bad.into(),
                system: true,
                socket: None,
            };
            assert!(matches!(
                command.serve_command(),
                Err(RemoteError::Protocol(_))
            ));
        }
        assert!(sh_c("echo 'x'").is_err());
        assert!(sh_c("echo a\\\\b").is_err());
        assert_eq!(
            RemoteCommand::default().serve_command().unwrap(),
            helper_command("", "serve --stdio")
        );
    }

    #[test]
    fn a_restricted_key_sends_only_its_bare_token_and_desktop_json_is_unchanged() {
        let serve = RemoteCommand::Restricted {
            forced: ForcedToken::Serve,
        };
        let pair = RemoteCommand::Restricted {
            forced: ForcedToken::Pair,
        };
        assert_eq!(serve.serve_command().unwrap(), "serve");
        assert_eq!(pair.serve_command().unwrap(), "pair");
        assert_eq!(
            serde_json::to_value(&pair).unwrap(),
            serde_json::json!({ "forced": "pair" })
        );
        let mac: RemoteCommand = serde_json::from_str(r#""/Applications/x""#).unwrap();
        assert_eq!(mac, RemoteCommand::MacHelper("/Applications/x".into()));
        let agent: RemoteCommand =
            serde_json::from_str(r#"{"bin":"/usr/bin/statglass-agent","system":true}"#).unwrap();
        assert!(matches!(agent, RemoteCommand::Agent { system: true, .. }));
        let back: RemoteCommand = serde_json::from_str(r#"{"forced":"serve"}"#).unwrap();
        assert_eq!(back, serve);
    }
}
