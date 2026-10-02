import React, { createContext, useContext, useMemo } from 'react';
import type {
	ButtonSlotProps,
	EditorSlotsMap,
	NodeHeaderSlotProps,
	TooltipSlotProps
} from '@pixerate/editor';

const defaultSlots: EditorSlotsMap = {
	Button: (props: ButtonSlotProps) => (
		<button
			type="button"
			className={`pixerate-btn ${props.className || ''}`}
			onClick={props.onClick}
			disabled={props.disabled}
		>
			{props.children}
		</button>
	),
	Tooltip: (props: TooltipSlotProps) => (
		<div className={`pixerate-tooltip-container ${props.className || ''}`} title={String(props.content)}>
			{props.children}
		</div>
	),
	NodeHeader: (props: NodeHeaderSlotProps) => (
		<div className={`pixerate-node-header flex items-center justify-between ${props.className || ''}`}>
			<div className="flex items-center gap-2">
				{props.icon}
				<span className="font-semibold">{props.title}</span>
			</div>
			{props.onClose && (
				<button type="button" onClick={props.onClose} className="opacity-70 hover:opacity-100">
					×
				</button>
			)}
		</div>
	)
};

const EditorSlotsContext = createContext<EditorSlotsMap>(defaultSlots);

export interface EditorSlotsProviderProps {
	slots?: Partial<EditorSlotsMap>;
	children: React.ReactNode;
}

/**
 * Context provider allowing consumers to inject custom design system components into the editor.
 */
export function EditorSlotsProvider({ slots, children }: EditorSlotsProviderProps) {
	const mergedSlots = useMemo(() => ({ ...defaultSlots, ...slots }), [slots]);

	return (
		<EditorSlotsContext.Provider value={mergedSlots}>
			{children}
		</EditorSlotsContext.Provider>
	);
}

/**
 * Hook to access injected design system slots.
 */
export function useEditorSlots(): EditorSlotsMap {
	return useContext(EditorSlotsContext);
}
