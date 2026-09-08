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
    };
  },
});

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
