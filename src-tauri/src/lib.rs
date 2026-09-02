use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{ipc::InvokeBody, ipc::Request, State};

struct ExportSession {
    writer: Option<BufWriter<File>>,
    temporary_path: PathBuf,
    destination_path: PathBuf,
}

impl Drop for ExportSession {
    fn drop(&mut self) {
        self.writer.take();
        let _ = fs::remove_file(&self.temporary_path);
    }
}

#[derive(Default)]
struct ExportState(Mutex<Option<ExportSession>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemProfile {
    logical_cpus: usize,
    total_memory_bytes: u64,
    architecture: &'static str,
}

#[cfg(windows)]
fn total_memory_bytes() -> u64 {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::SystemInformation::{
        GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };

    let mut status: MEMORYSTATUSEX = unsafe { zeroed() };
    status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
        status.ullTotalPhys
    } else {
        8 * 1024 * 1024 * 1024
    }
}

#[cfg(not(windows))]
fn total_memory_bytes() -> u64 {
    8 * 1024 * 1024 * 1024
}

#[tauri::command]
fn system_profile() -> SystemProfile {
    SystemProfile {
        logical_cpus: std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(4),
        total_memory_bytes: total_memory_bytes(),
        architecture: std::env::consts::ARCH,
    }
}

#[tauri::command]
fn read_pdf(path: PathBuf) -> Result<tauri::ipc::Response, String> {
    if path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase)
        != Some("pdf".to_string())
    {
        return Err("Die ausgewählte Datei ist keine PDF-Datei.".into());
    }

    let bytes = fs::read(&path)
        .map_err(|error| format!("PDF konnte nicht gelesen werden: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("Die ausgewählte Datei enthält kein gültiges PDF.".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

fn temporary_path_for(destination: &Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Der Zielordner ist ungültig.".to_string())?;
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Der Dateiname ist ungültig.".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(parent.join(format!(".{filename}.{nonce}.part")))
}

#[tauri::command]
fn begin_export(path: PathBuf, state: State<'_, ExportState>) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    if active.is_some() {
        return Err("Es läuft bereits ein Export.".into());
    }
    let temporary_path = temporary_path_for(&path)?;
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("Ausgabedatei konnte nicht angelegt werden: {error}"))?;
    *active = Some(ExportSession {
        writer: Some(BufWriter::with_capacity(1024 * 1024, file)),
        temporary_path,
        destination_path: path,
    });
    Ok(())
}

#[tauri::command]
fn write_export(request: Request<'_>, state: State<'_, ExportState>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Ungültiger Datenblock beim Export.".into());
    };
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    let session = active
        .as_mut()
        .ok_or_else(|| "Es ist kein Export geöffnet.".to_string())?;
    session
        .writer
        .as_mut()
        .ok_or_else(|| "Der Export ist bereits abgeschlossen.".to_string())?
        .write_all(bytes)
        .map_err(|error| format!("Schreiben fehlgeschlagen: {error}"))
}

#[tauri::command]
fn finish_export(state: State<'_, ExportState>) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    let mut session = active
        .take()
        .ok_or_else(|| "Es ist kein Export geöffnet.".to_string())?;
    let mut writer = session
        .writer
        .take()
        .ok_or_else(|| "Der Export ist bereits abgeschlossen.".to_string())?;
    writer
        .flush()
        .map_err(|error| format!("Ausgabedatei konnte nicht abgeschlossen werden: {error}"))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("Ausgabedatei konnte nicht synchronisiert werden: {error}"))?;
    drop(writer);

    if session.destination_path.exists() {
        let backup_path = session.temporary_path.with_extension("backup");
        fs::rename(&session.destination_path, &backup_path)
            .map_err(|error| format!("Vorhandene Zieldatei konnte nicht vorbereitet werden: {error}"))?;
        if let Err(error) = fs::rename(&session.temporary_path, &session.destination_path) {
            let _ = fs::rename(&backup_path, &session.destination_path);
            return Err(format!("Ausgabedatei konnte nicht finalisiert werden: {error}"));
        }
        let _ = fs::remove_file(backup_path);
    } else {
        fs::rename(&session.temporary_path, &session.destination_path)
            .map_err(|error| format!("Ausgabedatei konnte nicht finalisiert werden: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn abort_export(state: State<'_, ExportState>) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    active.take();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExportState::default())
        .invoke_handler(tauri::generate_handler![
            system_profile,
            read_pdf,
            begin_export,
            write_export,
            finish_export,
            abort_export,
        ])
        .run(tauri::generate_context!())
        .expect("PDF / PIXEL konnte nicht gestartet werden");
}
