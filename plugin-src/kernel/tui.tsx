// kernel: TUI plugin (plugin id "kernel.tui").
//
// Registers the `kernel` session panel and the `kernel.panel` command
// (/kernel). The panel reads the session journal through the `cells` RPC and
// follows the `cell` / `reset` events; it never opens the journal file.
//
// setup() runs outside the host's Solid component tree, so the global command
// is registered from an always-mounted `app` slot's onMount - the local
// pattern, because keymap.layer() throws outside a component. Removing the
// app slot disposes that computation, which also removes the keymap layer.
//
// The host's documented `generateSyntax` helper is not exposed to plugins by
// the installed 2.3.2 CLI, so lib/syntax.js reproduces that mapping from
// context.theme.syntax. The owner argument is passed to SyntaxStyle.fromStyles
// when the renderer exposes it (OpenTUI 0.6+ requires it; 0.5 ignores it).
//
// All files ASCII only.

import { SyntaxStyle } from "@opentui/core";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { cellLabel, mergeCell, outputParts } from "./lib/panel.js";
import { Kernel } from "./rpc.js";
import { syntaxStyles } from "./lib/syntax.js";

// Journal shapes, mirrored from lib/journal.js and host.py. lib/panel.js is
// plain JS, so the panel annotates the helper results with these types.
type KernelMeta = {
  kernelspec?: { display_name?: string; name?: string } | null;
  language_info?: { name?: string } | null;
  selection?: string;
  cells?: number;
  truncated?: boolean;
} | null;

type PanelCell = {
  v?: number;
  type?: "cell" | "boundary";
  execution_count?: number;
  source?: string;
  outputs?: unknown[];
  truncated?: boolean;
  text?: string;
};

type OutputPart =
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "markdown"; text: string }
  | { kind: "image"; mime: string; dataUri: string }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] }
  | { kind: "boundary"; text: string };

type CellsResult = { meta: KernelMeta; cells: PanelCell[] };

