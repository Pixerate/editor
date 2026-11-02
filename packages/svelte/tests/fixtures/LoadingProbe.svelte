<script lang="ts">
  import type { LoadingNodeViewState } from "@pixerate/editor";

  let { view }: { view: LoadingNodeViewState } = $props();
</script>

<span class="probe-loader" data-job={view.id}>{view.label}</span>
