#![cfg_attr(test, allow(clippy::too_many_lines))]
//! StatGlass's app shell: Tauri setup, the commands and events the webview reaches, settings
//! ownership, live channels, and the local source's lifecycle. Business logic lives in
//! the `statglass-*` crates; see `state.rs` for the startup order and the API the tray and
//! window code builds on.

mod addresses;
pub mod alerts;
#[cfg(test)]
mod alerts_tests;
pub mod app_menu;
mod app_quit;
mod bench;
mod calibration;
mod cli_link;
mod commands;
mod disk_space;
mod docker;
mod durable_usage;
pub mod edition;
mod error;
mod export;
pub mod facts;
mod history;
mod hosts;
pub mod ipc;
pub mod live;
mod live_process;
mod logging;
mod notify;
mod platform;
pub mod popover;
pub mod process_signal;
mod query;
pub mod remote;
pub mod remote_network;
pub mod settings;
pub mod star_prompt;
pub mod startup;
pub mod state;
#[cfg(test)]
mod test_support;
pub mod tray;
mod updates;
mod usage;
mod windows;

use specta_typescript::Typescript;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_specta::{Builder, collect_commands, collect_events};

pub use error::CommandError;
pub use hosts::{HostEntry, HostRegistry};
pub use state::AppState;

/// Where the generated TypeScript types and constants land, with no Tauri import so
/// every app can use them. Generated, never hand-edited; see
/// `.claude/rules/generated-bindings.md`.
pub const TYPES_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/core/src/generated/types.ts"
);

/// Where the generated Tauri `commands` and `events` land. Desktop only; generated,
/// never hand-edited.
pub const COMMANDS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src/desktop-transport/commands.ts"
);

/// The module `commands.ts` imports the generated types from.
const TYPES_MODULE: &str = "@core/generated/types";

/// The tray's rate strings for sample inputs, written with the bindings so
/// `bindings-check` fails when the preview's test would check a stale table.
pub const TRAY_RATES_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/core/src/generated/tray-rates.json"
);

/// The bundle identifier of debug builds; release builds use `tauri.conf.json`'s.
#[cfg(debug_assertions)]
pub const DEV_IDENTIFIER: &str = "com.tryopendata.statglass.dev";

use startup::deferred_ui_launch;

