import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Asks once on the terminal without echoing what is typed or pasted (an API key). The question
 * goes to stderr so stdout stays clean for JSON readers. Resolves '' on Enter, Ctrl+C or Ctrl+D.
 */
export function askSecret(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise(resolve => {
    let echo = true, settled = false;
    const sink = new Writable({ write(chunk, encoding, done) { if (echo) output.write(chunk, encoding); done(); } });
    const rl = createInterface({ input, output: sink, terminal: true });
    const finish = answer => {
      if (settled) return;
      settled = true;
      rl.close();
      output.write('\n');
      resolve(String(answer ?? '').trim());
    };
    rl.on('SIGINT', () => finish(''));
    rl.on('close', () => finish(''));
    rl.question(question, finish);
    echo = false;
  });
}
