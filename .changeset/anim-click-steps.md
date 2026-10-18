---
"@pixerate/editor": patch
---

Click-triggered scenes now export the way Flair's player plays them.

- **The problem:** Flair's player shows a click-triggered picture still until the first click, then plays steps 0 and 1 together. That made the first click play the first two shots at once.
- **Export:** shot n now goes on step n + 1. Each click plays one shot, and after the last the first plays again.
- **Import:** importing a click effect folds its step 0 into the first shot.
