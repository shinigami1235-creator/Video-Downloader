//! A small HTTP server on 127.0.0.1 that the browser extension sends links to.
//!
//! Only this computer can reach it. Requests must be addressed to 127.0.0.1 or
//! localhost (stops DNS rebinding) and writes must come from a browser
//! extension, whose Origin header a web page cannot fake.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// The extension tries these in order.
pub const PORTS: [u16; 5] = [47821, 47822, 47823, 47824, 47825];
const MAX_BODY: usize = 4 * 1024 * 1024;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = PORTS
            .iter()
            .find_map(|p| TcpListener::bind(("127.0.0.1", *p)).ok().map(|l| (l, *p)));
        let Some((listener, port)) = listener else {
            return;
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, port, &app);
            });
        }
    });
}

fn is_extension(origin: &str) -> bool {
    origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://") || origin.starts_with("extension://")
}

fn handle(stream: TcpStream, port: u16, app: &AppHandle) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut host = String::new();
    let mut origin = String::new();
    let mut length = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "host" => host = v.to_string(),
                "origin" => origin = v.to_string(),
                "content-length" => length = v.parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    let mut out = stream;
    let ok_host = host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}");
    if !ok_host {
        return respond(&mut out, 404, "", "{}");
    }
    let cors = if is_extension(&origin) { origin.as_str() } else { "" };

    match (method.as_str(), path.as_str()) {
        ("OPTIONS", _) => respond(&mut out, 204, cors, ""),
        ("GET", "/ping") => respond(&mut out, 200, cors, r#"{"app":"video-downloader","version":1}"#),
        ("POST", "/add") => {
            if !is_extension(&origin) {
                return respond(&mut out, 403, "", r#"{"error":"forbidden"}"#);
            }
            if length == 0 || length > MAX_BODY {
                return respond(&mut out, 413, cors, r#"{"error":"too large"}"#);
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body)?;
            let text = String::from_utf8_lossy(&body).to_string();
            if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                return respond(&mut out, 400, cors, r#"{"error":"bad json"}"#);
            }
            let _ = app.emit("extension-add", text);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            respond(&mut out, 200, cors, r#"{"ok":true}"#)
        }
        _ => respond(&mut out, 404, cors, "{}"),
    }
}

fn respond(out: &mut TcpStream, code: u16, cors: &str, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        413 => "Payload Too Large",
        _ => "Not Found",
    };
    let mut head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if !cors.is_empty() {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {cors}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n"
        ));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;
    out.write_all(body.as_bytes())?;
    out.flush()
}
