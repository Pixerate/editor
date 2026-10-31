---
name: pixerate-<editor>-<job>
description: The <job> workflow in the Pixerate <editor> - <what it produces, in the user's words, and the main steps>. Use when asked to <trigger phrases: the verbs and nouns people use for this job>, or when <a tool or two that signal the job> are available. Load with pixerate-<editor>, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-<editor>
---

# <The job, as a short title>

<Two to four sentences: the model of the job a person needs before starting. What the
document is made of here, and the one or two facts that make this job go right or wrong.>

This skill is the method. `pixerate-<editor>` has the full tool reference.

## Goal and quality bar

- <What the finished result is, stated so it can be checked: numbers, ranges, absences.>
- <What must stay editable, reversible or untouched.>

## Inputs to confirm

Ask when you cannot tell from the document; say what you assumed when you can.

- **<Decision>:** <the options, and the default when the user does not say>.

## Working method

1. **<Step>.** <What to do, with which tool and which arguments matter (units, defaults).>
   **Check:** <a read tool and what its result must show before going on>.
2. **<Step>.** ...
   **Check:** ...

## Decision table

| Situation | Approach |
| --- | --- |
| <case> | <method, tool, setting> |

## Recipes

**<Common request>.** <The tool calls in order, with arguments, as short prose.>

## Pitfalls

- **<Failure>.** <Why it happens and how to avoid or detect it.>

## Tools used

- `<tool_name>`, `<tool_name>`: <one-line purpose in this job>
