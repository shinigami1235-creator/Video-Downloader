//! Clipboard reading and sending files to the phone through Desktop Connector.

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

/// The text on the clipboard, or an empty string when it holds something else.
#[tauri::command]
pub fn clipboard_text() -> String {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .unwrap_or_default()
}

/// Desktop Connector listens on the first free port from 8765 to 8774.
async fn find_connector(client: &reqwest::Client) -> Option<u16> {
    for port in 8765u16..8775 {
        let url = format!("http://127.0.0.1:{port}/desk/ping");
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if v.get("app").and_then(|a| a.as_str()) == Some("desktop-connector") {
                    return Some(port);
                }
            }
        }
    }
    None
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(400))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

/// True when Desktop Connector is open on this computer.
#[tauri::command]
pub async fn connector_running() -> bool {
    match client() {
        Ok(c) => find_connector(&c).await.is_some(),
        Err(_) => false,
    }
}

/// Puts a file in Desktop Connector's "Send to devices" list.
#[tauri::command]
pub async fn connector_send(path: String) -> Result<(), String> {
    let c = client()?;
    let port = find_connector(&c)
        .await
        .ok_or_else(|| "Desktop Connector is not open.".to_string())?;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string());
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("{name} could not be opened: {e}"))?;
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let resp = c
        .put(format!("http://127.0.0.1:{port}/desk/api/outbox"))
        .header("X-DC", "1")
        .header("X-File-Name", utf8_percent_encode(&name, NON_ALPHANUMERIC).to_string())
        .header("Content-Length", size)
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|e| format!("Desktop Connector did not take the file: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Desktop Connector did not take the file ({}).", resp.status()));
    }
    Ok(())
}

/// Lets a downloaded program run. On a Mac a file arrives without permission to run.
#[tauri::command]
pub fn fs_make_executable(path: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make '{path}' runnable: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
