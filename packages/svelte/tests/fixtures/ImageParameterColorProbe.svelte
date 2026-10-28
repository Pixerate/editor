<script lang="ts">
  import type { ColorParameterField } from '@pixerate/editor/parameters';
  import { ParameterColor } from '../../src/parameters';
  import { setImageEditorControls } from '../../src/image-editor/controls/controls';
  import { imageEditorParameterComponents } from '../../src/image-editor/controls/parameterControls';
  import HostColor from './HostColor.svelte';

  let { field, value, onchange }: { field: ColorParameterField; value: string; onchange: (v: string) => void } = $props();

  const controls = setImageEditorControls({ Color: HostColor });
  const components = imageEditorParameterComponents(controls);
</script>

<ParameterColor {field} {value} {onchange} {components} />