/// Every command and event the webview can reach. The same builder feeds the invoke
/// handler and the bindings export, so the two cannot drift apart.
pub fn specta_builder() -> Builder<tauri::Wry> {
    let builder = Builder::<tauri::Wry>::new()
        // One TS type per Rust type. Phased export splits any type that reaches a
        // `deserialize_with` field (`Capabilities`, `Settings`) into `_Serialize` and
        // `_Deserialize` aliases, and in rc.25 it then exports the internally tagged
        // `LiveMsg` as externally tagged, which is not what serde sends. No StatGlass type has
        // a different shape per direction, so nothing is lost (D-048).
        .disable_serde_phases()
        .commands(collect_commands![
            docker::docker_discover, docker::docker_configure, docker::docker_snapshot,
            docker::docker_resume, docker::launch::docker_launch_runtime, docker::docker_subscribe, docker::docker_unsubscribe,
            docker::docker_detail, docker::docker_retained, docker::docker_history, docker::docker_comparison, docker::docker_events,
            docker::docker_logs, docker::docker_close_logs,
            docker::docker_storage_scan, docker::docker_storage_prepare,
            docker::docker_storage_execute, docker::docker_storage_operation,
            docker::docker_container_action,
            disk_space::disk_space_volumes, disk_space::disk_space_start,
            disk_space::disk_space_status, disk_space::disk_space_cancel,
            disk_space::disk_space_report, disk_space::disk_space_subtree,
            disk_space::disk_space_largest_files, disk_space::disk_space_reveal,
            disk_space::disk_space_path, disk_space::disk_space_highlights,
            disk_space::disk_space_reveal_highlight,
            commands::list_hosts,
            remote::list_remote_hosts, remote::host_vitals, remote::local_rr_job, remote::set_hosts_recent_interest, remote::host_update_notice_dismissed, remote::dismiss_host_update_notice, remote::get_remote_update_status, remote::set_remote_update_policy,
            remote::remote_ssh_config_status,
            remote::inspect_remote_ssh_host,
            remote::accept_remote_ssh_host,
            remote::prepare_remote_host,
            remote::add_remote_host,
            remote::cancel_remote_setup,
            remote::update_remote_host,
            remote::remove_remote_host,
            remote::retry_remote_host,
            remote::reset_remote_host_identity, remote::update_remote_agent, remote::restart_remote_agent, remote::repair_remote_host,
            commands::get_host,
            commands::get_capabilities,
            commands::subscribe_live,
            commands::set_process_interest,
            commands::query_history,
            commands::query_disk_io,
            commands::list_disk_io_devices,
            commands::query_processes_at,
            commands::query_network_by_app,
            durable_usage::query_historical_usage, durable_usage::query_usage_processes,
            commands::query_usage_by_app, commands::query_usage_series,
            commands::query_series_stats,
            commands::last_wake,
            commands::get_network_addresses,
            commands::get_public_ip,
            commands::query_events,
            commands::query_heatmap,
            commands::export_csv,
            commands::get_settings,
            commands::update_settings,
            commands::history_size,
            commands::history_growth,
            commands::clear_history,
            commands::history_health,
            commands::reset_history,
            commands::set_paused,
            commands::open_dashboard,
            commands::sensor_dump,
            commands::process_signal,
            commands::get_edition,
            cli_link::cli_link_status, cli_link::cli_install_link,
            updates::check_for_updates,
            updates::get_update_status,
            updates::install_update,
            commands::get_window_appearance,
            windows::window_visible,
            commands::report_popover_paint, popover::commands::report_popover_content_height,
            star_prompt::get_star_prompt_status, star_prompt::act_on_star_prompt,
            alerts::commands::alert_destinations_get, alerts::commands::alert_destination_save,
            alerts::commands::alert_destination_delete, alerts::commands::alert_destination_test,
        ])
        .events(collect_events![
            updates::UpdateStatusChanged,
            ipc::SettingsChanged,
            ipc::CapabilitiesChanged,
            ipc::WindowAppearanceChanged,
            windows::WindowVisibilityChanged,
            ipc::NavigateRequested,
            ipc::HistoryHealthChanged,
            ipc::HostsChanged,
            remote::RemoteHostsChanged,
            ipc::EventRecorded,
            star_prompt::StarPromptChanged,
            alerts::commands::AlertDestinationsChanged,
        ]);
    facts::register(builder)
}

/// Writes the TypeScript bindings for `builder`, split into [`TYPES_PATH`] and
/// [`COMMANDS_PATH`], and the tray rate table to [`TRAY_RATES_PATH`].
///
/// # Errors
///
/// Fails when the export or a write fails, or when tauri-specta's output no longer has
/// the sections `split_bindings` cuts it at.
pub fn export_bindings(builder: &Builder<tauri::Wry>) -> anyhow::Result<()> {
    use anyhow::Context;
    let exported = export_to_string(builder)?;
    let split = split_bindings(&exported)?;
    std::fs::write(TYPES_PATH, split.types)
        .with_context(|| format!("writing generated types to {TYPES_PATH}"))?;
    std::fs::write(COMMANDS_PATH, split.commands)
        .with_context(|| format!("writing generated commands to {COMMANDS_PATH}"))?;
    let rates = || format!("writing the tray rate table to {TRAY_RATES_PATH}");
    let golden = serde_json::to_string_pretty(&tray::model::rate_golden()).with_context(rates)?;
    std::fs::write(TRAY_RATES_PATH, golden + "\n").with_context(rates)?;
    Ok(())
}

