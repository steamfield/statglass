//! Writes `src/core/generated/bindings.ts` and the tray rate table without launching
//! the app. Run by `make bindings` and by CI's drift check.

fn main() -> anyhow::Result<()> {
    statglass_lib::export_bindings(&statglass_lib::specta_builder())?;
    println!("wrote {}", statglass_lib::BINDINGS_PATH);
    println!("wrote {}", statglass_lib::TRAY_RATES_PATH);
    Ok(())
}
