import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows uses LOCALAPPDATA, Linux XDG, macOS keeps `~/.pi` (with XDG override). Injectable for tests.
 */
export interface PlatformPaths {
  readonly agentDataDir: string
  readonly sessionsDir: string
}

const PLATFORM_DEFAULTS: Record<string, {
  readonly envVar: string
  readonly homeFallback: readonly string[]
}> = {
  win32: { envVar: 'LOCALAPPDATA', homeFallback: ['AppData', 'Local'] },
  linux: { envVar: 'XDG_DATA_HOME', homeFallback: ['.local', 'share'] },
  darwin: { envVar: 'XDG_DATA_HOME', homeFallback: ['.pi'] },
}

export function createPlatformPaths(overrides?: Partial<PlatformPaths>): PlatformPaths {
  const layout = PLATFORM_DEFAULTS[process.platform] ?? PLATFORM_DEFAULTS.darwin!
  const dataDir = process.env[layout.envVar] || join(homedir(), ...layout.homeFallback)
  const agentDataDir = overrides?.agentDataDir || join(dataDir, 'agent')

  return {
    agentDataDir,
    sessionsDir: overrides?.sessionsDir || join(agentDataDir, 'sessions'),
  }
}

/** Singleton for production; tests inject via createPlatformPaths(). */
export const platformPaths = createPlatformPaths()