/// Runs tauri-specta's export into a scratch file and returns its text with trailing
/// whitespace removed from every line.
///
/// tauri-specta rc.25 only exports to a path, so the scratch file stands in for an
/// export to a string.
fn export_to_string(builder: &Builder<tauri::Wry>) -> anyhow::Result<String> {
    use anyhow::Context;
    let scratch =
        std::env::temp_dir().join(format!("statglass-bindings-{}.ts", std::process::id()));
    let exporting = || format!("exporting bindings to {}", scratch.display());
    builder
        .export(Typescript::default(), &scratch)
        .with_context(exporting)?;
    let exported = std::fs::read_to_string(&scratch).with_context(exporting)?;
    std::fs::remove_file(&scratch)
        .with_context(|| format!("removing the scratch export {}", scratch.display()))?;
    // Specta emits spaces after union separators. Normalize generation itself so
    // freshly added variants pass the repository whitespace gate reproducibly.
    Ok(exported
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n")
}

/// The two files cut from one tauri-specta export.
struct SplitBindings {
    /// Every type and constant; no Tauri import.
    types: String,
    /// `commands`, `events` and the runtime they call, importing the types they name.
    commands: String,
}

const GENERATED_HEADER: &str =
    "// This file has been generated by Tauri Specta. Do not edit this file manually.\n";
const COMMANDS_MARKER: &str = "/** Commands */";
const CONSTANTS_MARKER: &str = "/* Constants */";
const RUNTIME_MARKER: &str = "/* Tauri Specta runtime */";

/// Cuts a tauri-specta export into types and constants, and commands and events.
///
/// The export is laid out as imports, commands, events, constants, types, then the
/// runtime helpers; the cut follows the section comments tauri-specta writes.
///
/// # Errors
///
/// Fails when a section comment is missing or out of order, which means the generator's
/// layout changed and this split needs updating.
fn split_bindings(exported: &str) -> anyhow::Result<SplitBindings> {
    let (imports, rest) = split_before(exported, COMMANDS_MARKER)?;
    let (api, rest) = split_before(rest, CONSTANTS_MARKER)?;
    let (declarations, runtime) = split_before(rest, RUNTIME_MARKER)?;
    let names = type_names_used_by(declarations, &[api, runtime]);
    let types = format!("{GENERATED_HEADER}\n{}\n", declarations.trim_end());
    let commands = format!(
        "{}\nimport type {{ {} }} from \"{TYPES_MODULE}\";\n\n{api}{runtime}",
        imports.trim_end(),
        names.join(", "),
    );
    Ok(SplitBindings { types, commands })
}

/// Splits `text` at the start of `marker`, keeping the marker in the second half.
fn split_before<'a>(text: &'a str, marker: &str) -> anyhow::Result<(&'a str, &'a str)> {
    use anyhow::Context;
    let at = text.find(marker).with_context(|| {
        format!("tauri-specta output has no `{marker}` section after the previous one; update split_bindings for its layout")
    })?;
    Ok(text.split_at(at))
}

