use serde::Serialize;

/// An error the UI can act on: a stable `code` plus a sentence a person can read.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn not_found(what: &str) -> Self {
        Self::new("not_found", format!("{what} not found"))
    }

    pub fn bad(message: impl Into<String>) -> Self {
        Self::new("bad_request", message)
    }

    pub fn internal(e: impl std::fmt::Display) -> Self {
        Self::new("internal", e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code)?;
        st.serialize_field("message", &self.message)?;
        st.end()
    }
}

macro_rules! internal_from {
    ($($t:ty),*) => {
        $(impl From<$t> for AppError {
            fn from(e: $t) -> Self {
                log::error!("{e}");
                AppError::internal(e)
            }
        })*
    };
}

internal_from!(
    rusqlite::Error,
    std::io::Error,
    serde_json::Error,
    zip::result::ZipError,
    tauri::Error
);

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::new("network", format!("Couldn't reach the server: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
