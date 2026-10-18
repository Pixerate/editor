/// <reference types="node" />
// A small RFC 6455 WebSocket server on node:http, enough for the tool bridge: text frames
// (fragmented or not), ping / pong, close, and client masking as browsers send it. No
// compression or binary messages. Keeps the bridge free of a `ws` dependency.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest message accepted from an editor (16 MiB): tool results can carry images. */
const MAX_MESSAGE = 16 * 1024 * 1024;

export interface BridgeSocket {
	send(text: string): void;
	close(code?: number, reason?: string): void;
	/** Closes without waiting for the other side (shutting down). */
	terminate(): void;
	onMessage(listener: (text: string) => void): void;
	onClose(listener: (code: number, reason: string) => void): void;
	readonly open: boolean;
}

/** Answers the HTTP upgrade handshake; returns false (and writes a 400) for a bad request. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): boolean {
	const key = req.headers['sec-websocket-key'];
	if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
		rejectUpgrade(socket, 400, 'Bad Request');
		return false;
	}
	const accept = createHash('sha1').update(key + GUID).digest('base64');
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	return true;
}

/** Refuses an upgrade with an HTTP status (the browser sees the connection fail). */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
	socket.destroy();
}

function frame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	const head = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
	head[0] = 0x80 | opcode;
	if (length < 126) head[1] = length;
	else if (length < 65536) {
		head[1] = 126;
		head.writeUInt16BE(length, 2);
	} else {
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([head, payload]);
}

/** Wraps an upgraded socket as a text-message WebSocket. */
export function wrapWebSocket(socket: Duplex): BridgeSocket {
	let buffer = Buffer.alloc(0);
	let fragments: Buffer[] = [];
	let open = true;
	const messageListeners: Array<(text: string) => void> = [];
	const closeListeners: Array<(code: number, reason: string) => void> = [];
	let closeInfo: { code: number; reason: string } | null = null;

	const finish = (code: number, reason: string) => {
		if (closeInfo) return;
		closeInfo = { code, reason };
		open = false;
		closeListeners.forEach((l) => l(code, reason));
	};
	const close = (code = 1000, reason = '') => {
		if (!open) return;
		open = false;
		const body = Buffer.alloc(2 + Buffer.byteLength(reason));
		body.writeUInt16BE(code, 0);
		body.write(reason, 2);
		socket.write(frame(0x8, body));
		socket.end();
		// A peer that never answers the close must not keep the server open.
		setTimeout(() => socket.destroy(), 1000).unref?.();
		finish(code, reason);
	};

	socket.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 2) {
			const fin = (buffer[0]! & 0x80) !== 0;
			const opcode = buffer[0]! & 0x0f;
			const masked = (buffer[1]! & 0x80) !== 0;
			let length = buffer[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) return;
				const big = buffer.readBigUInt64BE(2);
				if (big > BigInt(MAX_MESSAGE)) return close(1009, 'Message too big.');
				length = Number(big);
				offset = 10;
			}
			// Clients must mask every frame (RFC 6455 §5.1).
			if (!masked) return close(1002, 'Unmasked frame.');
			if (buffer.length < offset + 4 + length) return;
			const mask = buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
			for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
			buffer = buffer.subarray(offset + 4 + length);

			if (opcode === 0x8) {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
				if (open) {
					open = false;
					socket.write(frame(0x8, payload.subarray(0, 2)));
					socket.end();
				}
				return finish(code, reason);
			}
			if (opcode === 0x9) {
				socket.write(frame(0xa, payload));
				continue;
			}
			if (opcode === 0xa) continue;
			if (opcode === 0x2) return close(1003, 'Only text messages are supported.');
			if (opcode === 0x1 || opcode === 0x0) {
				fragments.push(payload);
				if (fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) return close(1009, 'Message too big.');
				if (fin) {
					const text = Buffer.concat(fragments).toString('utf8');
					fragments = [];
					messageListeners.forEach((l) => l(text));
				}
			}
		}
	});
	socket.on('close', () => finish(1006, ''));
	socket.on('error', () => finish(1006, ''));

	return {
		get open() {
			return open;
		},
		send(text) {
			if (open) socket.write(frame(0x1, Buffer.from(text, 'utf8')));
		},
		close,
		terminate() {
			if (open) close(1001, 'Going away.');
			socket.destroy();
		},
		onMessage(listener) {
			messageListeners.push(listener);
		},
		onClose(listener) {
			closeListeners.push(listener);
		}
	};
}
