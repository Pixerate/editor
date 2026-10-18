/** Concrete colours (no CSS variables), so the SVG draws the same as a file, an `<img>` or a PNG. */
export interface DiagramSvgTheme {
	background: string;
	nodeFill: string;
	nodeStroke: string;
	text: string;
	edge: string;
	edgeLabelBackground: string;
	groupFill: string;
	groupStroke: string;
	groupText: string;
	fontFamily: string;
	fontSize: number;
}

export const DIAGRAM_SVG_LIGHT_THEME: DiagramSvgTheme = {
	background: '#ffffff',
	nodeFill: '#ffffff',
	nodeStroke: '#0f172a',
	text: '#0f172a',
	edge: '#64748b',
	edgeLabelBackground: '#ffffff',
	groupFill: '#f8fafc',
	groupStroke: '#cbd5e1',
	groupText: '#475569',
	fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
	fontSize: 13
};

export const DIAGRAM_SVG_DARK_THEME: DiagramSvgTheme = {
	background: '#0f172a',
	nodeFill: '#1e293b',
	nodeStroke: '#e2e8f0',
	text: '#f1f5f9',
	edge: '#94a3b8',
	edgeLabelBackground: '#0f172a',
	groupFill: '#111c33',
	groupStroke: '#334155',
	groupText: '#94a3b8',
	fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
	fontSize: 13
};
