//! Host vitals shared with the mobile command layer.
pub use statglass_ipc::vitals::{HostVitals, MemoryPressure};

#[cfg(test)]
mod tests {
    use crate::remote::UpdatePhase;

    #[test]
    fn unknown_update_phases_decode_without_breaking_status() {
        assert_eq!(
            serde_json::from_str::<UpdatePhase>(r#"{"kind":"future_phase"}"#).unwrap(),
            UpdatePhase::Unknown
        );
    }
}
