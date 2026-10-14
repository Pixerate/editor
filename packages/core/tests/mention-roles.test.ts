// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createMentionExtension, getMentionNodes, setMentionRoleAt } from "../src/extensions";
import { growthRatio, measureGrowth } from "./helpers/growth";
import {
  extractMentions,
  extractMentionsFromDoc,
  findTextMentions,
  formatMentionText,
  htmlToPlainText,
  parseMentionSegments,
  preprocessMarkdownMentions,
  setMentionRoleInText,
  markdownToTipTapHtml,
} from "../src/serializers";

/** Deterministic PRNG for randomized tests. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}
const pick = <T,>(r: () => number, list: readonly T[]) => list[Math.floor(r() * list.length)];

const HANDLES = ["fox", "monet", "red_fox", "sa-1", "team.alpha", "x"];
const ROLES = ["style", "character", "start-frame", "end_frame", "subject", "mask"];
const FILLER = [" ", "a ", ". ", ", ", "\n", "(", ")", ": ", "`code` ", "**", "hello ", "e-mail@x.com "];

function randomText(r: () => number, withRoles: boolean) {
  let text = "";
  const n = 1 + Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    text += pick(r, FILLER);
    if (r() < 0.6) {
      text += ` @${pick(r, HANDLES)}`;
      if (withRoles && r() < 0.6) text += `:${pick(r, ROLES)}`;
      text += " ";
    }
  }
  return text;
}

describe("asset mention roles in text", () => {
  it("does not read roles unless asked", () => {
    expect(extractMentions("use @fox:style here")).toEqual(["fox"]);
    expect(extractMentions("use @fox:style here", { details: true })).toEqual([{ handle: "fox" }]);
    expect(parseMentionSegments("@fox:style")).toEqual([
      { type: "mention", value: "@fox", handle: "fox" },
      { type: "text", value: ":style" },
    ]);
  });

  it("reads `@handle:role` with roles enabled", () => {
    const text = 'Use @fox:style and @"Old Monet":character, @fox:subject, @x: nothing, @y:style. done';
    expect(extractMentions(text, { details: true, roles: true })).toEqual([
      { handle: "fox", role: "style" },
      { handle: "Old Monet", role: "character" },
      { handle: "fox", role: "subject" },
      { handle: "x" },
      { handle: "y", role: "style" },
    ]);
    // Only listed roles, returned as listed.
    expect(extractMentions("@a:STYLE @b:pose", { details: true, roles: ["Style"] })).toEqual([
      { handle: "a", role: "Style" },
      { handle: "b" },
    ]);
    // Handles are unaffected in the plain-string form.
    expect(extractMentions(text, { roles: true })).toEqual(["fox", "Old Monet", "x", "y"]);
    expect(parseMentionSegments("hi @fox:start-frame!", { roles: true })).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", value: "@fox:start-frame", handle: "fox", role: "start-frame" },
      { type: "text", value: "!" },
    ]);
  });

  it("does not take a trailing separator as part of the role", () => {
    expect(findTextMentions("@fox:style- and @fox:style_")).toMatchObject([
      { handle: "fox", role: "style" },
      { handle: "fox" },
    ]);
  });

  it("finds mentions with offsets and edits their roles", () => {
    const text = "a @fox and @monet:style.";
    const mentions = findTextMentions(text);
    expect(mentions).toEqual([
      { handle: "fox", start: 2, end: 6, handleEnd: 6 },
      { handle: "monet", role: "style", start: 11, end: 23, handleEnd: 17 },
    ]);
    const added = setMentionRoleInText(text, 2, "character");
    expect(added).toBe("a @fox:character and @monet:style.");
    const replaced = setMentionRoleInText(added, 21, "subject");
    expect(replaced).toBe("a @fox:character and @monet:subject.");
    expect(setMentionRoleInText(replaced, 21, null)).toBe("a @fox:character and @monet.");
    expect(setMentionRoleInText(text, 0, "x")).toBe(text);
    expect(() => setMentionRoleInText(text, 2, "bad role")).toThrow(/Invalid/);
    expect(formatMentionText("Old Monet", "style")).toBe('@"Old Monet":style');
    expect(formatMentionText("fox")).toBe("@fox");
  });

  it("emits data-role from preprocessing only when role syntax is on", () => {
    const off = preprocessMarkdownMentions("see @fox:style");
    expect(off).not.toContain("data-role");
    expect(off.endsWith(">@fox</span>:style")).toBe(true);
    const on = preprocessMarkdownMentions("see @fox:style, `@fox:mask`", { roles: true });
    expect(on).toBe(
      'see <span class="pixerate-mention-node" data-type="mention" data-id="fox" data-label="fox" data-mention-suggestion-char="@" data-type-name="user" data-role="style">@fox</span>, `@fox:mask`',
    );
    expect(markdownToTipTapHtml("@fox:style", { preprocessOptions: { roles: true } })).toContain('data-role="style"');
  });

  it("round-trips roles text → HTML → text, and is unchanged without them (randomized)", () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const plain = randomText(r, false);
      // Without role syntax, nothing changes whether or not the option is on.
      expect(preprocessMarkdownMentions(plain, { roles: true })).toBe(preprocessMarkdownMentions(plain));
      expect(extractMentions(plain, { details: true, roles: true }).map((m) => m.handle)).toEqual(extractMentions(plain));

      const withRoles = randomText(r, true);
      const html = preprocessMarkdownMentions(withRoles, { roles: true });
      const back = htmlToPlainText(`<p>${html}</p>`);
      // The `@handle:role` text survives the trip; other text is untouched.
      expect(back).toBe(htmlToPlainText(`<p>${preprocessMarkdownMentions(back, { roles: true })}</p>`));
      const fromText = extractMentions(withRoles, { details: true, roles: true });
      const fromHtml = extractMentions(html, { details: true });
      expect(fromHtml).toEqual(fromText);
      expect(extractMentionsFromDoc(html).map((m) => m.role)).toEqual(
        findTextMentions(withRoles)
          .filter((m) => html.includes(`data-label="${m.handle}"`))
          .map((m) => m.role),
      );
    }
  });

  it("reads data-role from mention nodes in HTML and documents", () => {
    const html =
      '<p><span data-type="mention" data-id="a1" data-label="fox" data-role="style">@fox</span> <span data-type="mention" data-id="u" data-label="jack">@jack</span></p>';
    expect(extractMentions(html)).toEqual(["fox", "jack"]);
    expect(extractMentions(html, { details: true })).toEqual([{ handle: "fox", role: "style" }, { handle: "jack" }]);
    expect(extractMentionsFromDoc(html).map((m) => m.role)).toEqual(["style", undefined]);
    expect(htmlToPlainText(html)).toBe("@fox:style @jack");
    expect(htmlToPlainText(html.replace("style", "bad role"))).toBe("@fox @jack");
  });
});

describe("Mention extension role attribute", () => {
  const make = (content: any) => new Editor({ extensions: [StarterKit, createMentionExtension()], content });

  it("renders mentions without a role exactly as before", () => {
    const editor = make({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "u1", label: "jack", type: "user" } }] }],
    });
    expect(editor.getHTML()).toBe(
      '<p><span class="pixerate-mention-node" data-type="mention" data-id="u1" data-label="jack" data-mention-suggestion-char="@" data-type-name="user">@jack</span></p>',
    );
    editor.destroy();
  });

  it("does not take a `role` entity field as an asset role", () => {
    const editor = make({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "u1", label: "jack", role: "admin" } as any }] }],
    });
    expect(editor.getHTML()).not.toContain("data-role");
    editor.destroy();
  });

  it("round-trips data-role through HTML and JSON (randomized), and sets roles", () => {
    const r = rng(7);
    for (let i = 0; i < 40; i++) {
      const nodes: any[] = [];
      for (let j = 0; j < 1 + Math.floor(r() * 5); j++) {
        const role = r() < 0.5 ? pick(r, ROLES) : null;
        nodes.push({ type: "text", text: j === 0 ? "x " : " x " });
        nodes.push({ type: "mention", attrs: { id: `a${j}`, label: pick(r, HANDLES), ...(role ? { assetRole: role } : {}) } });
      }
      const editor = make({ type: "doc", content: [{ type: "paragraph", content: nodes }] });
      const html = editor.getHTML();
      const again = make(html);
      expect(again.getJSON()).toEqual(editor.getJSON());
      expect(again.getHTML()).toBe(html);
      const roles = nodes.filter((n) => n.type === "mention").map((n) => n.attrs.assetRole);
      expect(extractMentionsFromDoc(again).map((m) => m.role)).toEqual(roles);
      expect(getMentionNodes(again).map((m) => m.role)).toEqual(roles);
      editor.destroy();
      again.destroy();
    }

    const editor = make('<p>hi <span data-type="mention" data-id="a" data-label="fox">@fox</span></p>');
    const [mention] = getMentionNodes(editor);
    expect(setMentionRoleAt(editor, mention.pos, "style")).toBe(true);
    expect(editor.getHTML()).toContain('data-role="style"');
    expect(setMentionRoleAt(editor, mention.pos, "no good")).toBe(false);
    expect(setMentionRoleAt(editor, 0, "style")).toBe(false);
    expect(setMentionRoleAt(editor, mention.pos, null)).toBe(true);
    expect(editor.getHTML()).not.toContain("data-role");
    editor.destroy();
  });
});

describe("role parsing stays linear", () => {
  it.each([[" @a:"], [" @a:b-"], [" @a:" + "b_".repeat(20)], ["@\"a\":x"], [" @a\u0001"]])("%j", (unit) => {
    const all = (s: string) => {
      extractMentions(s, { details: true, roles: true });
      findTextMentions(s);
      parseMentionSegments(s, { roles: true });
    };
    expect(growthRatio(unit, all)).toBeLessThan(10);
  }, 30_000);

  // preprocessMarkdownMentions builds one span per mention, so its own cost
  // (with or without roles) varies with GC under load. Compare the role path
  // with the unchanged one instead of asserting absolute growth.
  it("preprocessing with roles costs about the same as without", () => {
    const input = " @a:b @c:".repeat(8000);
    // Same input both ways: the "growth" is the cost of the role path relative to the old one.
    const ratio = measureGrowth(
      () => preprocessMarkdownMentions(input),
      () => preprocessMarkdownMentions(input, { roles: true }),
      { limit: 5 },
    );
    expect(ratio).toBeLessThan(5);
  }, 30_000);
});
