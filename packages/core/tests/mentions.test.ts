import { describe, it, expect } from "vitest";
import {
  MENTION_REGEX,
  stripMarkdownCode,
  extractMentions,
  parseMentionSegments,
  preprocessMarkdownMentions,
  preprocessMarkdownFileLinks,
  markdownToTipTapHtml,
  extractMentionsFromDoc,
  type MentionEntity,
} from "../src";

describe("Mentions Parsing, Extraction & Markdown Preprocessing", () => {
  const sampleMentionables: MentionEntity[] = [
    {
      id: "usr_jack_1",
      name: "Jack James",
      handle: "jackjames",
      label: "jackjames",
      type: "user",
      avatarUrl: "https://example.com/jack.png",
    },
    {
      id: "ag_violet_1",
      name: "Agent Violet",
      handle: "violet",
      label: "violet",
      type: "agent",
      color: "#8B5CF6",
      aliases: ["planner"],
    },
    {
      id: "team_agents_1",
      name: "Autonomous Agents",
      handle: "agents",
      label: "agents",
      type: "team",
    },
  ];

  describe("stripMarkdownCode", () => {
    it("strips fenced and tilde code blocks", () => {
      const input = `
Before code
\`\`\`ts
const ping = "@jackjames";
\`\`\`
Between code
~~~bash
echo "@violet"
~~~
After code`;
      const stripped = stripMarkdownCode(input);
      expect(stripped).not.toContain("@jackjames");
      expect(stripped).not.toContain("@violet");
      expect(stripped).toContain("Before code");
      expect(stripped).toContain("Between code");
      expect(stripped).toContain("After code");
    });

    it("strips inline backticks and HTML pre/code tags", () => {
      const input =
        "Ping `@alex` in chat or <pre>@coordinator</pre> or <code>@validator</code>, but ping @jackjames outside.";
      const stripped = stripMarkdownCode(input);
      expect(stripped).not.toContain("@alex");
      expect(stripped).not.toContain("@coordinator");
      expect(stripped).not.toContain("@validator");
      expect(stripped).toContain("@jackjames");
    });
  });

  describe("extractMentions", () => {
    it("extracts unique standard handles and quoted handles", () => {
      const text = 'cc @jackjames and @"Jane Doe" and @jackjames again.';
      const extracted = extractMentions(text);
      expect(extracted).toEqual(["jackjames", "Jane Doe"]);
    });

    it("ignores trailing punctuation on mentions", () => {
      const text = "Paging @jackjames. And @violet! Also @jackjames, right?";
      const extracted = extractMentions(text);
      expect(extracted).toEqual(["jackjames", "violet"]);
    });

    it("ignores mentions inside code blocks and inline backticks", () => {
      const text = `
\`\`\`
const a = "@ignored_in_block";
\`\`\`
Use \`@ignored_inline\` in config, but notify @jackjames.`;
      const extracted = extractMentions(text);
      expect(extracted).toEqual(["jackjames"]);
    });

    it("ignores mentions in URLs, email addresses, and HTML attributes", () => {
      const text = `
Check https://github.com/@pixerate/editor or [doc](https://example.com/@jack)
or email dev@example.com or <span data-mention-suggestion-char="@" data-id="123">@violet</span>.`;
      const extracted = extractMentions(text);
      expect(extracted).toEqual(["violet"]);
    });
  });

  describe("parseMentionSegments", () => {
    it("segments text into text parts and mention tokens with trailing punctuation preserved", () => {
      const text = "Hello @jackjames! Please review with @violet.";
      const segments = parseMentionSegments(text);
      expect(segments).toEqual([
        { type: "text", value: "Hello " },
        { type: "mention", value: "@jackjames", handle: "jackjames" },
        { type: "text", value: "! Please review with " },
        { type: "mention", value: "@violet", handle: "violet" },
        { type: "text", value: "." },
      ]);
    });

    it("returns single text segment when no mentions are present", () => {
      const text = "Just plain text without mentions.";
      const segments = parseMentionSegments(text);
      expect(segments).toEqual([{ type: "text", value: text }]);
    });
  });

  describe("preprocessMarkdownMentions", () => {
    it("transforms raw @handle into TipTap mention span matching entity in mentionables", () => {
      const input = "cc @jackjames for verification or follow up.";
      const output = preprocessMarkdownMentions(input, sampleMentionables);
      expect(output).toBe(
        'cc <span class="pixerate-mention-node" data-type="mention" data-id="usr_jack_1" data-label="jackjames" data-mention-suggestion-char="@" data-type-name="user" data-avatar-url="https://example.com/jack.png">@jackjames</span> for verification or follow up.'
      );
    });

    it("transforms agent mentions including color attribute", () => {
      const input = "Assigning to @violet for plan generation.";
      const output = preprocessMarkdownMentions(input, sampleMentionables);
      expect(output).toContain('data-id="ag_violet_1"');
      expect(output).toContain('data-label="violet"');
      expect(output).toContain('data-type-name="agent"');
      expect(output).toContain('data-color="#8B5CF6"');
    });

    it("resolves agent aliases like @planner to the corresponding agent entity", () => {
      const input = "Asking @planner for review.";
      const output = preprocessMarkdownMentions(input, sampleMentionables);
      expect(output).toContain('data-id="ag_violet_1"');
      expect(output).toContain('data-label="violet"');
      expect(output).toContain('data-type-name="agent"');
    });

    it("resolves standard agent role aliases when not in mentionables", () => {
      const input = "Paging @supervisor and @coordinator and @validator and @executor.";
      const output = preprocessMarkdownMentions(input, []);
      expect(output).toContain('data-id="supervisor" data-label="supervisor" data-mention-suggestion-char="@" data-type-name="agent"');
      expect(output).toContain('data-id="coordinator" data-label="coordinator" data-mention-suggestion-char="@" data-type-name="agent"');
      expect(output).toContain('data-id="validator" data-label="validator" data-mention-suggestion-char="@" data-type-name="agent"');
      expect(output).toContain('data-id="executor" data-label="executor" data-mention-suggestion-char="@" data-type-name="agent"');
    });

    it("resolves team handle @agents to team type when not in mentionables", () => {
      const input = "Dispatching to @agents team.";
      const output = preprocessMarkdownMentions(input, []);
      expect(output).toContain('data-id="agents" data-label="agents" data-mention-suggestion-char="@" data-type-name="team"');
    });

    it("falls back to user type for unrecognized handles", () => {
      const input = "Hey @newuser please check this.";
      const output = preprocessMarkdownMentions(input, []);
      expect(output).toBe(
        'Hey <span class="pixerate-mention-node" data-type="mention" data-id="newuser" data-label="newuser" data-mention-suggestion-char="@" data-type-name="user">@newuser</span> please check this.'
      );
    });

    it("handles quoted handles like @\"Jane Doe\"", () => {
      const input = 'cc @"Jane Doe" for approval.';
      const output = preprocessMarkdownMentions(input, []);
      expect(output).toContain('data-id="Jane Doe" data-label="Jane Doe"');
      expect(output).toContain('>@Jane Doe</span>');
    });

    it("preserves trailing punctuation on mentions", () => {
      const input = "cc @jackjames. And @violet! Also @jackjames, right?";
      const output = preprocessMarkdownMentions(input, sampleMentionables);
      expect(output).toContain(">@jackjames</span>.");
      expect(output).toContain(">@violet</span>!");
      expect(output).toContain(">@jackjames</span>,");
    });

    it("does not format mentions inside code blocks or inline code", () => {
      const input = `
\`\`\`bash
echo "@jackjames should not be formatted"
\`\`\`
~~~ts
const user = "@violet";
~~~
Ping \`@alex\` or <code>@coordinator</code>, but cc @jackjames outside.`;
      const output = preprocessMarkdownMentions(input, sampleMentionables);
      expect(output).toContain('echo "@jackjames should not be formatted"');
      expect(output).toContain('const user = "@violet";');
      expect(output).toContain("`@alex`");
      expect(output).toContain("<code>@coordinator</code>");
      expect(output).toContain('cc <span class="pixerate-mention-node"');
    });

    it("does not double-wrap pre-existing TipTap mention spans", () => {
      const input =
        'Existing <span class="pixerate-mention-node" data-type="mention" data-id="123" data-label="jackjames" data-mention-suggestion-char="@" data-type-name="user">@jackjames</span> and new @violet.';
      const output = preprocessMarkdownMentions(input, sampleMentionables);
      expect(output).toContain(
        '<span class="pixerate-mention-node" data-type="mention" data-id="123" data-label="jackjames" data-mention-suggestion-char="@" data-type-name="user">@jackjames</span>'
      );
      expect(output).toContain('data-id="ag_violet_1"');
      expect(output).not.toContain('<span class="pixerate-mention-node"><span');
    });

    it("supports custom resolveMention callback", () => {
      const input = "Contact @custom_entity for help.";
      const output = preprocessMarkdownMentions(input, {
        resolveMention: (handle) => ({
          id: `custom_${handle}`,
          type: "service",
          color: "#10b981",
        }),
      });
      expect(output).toContain('data-id="custom_custom_entity"');
      expect(output).toContain('data-type-name="service"');
      expect(output).toContain('data-color="#10b981"');
    });
  });

  describe("preprocessMarkdownFileLinks", () => {
    it("converts file, vscode, and cursor links into clickable anchor tags with data-file-link", () => {
      const input =
        "Inspect [TaskCard.svelte](file:///path/to/TaskCard.svelte) or [`config.json`](vscode://open/config.json).";
      const output = preprocessMarkdownFileLinks(input);
      expect(output).toContain(
        '<a href="file:///path/to/TaskCard.svelte" data-file-link="true" title="Click to copy file path">TaskCard.svelte</a>'
      );
      expect(output).toContain(
        '<a href="vscode://open/config.json" data-file-link="true" title="Click to copy file path"><code>config.json</code></a>'
      );
    });
  });

  describe("markdownToTipTapHtml integration", () => {
    it("converts markdown with raw @mentions to TipTap HTML mention nodes when option is enabled", () => {
      const markdown = "cc @jackjames and @violet for follow up.";
      const html = markdownToTipTapHtml(markdown, {
        mentionables: sampleMentionables,
      });

      expect(html).toContain('class="pixerate-mention-node"');
      expect(html).toContain('data-type="mention"');
      expect(html).toContain('data-id="usr_jack_1"');
      expect(html).toContain('data-label="jackjames"');
      expect(html).toContain('data-id="ag_violet_1"');
      expect(html).toContain('data-label="violet"');
    });

    it("converts file links with data-file-link when preprocessFileLinks is true", () => {
      const markdown = "See [file.ts](file:///path/file.ts)";
      const html = markdownToTipTapHtml(markdown, {
        preprocessFileLinks: true,
      });
      expect(html).toContain('data-file-link="true"');
      expect(html).toContain('href="file:///path/file.ts"');
    });
  });

  describe("extractMentionsFromDoc fallback", () => {
    it("extracts mentions from plain text string when no HTML spans are present", () => {
      const text = "Please ask @jackjames and @violet to check this.";
      const extracted = extractMentionsFromDoc(text);
      expect(extracted).toHaveLength(2);
      expect(extracted[0]).toMatchObject({ id: "jackjames", label: "jackjames", type: "user" });
      expect(extracted[1]).toMatchObject({ id: "violet", label: "violet", type: "user" });
    });
  });
});
