import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  Autocorrect,
  SmilieReplacer,
  SMILIE_REPLACEMENTS,
  smilieAutocorrectRules,
  defaultAutocorrectRules,
  findAutocorrection,
  isInsidePromptToken,
  createRichTextPreset,
  type AutocorrectOptions,
  type AutocorrectRule,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
});

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

function createEditor(
  content = "<p></p>",
  autocorrect: Partial<AutocorrectOptions> | boolean = true,
) {
  const editor = new Editor({
    extensions: createRichTextPreset({ autocorrect, enableSmilies: false }),
    content,
  });
  editors.push(editor);
  // Caret at the end of the first text block.
  const end = editor.state.doc.firstChild!.nodeSize - 1;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)),
  );
  return editor;
}

/** Types text one character at a time, the way ProseMirror handles keyboard input. */
function type(editor: Editor, text: string) {
  const { view } = editor;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, char));
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

const text = (editor: Editor) => editor.state.doc.textContent;

describe("Autocorrect rules", () => {
  it.each([
    ['"Hello," she said ', "“Hello,” she said "],
    ["it's 'quoted' ", "It’s ‘quoted’ "],
    ["wait--what ", "Wait—what "],
    ["and so... ", "And so… "],
    ["a -> b <- c ", "A → b ← c "],
    ["(c) (r) (tm) ", "© ® ™ "],
    ["add 1/2 cup and 3/4 tsp, not 11/2 ", "Add ½ cup and ¾ tsp, not 11/2 "],
    ["first. second? third! fourth ", "First. Second? Third! Fourth "],
    ["THe CAt sat ", "The Cat sat "],
  ])("corrects %j", (input, expected) => {
    const editor = createEditor();
    type(editor, input);
    expect(text(editor)).toBe(expected);
  });

  it("does not end sentences after abbreviations in the exceptions list", () => {
    const editor = createEditor();
    type(editor, "See e.g. this, i.e. that, and Dr. smith or J. doe ");
    expect(text(editor)).toBe("See e.g. this, i.e. that, and Dr. smith or J. doe ");
  });

  it("leaves two-capital exceptions and URLs alone", () => {
    const editor = createEditor();
    type(editor, "Our IDs at http://example.com/a--b ");
    expect(text(editor)).toBe("Our IDs at http://example.com/a--b ");
  });

  it("supports exceptions added at runtime and custom whole-word rules", () => {
    const rules: AutocorrectRule[] = [
      { id: "typo:teh", find: "teh", replace: "the", wholeWord: true },
      ...defaultAutocorrectRules,
    ];
    const editor = createEditor("<p>Start</p>", { rules });
    type(editor, " teh end, (c)");
    expect(text(editor)).toBe("Start the end, ©");
    editor.commands.addAutocorrectException("(c)");
    type(editor, " (c) tehx ");
    expect(text(editor)).toBe("Start the end, © (c) tehx ");
    expect(editor.commands.removeAutocorrectException("(c)")).toBe(true);
    type(editor, "(c)");
    expect(text(editor)).toBe("Start the end, © (c) tehx ©");
  });

  it("can be disabled at runtime", () => {
    const editor = createEditor();
    editor.commands.setAutocorrectEnabled(false);
    type(editor, "a--b ");
    expect(text(editor)).toBe("a--b ");
  });

  it("reports corrections", () => {
    const onCorrection = vi.fn();
    const editor = createEditor("<p></p>", { onCorrection });
    type(editor, "x(c)");
    expect(onCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "symbols:copyright", original: "(c)", replacement: "©" }),
    );
  });
});