type KernelTheme = {
  text?: {
    base?: string;
    feedback?: {
      error?: { base?: string };
      warning?: { base?: string };
    };
  };
  markdown?: { link?: string };
  syntax?: {
    comment?: string;
    string?: string;
    number?: string;
    keyword?: string;
    type?: string;
    function?: string;
    operator?: string;
    variable?: string;
    punctuation?: string;
  };
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCellRecord(value: unknown): value is PanelCell {
  if (value === null || typeof value !== "object") return false;
  const record = value as PanelCell;
  return record.type === "cell" && typeof record.source === "string";
}

function createSyntaxStyle(context: {
  theme: KernelTheme;
  renderer?: { nativeScene?: unknown };
}): SyntaxStyle {
  const fromStyles = SyntaxStyle.fromStyles.bind(SyntaxStyle) as unknown as (
    definitions: Record<
      string,
      { fg?: string; bold?: boolean; italic?: boolean; underline?: boolean }
    >,
    owner?: unknown,
  ) => SyntaxStyle;
  return fromStyles(syntaxStyles(context.theme), context.renderer?.nativeScene);
}

export default Plugin.define({
  id: "kernel.tui",
  setup(context) {
    const rpc = context.client.rpc(Kernel);
    const style = createSyntaxStyle(context);
    const disposers: Array<() => void> = [];
    let keymapRegistered = false;

    function rpcOptions(): { headers: { "x-opencode-directory": string } } | undefined {
      const directory = context.location?.directory;
      if (typeof directory === "string" && directory !== "") {
        return { headers: { "x-opencode-directory": encodeURIComponent(directory) } };
      }
      return undefined;
    }

    function registerKeymapLayer(): void {
      if (keymapRegistered) return;
      try {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "kernel.panel",
              title: "Kernel cells",
              description: "Show this session's kernel cells",
              group: "Kernel",
              palette: true,
              slash: { name: "kernel" },
              enabled: () => context.ui.router.current().type === "session",
              run: () => {
                context.ui.panel.open("kernel");
              },
            },
          ],
        }));
        keymapRegistered = true;
      } catch (err) {
        console.warn(`[kernel] keymap layer unavailable: ${errorText(err)}`);
      }
    }

    function KernelPanel(props: { sessionID: string; width: number }) {
      const [cells, setCells] = createSignal<PanelCell[]>([]);
      const [meta, setMeta] = createSignal<KernelMeta>(null);
      const [error, setError] = createSignal("");
      const [loading, setLoading] = createSignal(true);

      // Live events that arrive while a snapshot is in flight wait here, then
      // merge on top of it. The tail dedupe in mergeCell also covers a record
      // the snapshot already contained.
      let fetching = false;
      let refetch = false;
      let disposed = false;
      let queue: PanelCell[] = [];

      const muted = () => context.theme.text.muted;
      const errorColor = () => context.theme.text.feedback?.error?.base ?? context.theme.text.base;

      const language = () => {
        const name = meta()?.language_info?.name;
        return typeof name === "string" && name !== "" ? name : "python";
      };

      const header = () => {
        const m = meta();
        const selection =
          m && typeof m.selection === "string" && m.selection !== "" ? m.selection : "default";
        const visible = cells().filter((cell) => cell.type !== "boundary").length;
        const total = m && typeof m.cells === "number" ? m.cells : visible;
        const truncated = m && m.truncated === true ? " (truncated)" : "";
        return `Kernel - ${selection} - ${language()} - ${total} cell${
          total === 1 ? "" : "s"
        }${truncated}`;
      };

      const cap = () => {
        const rows = context.renderer?.terminalHeight ?? 40;
        return Math.max(6, Math.floor(rows * 0.75));
      };

      async function fetchSnapshot(): Promise<void> {
        if (fetching) {
          refetch = true;
          return;
        }
        fetching = true;
        setLoading(true);
        try {
          const result = (await rpc.cells(
            { sessionID: props.sessionID, limit: 200 },
            rpcOptions(),
          )) as CellsResult;
          if (disposed) return;
          let next = Array.isArray(result?.cells) ? result.cells : [];
          for (const record of queue) next = mergeCell(next, record) as PanelCell[];
          queue = [];
          setMeta(result?.meta ?? null);
          setCells(next);
          setError("");
        } catch (err) {
          if (disposed) return;
          setError(errorText(err));
        } finally {
          fetching = false;
          if (!disposed) setLoading(false);
          if (refetch && !disposed) {
            refetch = false;
            void fetchSnapshot();
          }
        }
      }

      function applyCell(record: PanelCell): void {
        if (fetching) {
          queue.push(record);
          return;
        }
        setCells((previous) => mergeCell(previous, record) as PanelCell[]);
      }

      function subscribe(name: "cell" | "reset", handler: (data: unknown) => void): () => void {
        try {
          const off = rpc.events.on(name, (event: { data?: unknown }) => handler(event?.data));
          return typeof off === "function" ? off : () => {};
        } catch (err) {
          console.warn(`[kernel] could not subscribe to ${name}: ${errorText(err)}`);
          return () => {};
        }
      }

      onMount(() => {
        if (props.sessionID === "") {
          setError("no session selected");
          setLoading(false);
          return;
        }
        const offCell = subscribe("cell", (data) => {
          if (isCellRecord(data)) applyCell(data);
        });
        // A reset writes its boundary before the next cell, so refetching the
        // journal snapshot is what makes the divider and history appear.
        const offReset = subscribe("reset", () => {
          void fetchSnapshot();
        });
        onCleanup(() => {
          offCell();
          offReset();
        });
        void fetchSnapshot();
      });

      onCleanup(() => {
        disposed = true;
      });

      function renderPart(part: OutputPart) {
        switch (part.kind) {
          case "text":
            return (
              <text fg={part.muted === true ? muted() : context.theme.text.base} wrapMode="word">
                {part.text}
              </text>
            );
          case "markdown":
            return <markdown content={part.text} syntaxStyle={style} />;
          case "image":
            return <image source={part.dataUri} fit="fit" />;
          case "error": {
            const head = part.evalue === "" ? part.ename : `${part.ename}: ${part.evalue}`;
            const lines = [head, ...part.traceback].filter((line) => line.trim() !== "");
            return (
              <text fg={errorColor()} wrapMode="word">
                {lines.join("\n")}
              </text>
            );
          }
          case "boundary":
            return <text fg={muted()}>{`--- ${part.text} ---`}</text>;
          default:
            return null;
        }
      }

      return (
        <box flexDirection="column" flexGrow={1} width={props.width}>
          <text fg={context.theme.text.base} wrapMode="none" truncate>
            {header()}
          </text>
          <Show when={error() !== ""}>
            <text fg={errorColor()} wrapMode="word">
              {`Kernel panel error: ${error()}`}
            </text>
            <text fg={muted()} wrapMode="word">
              Close the panel and run /kernel again to retry.
            </text>
          </Show>
          <Show when={loading() && error() === "" && cells().length === 0}>
            <text fg={muted()}>Loading cells...</text>
          </Show>
          <Show when={!loading() && error() === "" && cells().length === 0}>
            <text fg={muted()}>No cells yet. Run a cell with the kernel tool.</text>
          </Show>
          <scrollbox
            flexGrow={1}
            maxHeight={cap()}
            scrollY
            scrollX={false}
            focusable={false}
            scrollbarOptions={{ visible: false }}
          >
            <For each={cells()}>
              {(cell, index) => (
                <Show
                  when={cell.type === "boundary"}
                  fallback={
                    <box flexDirection="column">
                      <text fg={context.theme.text.base} wrapMode="none" truncate>
                        {cellLabel(cell, index())}
                      </text>
                      <code
                        filetype={language()}
                        syntaxStyle={style}
                        content={typeof cell.source === "string" ? cell.source : ""}
                      />
                      <For each={outputParts(cell) as OutputPart[]}>
                        {(part) => renderPart(part)}
                      </For>
                    </box>
                  }
                >
                  <text fg={muted()}>{cellLabel(cell, index())}</text>
                </Show>
              )}
            </For>
          </scrollbox>
        </box>
      );
    }

    try {
      disposers.push(
        context.ui.slot({
          append: "session.panel",
          render: (panel) => (
            <Show when={panel.name === "kernel"}>
              <KernelPanel sessionID={panel.sessionID} width={panel.width} />
            </Show>
          ),
        }),
      );
    } catch (err) {
      console.warn(`[kernel] session panel unavailable: ${errorText(err)}`);
    }

    try {
      disposers.push(
        context.ui.slot({
          append: "app",
          render: () => {
            onMount(() => registerKeymapLayer());
            return null;
          },
        }),
      );
    } catch (err) {
      console.warn(`[kernel] command registration unavailable: ${errorText(err)}`);
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (err) {
          console.warn(`[kernel] cleanup failed: ${errorText(err)}`);
        }
      }
      try {
        void context.renderer
          .idle()
          .then(() => {
            try {
              style.destroy();
            } catch (err) {
              console.warn(`[kernel] syntax style cleanup failed: ${errorText(err)}`);
            }
          })
          .catch((err) => {
            console.warn(`[kernel] renderer idle failed: ${errorText(err)}`);
          });
      } catch (err) {
        console.warn(`[kernel] renderer idle unavailable: ${errorText(err)}`);
      }
    };
  },
});
