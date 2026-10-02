/**
 * Shared slot definitions for design system component inversion.
 * Allows consumers in React or Svelte to inject their own design system components
 * (Tailwind, Radix, Shadcn, Carbon, Melt, etc.) into @pixerate/editor without forking.
 */

export interface BaseSlotProps {
	className?: string;
	children?: any;
	[key: string]: any;
}

export interface ButtonSlotProps extends BaseSlotProps {
	variant?: 'default' | 'primary' | 'ghost' | 'outline' | 'danger';
	size?: 'sm' | 'md' | 'lg';
	disabled?: boolean;
	onClick?: (e: any) => void;
}

export interface TooltipSlotProps extends BaseSlotProps {
	content: any;
	placement?: 'top' | 'right' | 'bottom' | 'left';
}

export interface NodeHeaderSlotProps extends BaseSlotProps {
	title: string;
	icon?: any;
	onClose?: () => void;
}

export interface EditorSlotsMap {
	Button?: (props: ButtonSlotProps) => any;
	Tooltip?: (props: TooltipSlotProps) => any;
	NodeHeader?: (props: NodeHeaderSlotProps) => any;
	[customSlot: string]: ((props: any) => any) | undefined;
}
