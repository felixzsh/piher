/** Master-process plugin mount (cordis loader + terminal/subagent), dynamically imported from
 *  the master branch of index.ts only: a worker must never load bootstrap/subagent-poller (C3). */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { Server } from 'node:net';
import { PiSurface } from './pi-surface.ts';
import { createCordisApp } from './bootstrap.ts';
import { cordisProvide } from './cordis-services.ts';
import { disposeSessionRoot } from './subagent-poller.ts';
import terminalPlugin from './plugins/terminal.ts';
import subagentPlugin from './plugins/subagent.ts';
import type { CoreClientLike, CoreEnv } from './core-client.ts';
import type { SubagentPortBox } from './subagent-core.ts';
import type { SettlementCard } from './settlement-card.ts';

export interface MasterPluginMount {
  pi: ExtensionAPI;
  client: CoreClientLike;
  env: CoreEnv | null;
  extPath: string;
  port: SubagentPortBox;
  pipeServerBox: { current: Server | null };
  deliverNotice: (content: string, paneId?: string, card?: SettlementCard | null) => Promise<void>;
  noticePending: () => ReadonlySet<string>;
  getSessionId: () => string;
  claimSettleNotice: (key: string) => boolean;
}

async function loadEntry(
  sessionRoot: Context,
  useLoader: boolean,
  name: string,
  plugin: (ctx: Context) => void,
): Promise<void> {
  if (useLoader) {
    const withLoader = sessionRoot as typeof sessionRoot & {
      loader?: { create: (o: { name: string }) => Promise<unknown> };
    };
    await withLoader.loader?.create({ name });
    return;
  }
  await sessionRoot.plugin(plugin);
}

export async function mountMasterPlugins(m: MasterPluginMount): Promise<void> {
  const cordisApp = await createCordisApp();
  const sessionRoot = cordisApp.root;
  // loader.create re-imports .ts via Node ESM — fails under node_modules (npm:piher
  // strip-types) and misses pi's typebox alias. HMR-only; production uses plugin().
  const useLoader = cordisApp.loaderReady && cordisApp.hmrActive;

  // Pipe server is created in the common segment; closing it from a core plugin would kill it on hmr reload (d87).
  sessionRoot.effect(() => () => {
    if (m.pipeServerBox.current) {
      try { m.pipeServerBox.current.close(); } catch { /* already closed */ }
      m.pipeServerBox.current = null;
    }
  }, 'pipe-server');

  const surface = new PiSurface(m.pi as unknown as object, cordisApp.ledger);
  cordisProvide(sessionRoot, 'piher.surface', surface);
  const terminalDeps = {
    client: m.client,
    env: m.env,
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  cordisProvide(sessionRoot, 'piher.terminal-deps', terminalDeps);

  await loadEntry(sessionRoot, useLoader, './plugins/terminal.ts', terminalPlugin);

  // Dropped keys fail here: cordisProvide checks the bag against PiherCordisServices (fe99252).
  cordisProvide(sessionRoot, 'piher.subagent-deps', {
    client: m.client,
    env: m.env,
    extPath: m.extPath,
    sessionRoot,
    port: m.port,
    deliverNotice: m.deliverNotice,
    noticePending: m.noticePending,
    getSessionId: m.getSessionId,
    claimSettleNotice: m.claimSettleNotice,
    terminalState: terminalDeps.state,
  });
  await loadEntry(sessionRoot, useLoader, './plugins/subagent.ts', subagentPlugin);

  m.pi.on('session_shutdown', () => {
    void disposeSessionRoot(sessionRoot);
  });
}
