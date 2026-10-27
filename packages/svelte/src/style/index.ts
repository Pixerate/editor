import type { ComponentProps } from "svelte";
import type StyleFindingsComponent from "./StyleFindings.svelte";

export { default as StyleFindings } from "./StyleFindings.svelte";
export * from "./style.svelte.js";

export type StyleFindingsProps = ComponentProps<typeof StyleFindingsComponent>;
