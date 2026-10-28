import { expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Store } from '../src/main/store'
import { installTtsStage, validateTtsRoot } from '../src/main/tts'
import { command } from '../src/main/system'
import { downloadModelScript, synthesizeScript } from '../src/main/tts-scripts'

it.skipIf(process.env.QQDSH_TTS_RUNTIME_TEST !== '1')(
  'installs and validates only the isolated Python bootstrap without model weights or PyTorch',
  async () => {
    const root = path.resolve('.cache/tts-runtime-live')
    const store = new Store(root, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
    await store.init()
    store.settings.dshHome = path.join(root, 'isolated-dsh')
    const pathBefore = process.env.PATH
    await installTtsStage(
      'tts-runtime',
      store.settings,
      root,
      'cpu',
      new AbortController().signal,
      (line) => console.log(line),
      () => {},
    )
    const python = path.join(store.settings.ttsRoot, '.venv/Scripts/python.exe')
    await expect(validateTtsRoot(store.settings, root)).resolves.toBe(store.settings.ttsRoot)
    expect(
      await command(python, ['-c', 'import sys; print(sys.version); print(sys.prefix)']),
    ).toContain('3.12.12')
    const scripts = { 'download-model.py': downloadModelScript, 'synthesize.py': synthesizeScript }
    for (const [name, script] of Object.entries(scripts)) {
      const target = path.join(root, name)
      await fs.writeFile(target, script)
      await command(python, [
        '-c',
        'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")',
        target,
      ])
    }
    expect(process.env.PATH).toBe(pathBefore)
  },
  600000,
)