/// The names of the types exported by `declarations` that appear in the code (not the
/// doc comments) of any of `users`, in declaration order.
fn type_names_used_by(declarations: &str, users: &[&str]) -> Vec<String> {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    // A name only a comment mentions would be an unused import, which tsc rejects.
    let is_comment = |line: &&str| {
        let line = line.trim_start();
        line.starts_with("/*") || line.starts_with('*') || line.starts_with("//")
    };
    let used: std::collections::HashSet<&str> = users
        .iter()
        .flat_map(|text| text.lines())
        .filter(|line| !is_comment(line))
        .flat_map(|line| line.split(|c: char| !is_ident(c)))
        .collect();
    declarations
        .lines()
        .filter_map(|line| line.strip_prefix("export type "))
        .map(|rest| {
            rest.chars()
                .take_while(|&c| is_ident(c))
                .collect::<String>()
        })
        .filter(|name| used.contains(name.as_str()))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[expect(
    clippy::too_many_lines,
    reason = "split when substantially changed; architecture refactor section 10"
)]
pub fn run() {
    let builder = specta_builder();

    // Debug builds refresh the bindings on every launch. `make bindings` does the same
    // without starting the app, and CI diffs its output against the commit.
    #[cfg(debug_assertions)]
    if let Err(err) = export_bindings(&builder) {
        eprintln!("failed to refresh generated files: {err:#}");
    }

    let app = tauri::Builder::default()
        // First, so a second launch hands over before it opens anything: the running
        // instance shows its dashboard and the new process exits (one writer per history
        // file, architecture.md infra 8; the store's lock is the backstop).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if deferred_ui_launch(&args) { return; }
            if let Err(e) = windows::open_dashboard(app, None) {
                tracing::warn!("showing the dashboard for a second launch: {e}");
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The CSV export's save dialog, opened from Rust only: no window is granted the
        // plugin's permissions.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // Alert notifications, posted from Rust only (notify.rs): no window is granted the
        // plugin's permissions.
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&[popover::LABEL, windows::ONBOARDING])
                .build(),
        )
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            // Neither an unresolvable nor an unwritable log directory stops the launch:
            // logging falls back to stderr.
            let log_dir = app.path().app_log_dir().ok();
            // The guard flushes the log writer when the app exits.
            if let Some(guard) = logging::init(log_dir.as_deref()) {
                app.manage(guard);
            }
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                logs = ?log_dir,
                "StatGlass starting"
            );
            builder.mount_events(app);
            AppState::start(app.handle())?;
            windows::install_visibility_events(app.handle());
            let background_restart = updates::take_background_restart(app.handle());
            updates::start(app.handle());
            app.manage(windows::DashboardLifecycle::default());
            app_menu::install(app.handle())?;
            tray::create(app.handle())?;
            #[cfg(target_os = "macos")]
            if !background_restart && !deferred_ui_launch(std::env::args()) {
                popover::create(app.handle())?;
            }
            remote::start(app.handle())?;
            query::start(app.handle());
            cli_link::repair(app.handle());
            match bench::scenario() {
                Some(scenario) => bench::start(app.handle(), scenario),
                None => {
                    if startup::show_initial_windows(background_restart, deferred_ui_launch(std::env::args()), platform::launched_at_login()) {
                        windows::show_onboarding_if_needed(app.handle())?;
                        if app.state::<AppState>().settings.settings().onboarding.completed {
                            windows::open_dashboard(app.handle(),None)?;
                        }
                    }
                },
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started
                && let Some(state) = webview.try_state::<AppState>()
            {
                state.live.page_loading(webview.label());
            }
        })
        .on_window_event(|window, event| match event {
            // The popover hides when it loses key status: an outside click, or another
            // app activating (D-033).
            #[cfg(target_os = "macos")]
            WindowEvent::Focused(false) if window.label() == popover::LABEL => {
                popover::hide(window.app_handle());
            }
            WindowEvent::CloseRequested { api, .. } if window.label() == windows::DASHBOARD => {
                api.prevent_close();
                windows::hide_dashboard(window);
            }
            WindowEvent::Destroyed => {
                windows::destroyed(window.label());
                if let Some(state) = window.try_state::<AppState>() {
                    state.live.window_closed(window.label());
                    state.docker_streams.window_closed(&state, window.label());
                    if window.label() == windows::DASHBOARD {
                        disk_space::dashboard_closed(&state);
                    }
                }
            }
            _ => {}
        });
    // Replaces Tauri's default immediate reload: a showing popover reloads on its next
    // hide instead (D-035).
    #[cfg(target_os = "macos")]
    let app = app
        .plugin(tauri_nspanel::init())
        .on_web_content_process_terminate(popover::web_content_terminated);
    let mut context = tauri::generate_context!();
    // Bench bundles keep their explicit isolated identity even in debug builds.
    let identifier = runtime_identifier(&context.config().identifier).to_owned();
    context.config_mut().identifier = identifier;
    let app = app.build(context);
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            tracing::error!("StatGlass failed to start: {e}");
            eprintln!("StatGlass failed to start: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        // A menu bar app keeps running when its last window closes; only an explicit
        // quit (which carries an exit code) ends it.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Err(e) = windows::open_dashboard(app, None) {
                tracing::warn!("reopening dashboard: {e}");
            }
        }
        RunEvent::Exit => {
            remote::shutdown(app);
            query::shutdown(app);
            if let Some(state) = app.try_state::<AppState>() {
                state.shutdown();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::deferred_ui_launch;

    #[test]
    fn launch_modes_defer_ui_only_for_remote_setup_and_background() {
        for args in [vec!["statglass"], vec!["statglass", "--unrelated"], vec![]] {
            assert!(!deferred_ui_launch(args));
        }
        for args in [
            vec!["statglass", "--remote-setup"],
            vec!["statglass", "--background"],
            vec!["statglass", "--background", "--remote-setup"],
        ] {
            assert!(deferred_ui_launch(args));
        }
    }
}

#[cfg(test)]
mod bindings_tests {
    use super::{TYPES_MODULE, export_to_string, specta_builder, split_bindings};

    #[test]
    fn types_carry_no_tauri_import_and_commands_import_the_types_they_name() {
        let exported = export_to_string(&specta_builder()).unwrap();
        let split = split_bindings(&exported).unwrap();

        assert!(
            !split.types.contains("@tauri-apps"),
            "types.ts imports Tauri"
        );
        assert!(!split.types.contains("export const commands"));
        assert!(split.types.contains("export type LiveMsg ="));
        assert!(split.types.contains("export const CHART_WINDOWS ="));

        assert!(split.commands.contains("export const commands = {"));
        assert!(split.commands.contains("export const events = {"));
        assert!(split.commands.contains("function makeEvent<T>"));
        assert!(!split.commands.contains("export type "));
        let types_import = split
            .commands
            .lines()
            .find(|line| line.ends_with(&format!("from \"{TYPES_MODULE}\";")))
            .expect("commands.ts imports the generated types");
        for name in ["LiveMsg", "CommandError", "DockerSnapshot"] {
            assert!(
                types_import.contains(&format!(" {name},")),
                "{name} not imported"
            );
        }
        assert!(
            !types_import.contains(" UsageTotal,"),
            "unused type imported"
        );
    }

    #[test]
    fn a_changed_generator_layout_is_an_error() {
        let reordered = "/* Constants */\n/** Commands */\n/* Tauri Specta runtime */\n";
        let error = split_bindings(reordered)
            .err()
            .expect("out of order sections");
        assert!(error.to_string().contains("/* Constants */"), "{error}");
        assert!(split_bindings("export type A = number;\n").is_err());
    }
}

/// Development builds are isolated from installed data; bench builds supply their own ID.
#[cfg(all(debug_assertions, not(feature = "bench")))]
fn runtime_identifier(_: &str) -> &str {
    DEV_IDENTIFIER
}

#[cfg(not(all(debug_assertions, not(feature = "bench"))))]
fn runtime_identifier(configured: &str) -> &str {
    configured
}

#[cfg(test)]
mod identity_tests {
    #[test]
    fn bench_keeps_the_configured_identity_and_normal_debug_uses_dev_data() {
        let configured = "com.tryopendata.statglass.bench.ux-native";
        #[cfg(all(debug_assertions, not(feature = "bench")))]
        let expected = super::DEV_IDENTIFIER;
        #[cfg(not(all(debug_assertions, not(feature = "bench"))))]
        let expected = configured;
        assert_eq!(super::runtime_identifier(configured), expected);
    }
}
