<script lang="ts">
  import type { ChoiceParameterField } from '@pixerate/editor/parameters';
  import { ParameterSelect } from '../../src/parameters';
  import { setImageEditorControls } from '../../src/image-editor/controls/controls';
  import { imageEditorParameterComponents } from '../../src/image-editor/controls/parameterControls';
  import HostSelect from './HostImageSelect.svelte';

  let { field, value, onchange }: { field: ChoiceParameterField; value: string | number; onchange: (v: string | number) => void } = $props();

  const controls = setImageEditorControls({ Select: HostSelect });
  const components = imageEditorParameterComponents(controls);
</script>

<ParameterSelect {field} {value} {onchange} {components} />
