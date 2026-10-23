export const componentIds = [
  'node',
  'npm',
  'git',
  'powershell',
  'qq',
  'harness',
  'snowluma',
  'bridge',
  'plugins',
] as const
export type ComponentId = (typeof componentIds)[number]
export type Health = 'ok' | 'missing' | 'stopped' | 'waiting' | 'error' | 'unknown'
export type Page = 'overview' | 'deploy' | 'config' | 'services' | 'logs'
export interface Candidate {
  path: string
  version?: string
  evidence: string
}
export interface ComponentResult {
  id: ComponentId
  name: string
  state: Health
  version?: string
  path?: string
  detail: string
  evidence: string[]
  candidates: Candidate[]
  optional?: boolean
  latest?: string
  updateError?: string
  compatibility?: string
}
export interface Settings {
  installRoot: string
  dshHome: string
  nodePath: string
  harnessPath: string
  snowlumaPath: string
  bridgePath: string
  qqPath: string
  dshUrl: string
  httpUrl: string
  wsUrl: string
  consolePort: number
  ownerQQ: string
  groups: string
  friends: string
  model: string
  proxy: string
  snowlumaAuthorized: boolean
  firstRun: boolean
  pwshPath: string
  registerPwshPath: boolean
}
export interface ConfigInput {
  settings: Settings
  httpToken?: string
  wsToken?: string
  applyBridge?: boolean
}
export interface LogEntry {
  id: string
  at: string
  level: 'info' | 'warn' | 'error'
  message: string
}
export type StepState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'
export interface TaskStep {
  id: string
  title: string
  state: StepState
  detail?: string
  progress?: number
}
export interface Task {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
  steps: TaskStep[]
  startedAt: string
  error?: string
}
export type DeployAction = 'node' | 'powershell' | 'harness' | 'snowluma' | 'bridge' | 'plugins'
export interface DeployRequest {
  actions: DeployAction[]
  acceptUnverified: boolean
}
export interface DeployPlan {
  request: DeployRequest
  items: {
    id: DeployAction
    title: string
    version: string
    source: string
    destination: string
    changes: string[]
  }[]
  warnings: string[]
}
export interface BackupInfo {
  id: string
  createdAt: string
  label: string
}
export interface Snapshot {
  settings: Settings
  components: ComponentResult[]
  logs: LogEntry[]
  task: Task | null
  tokenPresent: { http: boolean; ws: boolean }
  backups: BackupInfo[]
  owned: Partial<Record<'bridge' | 'snowluma' | 'harness', number>>
  version: string
  appUpdate?: AppUpdate
}
export interface AppUpdate {
  state: 'idle' | 'checking' | 'current' | 'downloading' | 'downloaded' | 'error'
  current: string
  latest?: string
  percent?: number
  detail: string
  mode: 'installer' | 'portable' | 'development'
}
export type OpenTarget = 'harness' | 'snowluma' | 'bridge' | 'qq' | 'data' | 'docs' | 'snow-docs'
export interface DeployerAPI {
  snapshot(): Promise<Snapshot>
  scan(): Promise<ComponentResult[]>
  updates(): Promise<ComponentResult[]>
  saveConfig(input: ConfigInput): Promise<Settings>
  choosePath(kind: 'file' | 'directory'): Promise<string | null>
  preview(request: DeployRequest): Promise<DeployPlan>
  deploy(request: DeployRequest): Promise<void>
  cancel(): Promise<void>
  resume(): Promise<void>
  retry(): Promise<void>
  service(
    id: 'bridge' | 'snowluma' | 'harness',
    action: 'start' | 'stop' | 'restart',
  ): Promise<void>
  open(target: OpenTarget): Promise<void>
  exportDiagnostics(): Promise<string | null>
  restore(id: string): Promise<void>
  importConfig(): Promise<Settings>
  checkAppUpdate(): Promise<void>
  installAppUpdate(): Promise<void>
  openProject(id: string): Promise<void>
  onCommand(callback: (command: 'about' | 'updates') => void): () => void
  onChange(callback: (snapshot: Snapshot) => void): () => void
}
declare global {
  interface Window {
    deployer: DeployerAPI
  }
}
