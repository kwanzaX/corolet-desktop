/// Native shell for the Corolet Desktop UI. The web layer talks to the server
/// over HTTP and Socket.IO; the shell adds the native file dialog and file
/// reading, scoped by the capabilities in `capabilities/default.json`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Corolet Desktop");
}
