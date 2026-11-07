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
  /** A data dir from the environment, if this platform has one pi should follow. */
  readonly envVar: string | null
  readonly homeFallback: readonly string[]
}> = {
  win32: { envVar: 'LOCALAPPDATA', homeFallback: ['AppData', 'Local'] },
  // pi keeps its agent dir at `~/.pi/agent` and does not follow XDG. Deriving it from XDG_DATA_HOME
  // pointed at ~/.local/share/agent/sessions, which never exists, so every resolution by session id
  // silently found nothing (PI_CODING_AGENT_DIR, when set, is handled by the callers).
  linux: { envVar: null, homeFallback: ['.pi'] },
  darwin: { envVar: 'XDG_DATA_HOME', homeFallback: ['.pi'] },
}

export function createPlatformPaths(overrides?: Partial<PlatformPaths>): PlatformPaths {
  const layout = PLATFORM_DEFAULTS[process.platform] ?? PLATFORM_DEFAULTS.darwin!
  const dataDir = (layout.envVar ? process.env[layout.envVar] : undefined) || join(homedir(), ...layout.homeFallback)
  const agentDataDir = overrides?.agentDataDir || join(dataDir, 'agent')

  return {
    agentDataDir,
    sessionsDir: overrides?.sessionsDir || join(agentDataDir, 'sessions'),
  }
}

/** Singleton for production; tests inject via createPlatformPaths(). */
export const platformPaths = createPlatformPaths()
