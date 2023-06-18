import { DAEMON_PB_DATA_DIR, DAEMON_PB_MIGRATIONS_DIR } from '$constants'
import {
  downloadAndExtract,
  mkInternalAddress,
  mkInternalUrl,
  smartFetch,
  tryFetch,
} from '$util'
import {
  createCleanupManager,
  createTimerManager,
  safeCatch,
} from '@pockethost/common'
import {
  mkSingleton,
  SingletonBaseConfig,
} from '@pockethost/common/src/mkSingleton'
import { keys } from '@s-libs/micro-dash'
import { spawn } from 'child_process'
import { chmodSync, existsSync } from 'fs'
import getPort from 'get-port'
import { type } from 'os'
import { join } from 'path'
import { gte, maxSatisfying, rsort } from 'semver'
import { AsyncReturnType } from 'type-fest'

export type PocketbaseCommand = 'serve' | 'migrate'
export type SpawnConfig = {
  command: PocketbaseCommand
  slug: string
  version?: string
  port?: number
  isMothership?: boolean
  onUnexpectedStop?: (code: number | null) => void
}
export type PocketbaseServiceApi = AsyncReturnType<
  typeof createPocketbaseService
>

export type PocketbaseServiceConfig = SingletonBaseConfig & {
  cachePath: string
  checkIntervalMs: number
}

export type PocketbaseProcess = {
  url: string
  pid: number | undefined
  kill: () => boolean
  exited: Promise<number | null>
}

export type Release = {
  tag_name: string
  prerelease: string
  assets: {
    name: string
    browser_download_url: string
  }[]
}
export type Releases = Release[]

export const createPocketbaseService = async (
  config: PocketbaseServiceConfig
) => {
  const { logger } = config
  const _serviceLogger = logger.create('PocketbaseService')
  const { dbg, error, warn, abort } = _serviceLogger

  const { cachePath, checkIntervalMs } = config

  const cm = createCleanupManager()
  const tm = createTimerManager({})

  const osName = type().toLowerCase()
  const cpuArchitecture = process.arch === 'x64' ? 'amd64' : process.arch

  dbg({ osName, cpuArchitecture })
  const binPaths: { [_: string]: string } = {}
  let maxVersion = ''

  const check = async () => {
    const releases = await smartFetch<Releases>(
      `https://api.github.com/repos/pocketbase/pocketbase/releases?per_page=100`,
      join(cachePath, `releases.json`)
    )
    // dbg({ releases })

    const promises = releases.map(async (release) => {
      const { tag_name, prerelease, assets } = release
      const sanitizedTagName = tag_name.slice(1)
      if (prerelease) return
      const path = join(cachePath, tag_name)
      const url = assets.find((v) => {
        // dbg(v.name)
        return v.name.includes(osName) && v.name.includes(cpuArchitecture)
      })?.browser_download_url
      if (!url) return

      const binPath = join(path, `pocketbase`)
      dbg(`Checking ${binPath}`)

      if (existsSync(binPath)) {
        chmodSync(binPath, 0o775)
      } else {
        await downloadAndExtract(url, binPath, _serviceLogger)
      }
      binPaths[sanitizedTagName] = binPath
    })
    await Promise.all(promises)
    if (keys(binPaths).length === 0) {
      throw new Error(
        `No version found, probably mismatched architecture and OS (${osName}/${cpuArchitecture})`
      )
    }
    maxVersion = `~${rsort(keys(binPaths))[0]}`
    dbg({ maxVersion })
    return true
  }
  await check().catch(abort)

  tm.repeat(check, checkIntervalMs)

  const getLatestVersion = () => maxVersion

  const getVersion = async (semVer = maxVersion) => {
    const version = maxSatisfying(keys(binPaths), semVer)
    if (!version)
      throw new Error(
        `No version satisfies ${semVer} (${keys(binPaths).join(', ')})`
      )
    const binPath = binPaths[version]
    if (!binPath) throw new Error(`binPath for ${version} not found`)
    return {
      version,
      binPath,
    }
  }

  const _spawn = safeCatch(
    `spawnInstance`,
    _serviceLogger,
    async (cfg: SpawnConfig) => {
      const _cfg: Required<SpawnConfig> = {
        version: maxVersion,
        port: await getPort(),
        isMothership: false,
        onUnexpectedStop: (code) => {
          dbg(`Unexpected stop default handler. Exit code: ${code}`)
        },
        ...cfg,
      }
      const { version, command, slug, port, onUnexpectedStop, isMothership } =
        _cfg
      const _version = version || maxVersion // If _version is blank, we use the max version available
      const realVersion = await getVersion(_version)
      const bin = realVersion.binPath
      if (!existsSync(bin)) {
        throw new Error(
          `PocketBase binary (${bin}) not found. Contact pockethost.io.`
        )
      }

      const args = [
        command,
        `--dir`,
        `${DAEMON_PB_DATA_DIR}/${slug}/pb_data`,
        `--publicDir`,
        `${DAEMON_PB_DATA_DIR}/${slug}/pb_static`,
      ]
      if (gte(realVersion.version, `0.9.0`)) {
        args.push(`--migrationsDir`)
        args.push(
          isMothership
            ? DAEMON_PB_MIGRATIONS_DIR
            : `${DAEMON_PB_DATA_DIR}/${slug}/pb_migrations`
        )
      }
      if (command === 'serve') {
        args.push(`--http`)
        args.push(mkInternalAddress(port))
      }

      let isRunning = true

      dbg(`Spawning ${slug}`, { bin, args, cli: [bin, ...args].join(' ') })
      const ls = spawn(bin, args)
      cm.add(() => ls.kill())

      ls.stdout.on('data', (data) => {
        dbg(`${slug} stdout: ${data}`)
      })

      ls.stderr.on('data', (data) => {
        error(`${slug} stderr: ${data}`)
      })

      ls.on('close', (code) => {
        dbg(`${slug} closed with code ${code}`)
      })

      const exited = new Promise<number | null>((resolve) => {
        ls.on('exit', (code) => {
          dbg(`${slug} exited with code ${code}`)
          isRunning = false
          if (code) onUnexpectedStop?.(code)
          resolve(code)
        })
      })

      ls.on('error', (err) => {
        dbg(`${slug} had error ${err}`)
      })

      const url = mkInternalUrl(port)
      if (command === 'serve') {
        await tryFetch(_serviceLogger)(url, async () => isRunning)
      }
      const api: PocketbaseProcess = {
        url,
        exited,
        pid: ls.pid,
        kill: () => ls.kill(),
      }
      return api
    }
  )

  const shutdown = () => {
    dbg(`Shutting down pocketbaseService`)
    tm.shutdown()
    cm.shutdown()
  }

  return {
    spawn: _spawn,
    getVersion,
    getLatestVersion,
    shutdown,
  }
}

export const pocketbase = mkSingleton(createPocketbaseService)
