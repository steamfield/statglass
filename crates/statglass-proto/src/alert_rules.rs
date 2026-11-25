//! A host's custom alert rules on the wire (plan/rfc-remote-alerts.md 5.1): what
//! `Query::AlertRules` and `Query::SetAlertRules` carry. A one-way door like the rest of
//! the wire.
//!
//! Rules travel as individually decoded entries. `lenient` turns a whole query or answer
//! into `Unknown` when any part fails to decode, so one rule from a newer build (a new
//! condition) would otherwise make the whole list unreadable. An entry this build cannot
//! decode is carried as raw CBOR and re-encodes unchanged.

use serde::{Deserialize, Deserializer, Serialize};
use statglass_schema::AlertRule;

/// The custom rules a host evaluates, with the revision a later `SetAlertRules` must name.
///
/// `revision` is opaque to the controller: the host derives it from the rule list's
/// content, so it survives a host restart, and keeps it below 2^53 so it crosses to
/// TypeScript as a number.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostAlertRules {
    pub revision: i64,
    pub rules: Vec<RuleEntry>,
}

/// One rule entry: a rule this build decodes, or the raw CBOR of one it does not.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RuleEntry {
    Known(AlertRule),
    Unknown(ciborium::Value),
}

impl<'de> Deserialize<'de> for RuleEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Serde's untagged buffer rejects CBOR tags before trying either variant.
        let value = ciborium::Value::deserialize(deserializer)?;
        Ok(match value.deserialized::<AlertRule>() {
            Ok(rule) => Self::Known(rule),
            Err(_) => Self::Unknown(value),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Answer, ErrorCode, Message, Query, encode_message};

    // Pinned to b0cf8cad, with the request and reply kinds irrelevant to this exchange omitted.
    trait BeforeAlertsTagged: serde::de::DeserializeOwned {
        fn unknown() -> Self;
    }

    fn before_alerts_lenient<'de, D, T>(d: D) -> Result<T, D::Error>
    where
        D: Deserializer<'de>,
        T: BeforeAlertsTagged,
    {
        let value = ciborium::Value::deserialize(d)?;
        Ok(value.deserialized::<T>().unwrap_or_else(|_| T::unknown()))
    }

    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(tag = "t", content = "c")]
    enum BeforeAlertsMessage {
        Request {
            id: u32,
            #[serde(deserialize_with = "before_alerts_lenient")]
            query: BeforeAlertsQuery,
        },
        Reply {
            id: u32,
            #[serde(deserialize_with = "before_alerts_lenient")]
            answer: BeforeAlertsAnswer,
        },
    }

    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(tag = "q", content = "a")]
    enum BeforeAlertsQuery {
        SpaceVolumes,
        #[serde(other)]
        Unknown,
    }

    impl BeforeAlertsTagged for BeforeAlertsQuery {
        fn unknown() -> Self {
            Self::Unknown
        }
    }

    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(tag = "a", content = "v")]
    enum BeforeAlertsAnswer {
        Error {
            code: BeforeAlertsErrorCode,
            message: String,
        },
        #[serde(other)]
        Unknown,
    }

    impl BeforeAlertsTagged for BeforeAlertsAnswer {
        fn unknown() -> Self {
            Self::Unknown
        }
    }

    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum BeforeAlertsErrorCode {
        Unsupported,
        #[serde(other)]
        Unknown,
    }

    #[test]
    fn alert_rules_messages_decode_as_unknown_to_a_pre_alert_peer() {
        for query in [
            Query::AlertRules,
            Query::SetAlertRules {
                base_revision: 4,
                rules: vec![],
                keep: vec![uuid::Uuid::from_u128(1)],
            },
        ] {
            let bytes = encode_message(&Message::Request { id: 1, query }).unwrap();
            assert_eq!(
                ciborium::from_reader::<BeforeAlertsMessage, _>(bytes.as_slice()).unwrap(),
                BeforeAlertsMessage::Request {
                    id: 1,
                    query: BeforeAlertsQuery::Unknown,
                }
            );
        }

        let bytes = encode_message(&Message::Reply {
            id: 1,
            answer: Answer::AlertRules(HostAlertRules {
                revision: 4,
                rules: vec![],
            }),
        })
        .unwrap();
        assert_eq!(
            ciborium::from_reader::<BeforeAlertsMessage, _>(bytes.as_slice()).unwrap(),
            BeforeAlertsMessage::Reply {
                id: 1,
                answer: BeforeAlertsAnswer::Unknown,
            }
        );
    }

    #[test]
    fn stale_is_an_unknown_error_code_to_a_pre_alert_peer() {
        let bytes = encode_message(&Message::Reply {
            id: 1,
            answer: Answer::Error {
                code: ErrorCode::Stale,
                message: "The rules changed".into(),
            },
        })
        .unwrap();
        assert_eq!(
            ciborium::from_reader::<BeforeAlertsMessage, _>(bytes.as_slice()).unwrap(),
            BeforeAlertsMessage::Reply {
                id: 1,
                answer: BeforeAlertsAnswer::Error {
                    code: BeforeAlertsErrorCode::Unknown,
                    message: "The rules changed".into(),
                },
            }
        );
    }
}
