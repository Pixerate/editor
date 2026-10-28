<script lang="ts">
  import type { ParametersController } from '@pixerate/editor/parameters';
  import { ParametersPanel, setParameterComponents, type ParameterComponents } from '../../src/parameters';

  let {
    controller,
    components,
  }: {
    controller: ParametersController;
    components: ParameterComponents;
  } = $props();

  // svelte-ignore state_referenced_locally
  setParameterComponents(components);
</script>

<ParametersPanel {controller} />
