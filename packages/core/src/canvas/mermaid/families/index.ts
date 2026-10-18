import type { DiagramFamily } from '../../../diagram/types.js';
import type { FamilyScene } from '../scene-kit.js';
import { pieScene } from './pie.js';
import { radarScene, xyChartScene } from './charts.js';
import { sequenceScene } from './sequence.js';
import { journeyScene } from './journey.js';
import { quadrantScene } from './quadrant.js';
import { gitGraphScene } from './gitgraph.js';
import { mindmapScene } from './mindmap.js';
import { c4Scene } from './c4.js';
import { architectureScene } from './architecture.js';
import { ganttScene } from './gantt.js';
import { timelineScene } from './timeline.js';

export { pieScene, radarScene, xyChartScene, sequenceScene, journeyScene, quadrantScene, gitGraphScene, mindmapScene, c4Scene, architectureScene, ganttScene, timelineScene };
export { radarChartSpec, xyChartSpec } from './charts.js';

/** The drawings that ship with the package, by family. */
export const BUILTIN_FAMILY_SCENES: Partial<Record<DiagramFamily, FamilyScene>> = {
	pie: pieScene,
	xychart: xyChartScene,
	radar: radarScene,
	sequence: sequenceScene,
	journey: journeyScene,
	quadrant: quadrantScene,
	gitGraph: gitGraphScene,
	mindmap: mindmapScene,
	c4: c4Scene,
	architecture: architectureScene,
	gantt: ganttScene,
	timeline: timelineScene
};