describe("Autocorrect undo", () => {
  it("undo right after a correction reverts only the correction", () => {
    const editor = createEditor();
    type(editor, "Hi--");
    expect(text(editor)).toBe("Hi—");
    editor.commands.undo();
    expect(text(editor)).toBe("Hi--");
    editor.commands.undo();
    expect(text(editor)).toBe("");
  });

  it("typing after a correction starts a new undo step", () => {
    const editor = createEditor();
    type(editor, "Hi--there");
    expect(text(editor)).toBe("Hi—there");
    editor.commands.undo();
    expect(text(editor)).toBe("Hi—");
    editor.commands.undo();
    expect(text(editor)).toBe("Hi--");
  });

  it("undoAutocorrect reverts the last correction only while it is the latest change", () => {
    const editor = createEditor();
    type(editor, "Hi (c)");
    expect(editor.commands.undoAutocorrect()).toBe(true);
    expect(text(editor)).toBe("Hi (c)");
    expect(editor.commands.undoAutocorrect()).toBe(false);
    type(editor, " (r)x");
    expect(editor.commands.undoAutocorrect()).toBe(false);
  });
});

describe("Autocorrect scope", () => {
  it("does not fire inside code blocks or inline code", () => {
    const editor = createEditor("<pre><code>a</code></pre>");
    type(editor, '--"x" ');
    expect(text(editor)).toBe('a--"x" ');

    const inline = createEditor("<p><code>a</code></p>");
    type(inline, "--(c)");
    expect(text(inline)).toBe("a--(c)");
  });

  it("does not fire inside prompt tokens", () => {
    const editor = createEditor("<p>Use</p>");
    type(editor, " {{style--x}} ok-- {name--y} __be--bold");
    expect(text(editor)).toBe("Use {{style--x}} ok— {name--y} __be--bold");
    expect(isInsidePromptToken("a {{b")).toBe(true);
    expect(isInsidePromptToken("a {b} c")).toBe(false);
    expect(isInsidePromptToken("__a")).toBe(true);
    expect(isInsidePromptToken("__a__ b")).toBe(false);
  });

  it("can opt in to correcting inside prompt tokens", () => {
    const editor = createEditor("<p></p>", { ignorePromptTokens: false });
    type(editor, "{a--");
    expect(text(editor)).toBe("{a—");
  });
});

describe("findAutocorrection", () => {
  const ctx = { state: {} as any, isException: () => false };

  it("returns the first matching rule and the replaced range", () => {
    expect(findAutocorrection("x --", defaultAutocorrectRules, ctx)).toEqual({
      ruleId: "symbols:em-dash",
      start: 2,
      original: "--",
      replacement: "—",
    });
    expect(findAutocorrection("plain", defaultAutocorrectRules, ctx)).toBeNull();
  });

  it("inserts string replacements literally", () => {
    const rules: AutocorrectRule[] = [{ id: "dollar", find: /\$\$$/, replace: "$&" }];
    expect(findAutocorrection("a$$", rules, ctx)?.replacement).toBe("$&");
  });
});

describe("Smilies", () => {
  it("keeps SmilieReplacer working on its own", () => {
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p></p>" });
    editors.push(editor);
    expect(editor.extensionManager.extensions.some((e) => e.name === "smilieReplacer")).toBe(true);
    expect(SmilieReplacer.name).toBe("smilieReplacer");
    type(editor, "hi :) ");
    expect(text(editor)).toBe("hi 🙂 ");
  });

  it("exposes the smilies as autocorrect rules that tolerate curly quotes", () => {
    expect(smilieAutocorrectRules).toHaveLength(SMILIE_REPLACEMENTS.length);
    const editor = createEditor("<p></p>", {
      rules: [...smilieAutocorrectRules, ...defaultAutocorrectRules],
    });
    type(editor, "Ok :) and :'( ");
    expect(text(editor)).toBe("Ok 🙂 and 😢 ");
  });
});

describe("Preset integration", () => {
  it("replaces Typography when autocorrect is enabled", () => {
    const names = createRichTextPreset({ autocorrect: true }).map((e: any) => e.name);
    expect(names).toContain("autocorrect");
    expect(names).not.toContain("typography");
    expect(Autocorrect.name).toBe("autocorrect");
  });
});
