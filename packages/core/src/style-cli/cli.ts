#!/usr/bin/env node
/// <reference types="node" />
// `pixerate-style`: check, scaffold and preview house-style skills. Run with no arguments for usage.
import { runStyleCli } from './run.js';

void runStyleCli(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }).then(({ code, server }) => {
	if (!server) process.exit(code);
});
