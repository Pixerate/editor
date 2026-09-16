declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const taskLists: (md: MarkdownIt, options?: any) => void;
  export default taskLists;
}
