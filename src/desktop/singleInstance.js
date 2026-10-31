const net = require('net');
const os = require('os');
const crypto = require('crypto');

// One running copy per Windows user. The first instance listens on a per-user
// named pipe (no TCP port, no firewall rule); later launches connect, ask it to
// show its window, and exit. Pipes vanish with their process, so a crash can't
// leave a stale lock behind.
function defaultPipeName() {
  const who = `${process.env.USERDOMAIN || ''}\\${os.userInfo().username}|${os.homedir()}`;
  const id = crypto.createHash('sha256').update(who.toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\bdo-balenciaga-${id}`;
}

const COMMANDS = new Set(['show', 'ping']);

// Resolves { primary: true, close() } or { primary: false, notify(cmd) }.
function acquire({ name = defaultPipeName(), onCommand = () => {} } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.setTimeout(2000, () => sock.destroy());
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 64) return sock.destroy(); // only short fixed commands are valid
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const cmd = buf.slice(0, nl).trim();
        if (!COMMANDS.has(cmd)) return sock.destroy();
        sock.end('ok\n');
        if (cmd === 'show') onCommand('show');
      });
    });

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ primary: false, notify: (cmd) => notify(name, cmd) });
      } else {
        // Can't enforce single-instance (unusual); run anyway rather than refuse to start.
        console.warn('[Instance] Single-instance pipe unavailable:', err.message);
        resolve({ primary: true, close: () => {} });
      }
    });
    server.listen(name, () => {
      resolve({ primary: true, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function notify(name, cmd, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(name);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setEncoding('utf8');
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on('error', () => finish(false));
    sock.on('connect', () => sock.write(`${cmd}\n`));
    sock.on('data', (d) => finish(String(d).startsWith('ok')));
    sock.on('end', () => finish(false));
  });
}

module.exports = { acquire, notify, defaultPipeName };
