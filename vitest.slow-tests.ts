// A reporter for CI that warns, without failing the run, about tests that use a large part of
// their timeout. CI runners are ~3× slower than a laptop and run test files in parallel, so a
// test that takes 2 s locally times out there now and then. Warnings show as annotations on the
// run and in its summary, so slow tests get fixed (see GOTCHAS.md, "Writing Tests That Pass on
// CI") before they block a release. Only `vitest.config.ts` loads it, and only on GitHub Actions.
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';

/** Warn when a test takes at least this share of its timeout. */
const SHARE = 0.4;

interface Slow {
  file: string;
  name: string;
  duration: number;
  timeout: number;
}

export default class SlowTestsReporter implements Reporter {
  private slow: Slow[] = [];

  onTestCaseResult(test: TestCase): void {
    const diagnostic = test.diagnostic();
    const timeout = test.options.timeout ?? test.project.config.testTimeout;
    if (!diagnostic || !timeout || diagnostic.duration < timeout * SHARE) return;
    this.slow.push({ file: relative(process.cwd(), test.module.moduleId), name: test.fullName, duration: diagnostic.duration, timeout });
  }

  onTestRunEnd(): void {
    if (!this.slow.length) return;
    this.slow.sort((a, b) => b.duration / b.timeout - a.duration / a.timeout);
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    for (const s of this.slow) {
      const message = `${s.name} took ${seconds(s.duration)} of its ${seconds(s.timeout)} timeout.`;
      console.log(`::warning file=${s.file},title=Slow test::${message.replace(/\r?\n/g, ' ')}`);
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const rows = this.slow.map((s) => `| ${cell(s.name)} | \`${s.file}\` | ${seconds(s.duration)} | ${seconds(s.timeout)} |`);
    appendFileSync(
      summary,
      [
        `### Tests using over ${SHARE * 100} % of their timeout`,
        '',
        'They pass, but may time out on a loaded runner. Make them faster (smaller fixtures, fake timers, counted work) rather than raising the timeout; see GOTCHAS.md.',
        '',
        '| Test | File | Took | Timeout |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
      ].join('\n'),
    );
  }
}
