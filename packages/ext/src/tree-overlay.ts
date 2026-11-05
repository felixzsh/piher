/**
 * /piher-tree surface (RFC docs/rfc-core-app-migration.md §6): the delegation tree renders inside pi
 * as a capturing `ui.custom` overlay. The tree lines are recomputed on every render, so worker
 * updates only call `refresh()` (a requestRender) while it is open — no snapshot file, no polling.
 * Keys: ↑↓/j k scroll, esc / ctrl+c / q / enter close.
 */
import { truncateStyled, wrapStyled } from './ansi-text.ts';

type TreeKey = 'up' | 'down' | 'confirm' | 'cancel' | 'ignore';

/** The slice of pi's KeybindingsManager custom factories receive as 3rd arg. */
interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

/** Key resolution in order (first match wins). `binding` is the host action id consulted when the
 * factory received a keybindings manager; `sequences` are the raw fallbacks used when it did not
 * (older hosts, tests). Mirrors pi's select defaults, plus j/k for vim keys. */
const TREE_KEYS: ReadonlyArray<{ key: TreeKey; binding?: string; sequences: readonly string[] }> = [
  { key: 'up', binding: 'tui.select.up', sequences: ['\x1b[A', '\x1bOA', 'k'] },
  { key: 'down', binding: 'tui.select.down', sequences: ['\x1b[B', '\x1bOB', 'j'] },
  { key: 'confirm', binding: 'tui.select.confirm', sequences: ['\r', '\n'] },
  { key: 'cancel', binding: 'tui.select.cancel', sequences: ['\x1b', '\x03'] },
];

function resolveTreeKey(data: string, keybindings?: KeybindingsLike): TreeKey {
  for (const entry of TREE_KEYS) {
    if (entry.binding !== undefined && keybindings?.matches?.(data, entry.binding) === true) return entry.key;
    if (entry.sequences.includes(data)) return entry.key;
  }
  return 'ignore';
}

interface TreeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface TreeOverlayHandle {
  refresh(): void;
}

/** Rows the scrolling body may use: the terminal height minus borders, title and footer. */
function bodyRows(): number {
  return Math.max(3, (process.stdout.rows ?? 24) - 8);
}

export function treeOverlayLines(opts: {
  lines: readonly string[];
  width: number;
  rows: number;
  offset: number;
  theme: TreeTheme;
}): { lines: string[]; offset: number } {
  const width = Math.max(4, Math.floor(opts.width));
  const inner = width - 2;
  const body = opts.lines.flatMap((line) => wrapStyled(line, inner));
  const maxOffset = Math.max(0, body.length - opts.rows);
  const offset = Math.min(Math.max(0, opts.offset), maxOffset);
  const visible = body.slice(offset, offset + opts.rows).map((line) => ` ${line}`);
  const border = opts.theme.fg('border', '─'.repeat(width));
  const position = body.length > opts.rows ? ` ${offset + 1}-${offset + visible.length}/${body.length}` : '';
  const footer = opts.theme.fg('dim', ` ↑↓ scroll · esc close${position}`);
  return {
    offset,
    lines: [
      border,
      ` ${opts.theme.fg('accent', opts.theme.bold('Delegations'))}`,
      '',
      ...visible,
      '',
      truncateStyled(footer, width),
      border,
    ],
  };
}

/** Open the overlay; resolves when the person closes it. Null when the host has no `ui.custom`. */
export function openTreeOverlay(
  custom: ((factory: unknown, options?: unknown) => Promise<unknown>) | undefined,
  renderTree: () => string[],
  onOpen: (handle: TreeOverlayHandle) => void,
): Promise<void> | null {
  if (!custom) return null;
  const pending = custom(
    (tui: { requestRender?: () => void } | undefined, theme: TreeTheme, keybindings: KeybindingsLike | undefined, done: (v: unknown) => void) => {
      let offset = 0;
      onOpen({ refresh: () => tui?.requestRender?.() });
      return {
        render(width: number): string[] {
          const out = treeOverlayLines({ lines: renderTree(), width, rows: bodyRows(), offset, theme });
          offset = out.offset;
          return out.lines;
        },
        handleInput(data: string): void {
          const key = data === 'q' ? 'cancel' : resolveTreeKey(data, keybindings);
          if (key === 'up') offset -= 1;
          else if (key === 'down') offset += 1;
          else if (key === 'cancel' || key === 'confirm') {
            done(undefined);
            return;
          } else return;
          tui?.requestRender?.();
        },
        invalidate(): void { /* Lines are recomputed per render. */ },
      };
    },
    { overlay: true, overlayOptions: { width: '90%', maxHeight: '90%', anchor: 'center' } },
  );
  return Promise.resolve(pending).then(() => undefined, () => undefined);
}
