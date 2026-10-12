const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Native file dialog inside Tauri; a plain file input when opened in a browser. */
export async function pickTextFiles(): Promise<{ name: string; text: string }[]> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const picked = await open({ multiple: true, filters: [{ name: 'Text', extensions: ['md', 'txt'] }] });
    const paths = ([] as string[]).concat(picked ?? []);
    return Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop()!, text: await readTextFile(p) })));
  }
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.md,.txt' });
    input.onchange = async () =>
      resolve(await Promise.all(Array.from(input.files ?? []).map(async (f) => ({ name: f.name, text: await f.text() }))));
    input.click();
  });
}
