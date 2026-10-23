import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const fixture = path.join(root, '.cache/updater-qa-' + crypto.randomUUID())
await fs.mkdir(fixture, { recursive: true })
const installer = path.join(root, `dist/QQDshDeployer-${version}-x64-Setup.exe`)
const bytes = await fs.readFile(installer)
const expected = crypto.createHash('sha512').update(bytes).digest('base64')
const server = http.createServer((req, res) => {
  if (req.url?.includes('latest.yml')) {
    const bad = req.url.startsWith('/bad/')
    const manifest = `version: 9.9.9\nfiles:\n  - url: ${bad ? 'tampered' : 'valid'}.exe\n    sha512: ${expected}\n    size: ${bytes.length}\npath: ${bad ? 'tampered' : 'valid'}.exe\nsha512: ${expected}\nreleaseDate: 2026-10-23T00:00:00.000Z\n`
    res.setHeader('content-type', 'text/yaml')
    res.end(manifest)
    return
  }
  res.setHeader('content-length', bytes.length)
  if (req.url?.includes('tampered.exe')) {
    const altered = Buffer.from(bytes)
    altered[1000] ^= 255
    res.end(altered)
  } else res.end(bytes)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
const main = `const {app}=require('electron');
const {NsisUpdater}=require(${JSON.stringify(path.join(root, 'node_modules/electron-updater'))});
const fs=require('node:fs/promises'); const path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(fixture, 'user-data'))});
app.whenReady().then(async()=>{const results=[];try{for(const label of ['valid','bad']){
 const config=path.join(${JSON.stringify(fixture)},label+'.yml');
 await fs.writeFile(config,'provider: generic\\nurl: ${url}/'+label+'/\\nupdaterCacheDirName: qqdsh-qa-'+label+'-${crypto.randomUUID()}\\n');
 const u=new NsisUpdater({provider:'generic',url:'${url}/'+label+'/'});u.forceDevUpdateConfig=true;u.updateConfigPath=config;u.autoDownload=false;u.autoInstallOnAppQuit=false;u.disableDifferentialDownload=true;u.on('error',()=>{});
 const checked=await u.checkForUpdates(); if(checked.updateInfo.version!=='9.9.9')throw new Error('Fixture update not discovered');
 if(label==='valid'){const files=await u.downloadUpdate();if(!files.length)throw new Error('No downloaded file');results.push('real NSIS updater downloads valid SHA-512 payload');}
 else{let rejected=false;try{await u.downloadUpdate()}catch(e){if(/checksum|sha512/i.test(String(e)))rejected=true;else throw e;}if(!rejected)throw new Error('Tampered payload accepted');results.push('real NSIS updater rejects tampered payload');}
 }await fs.writeFile(${JSON.stringify(path.join(root, 'output/acceptance/updater-transport.json'))},JSON.stringify({at:new Date().toISOString(),checks:results,origin:'isolated loopback fixture',installationExecuted:false},null,2));console.log('UPDATER_TRANSPORT_RESULT '+JSON.stringify(results));app.exit(0);}catch(e){console.error(e);app.exit(1)}});`
const entry = path.join(fixture, 'main.cjs')
await fs.writeFile(entry, main)
await fs.writeFile(
  path.join(fixture, 'package.json'),
  JSON.stringify({ name: 'qqdsh-updater-transport-qa', version: '0.0.0', main: 'main.cjs' }),
)
await fs.mkdir(path.join(root, 'output/acceptance'), { recursive: true })
const env = { ...process.env, LOCALAPPDATA: path.join(fixture, 'cache') }
delete env.ELECTRON_RUN_AS_NODE
try {
  const code = await new Promise((resolve, reject) => {
    const p = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [fixture], {
      env,
      windowsHide: true,
      stdio: 'inherit',
    })
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('Updater fixture timed out'))
    }, 90000)
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  if (code !== 0) throw new Error('Updater transport acceptance failed')
} finally {
  await new Promise((r) => server.close(r))
}
