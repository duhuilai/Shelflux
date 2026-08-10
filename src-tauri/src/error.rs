use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("SSH 错误: {0}")]
    Ssh(String),

    #[error("SFTP 错误: {0}")]
    Sftp(String),

    #[error("协议错误: {0}")]
    Protocol(String),

    #[error("会话未找到: {0}")]
    SessionNotFound(String),

    #[error("路径不存在: {0}")]
    NotFound(String),

    #[error("{0}")]
    Other(String),
}

impl From<russh::Error> for AppError {
    fn from(err: russh::Error) -> Self {
        AppError::Ssh(err.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(err: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(err.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::Other(err.to_string())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
