#!/usr/bin/env node
/// <reference types="node" />
// `pixerate-mcp-bridge`: an MCP server (stdio) that forwards to editors open in a browser.
//   pixerate-mcp-bridge [--port 4477] [--token SECRET] [--origin https://app.example.com]... [--name pixerate]
// The token can also come from PIXERATE_BRIDGE_TOKEN.
import { createToolBridge } from './index.js';

const args = process.argv.slice(2);
const value = (flag: string) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
	process.stderr.write(
		'Usage: pixerate-mcp-bridge [--port 4477] [--token SECRET] [--origin URL]... [--name NAME]\n' +
			'Serves MCP on stdio and forwards tool calls to editors that connect with connectToolBridge().\n'
	);
	process.exit(0);
}
const origins: string[] = [];
args.forEach((arg, i) => {
	if (arg === '--origin' && args[i + 1]) origins.push(args[i + 1]!);
});
const port = value('--port');

void createToolBridge({
	name: value('--name') ?? 'pixerate',
	port: port !== undefined ? Number(port) : undefined,
	token: value('--token') ?? process.env.PIXERATE_BRIDGE_TOKEN,
	origins
}).then((bridge) => {
	const stop = () => void bridge.close().then(() => process.exit(0));
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	process.stdin.on('end', stop);
});
