import {
  Mention as TipTapMention,
  type MentionOptions as TipTapMentionOptions,
} from "@tiptap/extension-mention";
import type { SuggestionOptions } from "@tiptap/suggestion";

export interface MentionEntity {
  id: string;
  label: string;
  type?: string;
  avatarUrl?: string;
  color?: string;
  handle?: string;
  name?: string;
  hexColor?: string;
  aliases?: string[];
  [key: string]: any;
}

export interface MentionOptions extends Partial<TipTapMentionOptions> {
  HTMLAttributes?: Record<string, any>;
  suggestion?: Partial<SuggestionOptions<MentionEntity>>;
}

const BaseMention =
  TipTapMention ||
  (TipTapMention as any)?.default?.default ||
  (TipTapMention as any)?.default ||
  (TipTapMention as any);

/**
 * First-class native Mention extension for @pixerate/editor.
 * Creates atomic inline <span data-type="mention"> nodes with full suggestion support.
 */
export const Mention = BaseMention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      type: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-type-name") ||
          element.getAttribute("data-entity-type"),
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.type) return {};
          return { "data-type-name": attributes.type };
        },
      },
      avatarUrl: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-avatar-url"),
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.avatarUrl) return {};
          return { "data-avatar-url": attributes.avatarUrl };
        },
      },
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-color"),
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.color) return {};
          return { "data-color": attributes.color };
        },
      },
      // Role of an asset mention (`reference`, `style`, `start_frame`, …). The
      // node attribute is `assetRole` so entities that already carry a `role`
      // (e.g. a user's job title) passed as suggestion props do not set it.
      assetRole: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const role = element.getAttribute("data-role");
          return role && MENTION_ROLE_PATTERN.test(role) ? role : null;
        },
        renderHTML: (attributes: Record<string, any>) => {
          if (!attributes.assetRole) return {};
          return { "data-role": attributes.assetRole };
        },
      },
    };
  },
});

const MENTION_ROLE_PATTERN = /^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

/** Mention nodes in a document, with their positions (for role pickers). */
export interface MentionNodeInfo {
  pos: number;
  id: string;
  label: string;
  type?: string;
  role?: string;
}

/** Every mention node of an editor's document, in document order. */
export function getMentionNodes(editor: { state: { doc: any } }): MentionNodeInfo[] {
  const result: MentionNodeInfo[] = [];
  editor.state.doc.descendants((node: any, pos: number) => {
    if (node.type?.name !== "mention") return;
    result.push({
      pos,
      id: node.attrs.id ?? "",
      label: node.attrs.label ?? "",
      ...(node.attrs.type ? { type: node.attrs.type } : {}),
      ...(node.attrs.assetRole ? { role: node.attrs.assetRole } : {}),
    });
  });
  return result;
}

/**
 * Sets (or with `null` clears) the role of the mention node at `pos`, as one
 * undoable step. Returns `false` when there is no mention at `pos` or the role
 * name is invalid.
 */
export function setMentionRoleAt(editor: any, pos: number, role: string | null): boolean {
  const node = editor?.state?.doc?.nodeAt(pos);
  if (!node || node.type.name !== "mention") return false;
  if (role !== null && !MENTION_ROLE_PATTERN.test(role)) return false;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, assetRole: role });
  editor.view.dispatch(tr);
  return true;
}

/**
 * Helper to configure the Mention extension with preset defaults.
 */
export function createMentionExtension(options: Partial<MentionOptions> = {}) {
  const { HTMLAttributes = {}, ...rest } = options;
  return Mention.configure({
    HTMLAttributes: {
      class: "pixerate-mention-node",
      ...HTMLAttributes,
    },
    ...rest,
  });
}
