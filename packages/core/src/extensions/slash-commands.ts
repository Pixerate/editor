import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export interface SlashCommandMatchData {
  match: RegExpMatchArray;
  query: string;
  from: number;
  to: number;
  coords: { top: number; left: number; bottom: number; right: number };
}

export interface SlashCommandsOptions {
  trigger?: string;
  onMatch?: (data: SlashCommandMatchData) => void;
  onClear?: () => void;
  containerId?: string;
}

export const SlashCommands = Extension.create<SlashCommandsOptions>({
  name: "slashCommands",

  addOptions() {
    return {
      trigger: "/",
      onMatch: undefined,
      onClear: undefined,
      containerId: undefined,
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;

    return [
      new Plugin({
        view() {
          return {
            update(view) {
              const { state } = view;
              const { selection } = state;
              const { $from } = selection;

              if (!$from.parent.isTextblock) {
                opts.onClear?.();
                return;
              }

              const textBeforeCursor = $from.parent.textBetween(
                0,
                $from.parentOffset,
              );

              const slashMatch = textBeforeCursor.match(
                /(?:^|\s)\/([a-zA-Z0-9_-]*)$/,
              );

              if (slashMatch) {
                const matchIndex = slashMatch.index ?? 0;
                const offsetInParent =
                  matchIndex + (slashMatch[0].startsWith(" ") ? 1 : 0);
                const matchFrom = $from.start() + offsetInParent;
                const matchTo = $from.pos;
                const coords = view.coordsAtPos($from.pos);

                let relativeCoords = {
                  top: coords.top,
                  left: coords.left,
                  bottom: coords.bottom,
                  right: coords.right,
                };

                if (opts.containerId && typeof document !== "undefined") {
                  const container = document.getElementById(opts.containerId);
                  if (container) {
                    const rect = container.getBoundingClientRect();
                    relativeCoords = {
                      top: coords.bottom - rect.top + 5,
                      left: coords.left - rect.left,
                      bottom: coords.bottom - rect.top,
                      right: coords.right - rect.left,
                    };
                  }
                }

                opts.onMatch?.({
                  match: slashMatch,
                  query: slashMatch[1] || "",
                  from: matchFrom,
                  to: matchTo,
                  coords: relativeCoords,
                });
              } else {
                opts.onClear?.();
              }
            },
          };
        },
      }),
    ];
  },
});
