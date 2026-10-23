import { expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Store } from '../src/main/store'
import { Engine } from '../src/main/engine'
import { command } from '../src/main/system'
import { json, writeJson } from '../src/main/core'
it.skipIf(process.env.QQDSH_LIVE_INSTALL_TEST !== '1')(
  'installs pinned PowerShell, Node and bridge into isolated project cache without changing user PATH',
  async () => {
    const root = path.resolve('.cache/live-deployment')
    const catalog = await json(path.resolve('resources/catalog.json'))
    const store = new Store(root, {
      encrypt: (s) => Buffer.from(s).reverse(),
      decrypt: (b) => Buffer.from(b).reverse().toString(),
    })
    const engine = new Engine(
      store,
      catalog,
      () => {},
      async () => {},
    )
    await engine.init()
    store.settings.installRoot = path.join(root, 'components')
    store.settings.registerPwshPath = false
    store.settings.dshHome = path.join(root, '独立 DSH')
    store.settings.nodePath = ''
    if (process.env.QQDSH_OFFICIAL_HARNESS) {
      store.settings.harnessPath = process.env.QQDSH_OFFICIAL_HARNESS
      const profile = path.join(store.settings.dshHome, 'profiles/desktop')
      await fs.mkdir(profile, { recursive: true })
      if (!(await json(path.join(profile, 'package.json'))))
        await writeJson(path.join(profile, 'package.json'), {
          name: 'isolated-desktop-cli-acceptance',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [] } },
        })
    }
    vi.spyOn(engine, 'scan').mockResolvedValue([])
    const pathBefore = process.env.PATH
    await engine.deploy({
      actions: [
        'powershell',
        'node',
        'bridge',
        ...(process.env.QQDSH_OFFICIAL_HARNESS ? ['plugins' as const] : []),
      ],
      acceptUnverified: false,
    })
    await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(engine.task?.state), {
      timeout: 600000,
      interval: 500,
    })
    expect(engine.task?.state, engine.task?.error).toBe('done')
    expect(
      await command(store.settings.pwshPath, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.ToString()',
      ]),
    ).toBe(catalog.powershell.version)
    expect(await command(store.settings.nodePath, ['--version'])).toBe('v' + catalog.node.version)
    const bridge = await json(path.join(store.settings.bridgePath, 'package.json'))
    expect(bridge.version).toBe(catalog.bridge.version)
    expect(
      await fs.readFile(path.join(store.settings.bridgePath, 'src/bridge.js'), 'utf8'),
    ).toContain('cfg.snowluma.wsAccessToken || cfg.snowluma.accessToken')
    if (process.env.QQDSH_OFFICIAL_HARNESS) {
      const profile = path.join(store.settings.dshHome, 'profiles/desktop')
      const pkg = await json(path.join(profile, 'package.json'))
      expect(pkg.dsh.profile.bundles).toContain('qq-mode-console')
      expect(pkg.dsh.profile.bundles).toContain('qq-agent-presets')
      expect(await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')).toContain(
        'mcp-web-search-safe',
      )
    }
    expect(
      (await json(path.join(store.settings.bridgePath, 'config.json'))).allowAllWhenEmpty,
    ).toBe(false)
    expect(process.env.PATH).toBe(pathBefore)
    await fs.mkdir('output/acceptance', { recursive: true })
    await fs.writeFile(
      'output/acceptance/live-deployment.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          task: engine.task,
          powershell: catalog.powershell.version,
          node: catalog.node.version,
          bridge: bridge.version,
          userPathChanged: false,
          realQQRoundTrip: 'not-run',
        },
        null,
        2,
      ),
    )
  },
  650000,
)
