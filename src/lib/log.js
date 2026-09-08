const START = Date.now();
const pad = (n, w = 2) => String(n).padStart(w, '0');

function stamp() {
  const s = (Date.now() - START) / 1000;
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
}

const write = (stream, tag, args) =>
  stream.write(`[${stamp()}] ${tag} ${args.map(String).join(' ')}\n`);

export const log = {
  info: (...a) => write(process.stdout, ' ', a),
  step: (...a) => write(process.stdout, '>', a),
  warn: (...a) => write(process.stderr, '!', a),
  error: (...a) => write(process.stderr, 'x', a),
  debug: (...a) => process.env.BOARDBOOK_DEBUG && write(process.stderr, '.', a),
};

/** Single-line progress counter that does not spam CI logs. */
export function progress(label, total) {
  let n = 0;
  const tty = process.stdout.isTTY;
  const every = Math.max(1, Math.floor(total / 20));
  return {
    tick(note = '') {
      n += 1;
      if (tty) {
        process.stdout.write(`\r[${stamp()}] > ${label} ${n}/${total} ${note.slice(0, 60)}`.padEnd(110).slice(0, 110));
      } else if (n % every === 0 || n === total) {
        log.step(`${label} ${n}/${total}`);
      }
    },
    done() {
      if (tty) process.stdout.write('\r'.padEnd(112) + '\r');
      log.step(`${label} complete (${n}/${total})`);
    },
  };
}
