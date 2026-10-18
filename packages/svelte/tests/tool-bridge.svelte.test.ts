import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import { ToolRegistry, type ToolBridgeSocket } from '@pixerate/editor/tools';
import { useToolBridge } from '../src/toolBridge.svelte.js';

// jsdom's Event clashes with Node's WebSocket, so the bridge is played by a fake socket here;
// the real network path is covered in core (tests/tool-bridge.test.ts).
class FakeBridgeSocket implements ToolBridgeSocket {
	static last: FakeBridgeSocket | null = null;
	readyState = 0;
	sent: any[] = [];
	private listeners: Record<string, Array<(e: any) => void>> = {};
	constructor(readonly url: string) {
		FakeBridgeSocket.last = this;
		queueMicrotask(() => {
			this.readyState = 1;
			this.emit('open', {});
		});
	}
	addEventListener(type: string, listener: (e: any) => void) {
		(this.listeners[type] ??= []).push(listener);
	}
	emit(type: string, event: any) {
		this.listeners[type]?.forEach((l) => l(event));
	}
	send(data: string) {
		const message = JSON.parse(data);
		this.sent.push(message);
		if (message.t === 'hello') queueMicrotask(() => this.emit('message', { data: JSON.stringify({ t: 'welcome', v: 1, id: 'e7' }) }));
	}
	close() {
		this.readyState = 3;
		this.emit('close', { code: 1000 });
	}
}

const tick = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
};

describe('useToolBridge (Svelte)', () => {
	it('connects the registry while the effect lives and answers calls (parity with React)', async () => {
		const registry = new ToolRegistry();
		registry.register({
			id: 'demo',
			tools: [
				{
					name: 'ping',
					title: 'Ping',
					description: 'Answers pong.',
					inputSchema: { type: 'object', properties: {}, additionalProperties: false },
					annotations: { title: 'Ping', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
					handler: () => 'pong'
				}
			]
		});
		let on = $state(false);
		let link!: ReturnType<typeof useToolBridge>;
		const cleanup = $effect.root(() => {
			link = useToolBridge(registry, () => (on ? { url: 'ws://127.0.0.1:4477', token: 't', name: 'Svelte tab', WebSocket: FakeBridgeSocket } : null));
		});
		flushSync();
		expect(link.status).toBe('off');
		on = true;
		flushSync();
		await tick();
		expect(link.status).toBe('connected');
		expect(link.editorId).toBe('e7');
		const socket = FakeBridgeSocket.last!;
		expect(socket.url).toBe('ws://127.0.0.1:4477?token=t');
		expect(socket.sent[0]).toMatchObject({ t: 'hello', v: 1, name: 'Svelte tab', tools: [{ name: 'ping' }] });
		socket.emit('message', { data: JSON.stringify({ t: 'call', id: 'c1', name: 'ping', arguments: {} }) });
		await tick();
		expect(socket.sent.at(-1)).toMatchObject({ t: 'result', id: 'c1', result: { content: [{ type: 'text', text: 'pong' }] } });
		cleanup();
		expect(socket.readyState).toBe(3);
	});
});
