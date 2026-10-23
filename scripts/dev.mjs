import { spawn } from 'node:child_process'
import path from 'node:path'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(
  process.execPath,
  [path.resolve('node_modules/electron-vite/bin/electron-vite.js'), 'dev'],
  { stdio: 'inherit', env },
)
child.on('exit', (code) => process.exit(code ?? 1))
