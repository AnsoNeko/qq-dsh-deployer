import { contextBridge, ipcRenderer } from 'electron'
import type { DeployerAPI, Snapshot } from '../shared/types'
const invoke = (name: string, input?: unknown) => ipcRenderer.invoke(`deployer:${name}`, input)
const api: DeployerAPI = {
  snapshot: () => invoke('snapshot'),
  scan: () => invoke('scan'),
  updates: () => invoke('updates'),
  checkAppUpdate: () => invoke('checkAppUpdate'),
  installAppUpdate: () => invoke('installAppUpdate'),
  openProject: (id) => invoke('openProject', id),
  onCommand: (callback) => {
    const handler = (_event: unknown, command: 'about' | 'updates') => callback(command)
    ipcRenderer.on('deployer:command', handler)
    return () => ipcRenderer.removeListener('deployer:command', handler)
  },
  saveConfig: (v) => invoke('saveConfig', v),
  importConfig: () => invoke('importConfig'),
  choosePath: (v) => invoke('choosePath', v),
  preview: (v) => invoke('preview', v),
  deploy: (v) => invoke('deploy', v),
  cancel: () => invoke('cancel'),
  resume: () => invoke('resume'),
  retry: () => invoke('retry'),
  service: (id, action) => invoke('service', { id, action }),
  open: (v) => invoke('open', v),
  restore: (id) => invoke('restore', id),
  exportDiagnostics: () => invoke('exportDiagnostics'),
  onChange: (callback) => {
    const handler = (_event: unknown, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('deployer:change', handler)
    return () => ipcRenderer.removeListener('deployer:change', handler)
  },
}
contextBridge.exposeInMainWorld('deployer', api)
