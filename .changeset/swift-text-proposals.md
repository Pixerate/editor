---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

The text change feed and text proposals in Swift (#890): `PixerateCore` ports `createTextChangeFeed` (`TextChangeFeed`, `diffText`, `textChangeBoundary`), `createTextProposals` (`TextProposals`) and `createTextProposalToolProvider` (`propose_text_edit`, `list_text_proposals`, `accept_text_proposal`, `reject_text_proposal`). `PixerateMarkdownTools` puts them on a Markdown host (`createMarkdownTextProposals`, `createMarkdownTextChangeFeed`), and `MarkdownTextChange` gains an `origin`, which `MarkdownTextBuffer` records (`undoOrigins`), so an accepted proposal is one step made by its proposer.

`@pixerate/conformance` has a new `text-proposals` domain (`textProposalContracts()` in `@pixerate/editor/tools`): the feed, proposals and their tools as step scenarios.
