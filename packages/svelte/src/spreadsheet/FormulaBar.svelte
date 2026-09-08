<script lang="ts">
  import { indexToColName } from '@pixerate/editor';

  interface Props {
    activeCoord?: { row: number; col: number } | null;
    value: string;
    onChange?: (val: string) => void;
    onCommit?: (val: string) => void;
    onCancel?: () => void;
  }

  let {
    activeCoord = null,
    value = $bindable(''),
    onChange,
    onCommit,
    onCancel
  }: Props = $props();

  let coordLabel = $derived.by(() => {
    if (!activeCoord) return '--';
    const colName = indexToColName(activeCoord.col);
    return `${colName}${activeCoord.row + 1}`;
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit?.(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel?.();
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    value = target.value;
    onChange?.(target.value);
  }
</script>

<div class="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs font-mono">
  <div class="flex h-6 min-w-[3rem] items-center justify-center rounded border border-border bg-background px-1.5 font-semibold text-foreground">
    {coordLabel}
  </div>
  <div class="flex items-center text-muted-foreground select-none">
    <span class="italic font-serif font-bold text-sm text-primary">fx</span>
  </div>
  <input
    type="text"
    class="flex-1 bg-transparent px-2 py-0.5 outline-none font-sans text-xs text-foreground placeholder:text-muted-foreground/60 focus:bg-background focus:ring-1 focus:ring-primary rounded"
    placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
    {value}
    oninput={handleInput}
    onkeydown={handleKeyDown}
  />
</div>
