const net = require('node:net');

// Counts both directions of the real USB tunnel, including its framing overhead.
class MeterBridge {
  constructor(onBytes, { port = 31416, backendPort } = {}) {
    this.onBytes = onBytes;
    this.port = port;
    this.backendPort = backendPort;
    this.sockets = new Set();
    this.up = 0;
    this.down = 0;
  }
  async start() {
    if (!this.backendPort) {
      const reservation = net.createServer();
      await new Promise((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
      });
      this.backendPort = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
    }
    this.server = net.createServer(client => {
      const upstream = net.connect(this.backendPort, '127.0.0.1');
      this.sockets.add(client);
      this.sockets.add(upstream);
      client.on('data', chunk => { this.up += chunk.length; });
      upstream.on('data', chunk => { this.down += chunk.length; });
      for (const [socket, other] of [[client, upstream], [upstream, client]]) {
        socket.on('error', () => other.destroy());
        socket.on('close', () => { this.sockets.delete(socket); other.destroy(); });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise((resolve, reject) => {
      const failed = error => reject(new Error(error.code === 'EADDRINUSE'
        ? `Port ${this.port} is already in use. Stop another Gnirehtet instance and try again.` : error.message));
      this.server.once('error', failed);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', failed);
        resolve();
      });
    });
    this.server.on('error', error => this.onError?.(error));
    this.port = this.server.address().port;
    this.timer = setInterval(() => this.onBytes({ bytesUp: this.up, bytesDown: this.down }), 1000);
    this.timer.unref();
    return this.backendPort;
  }
  async stop() {
    clearInterval(this.timer);
    await Promise.all([...this.sockets].map(socket => new Promise(resolve => {
      if (socket.closed) return resolve();
      socket.once('close', resolve);
      socket.destroy();
    })));
    this.sockets.clear();
    this.onBytes({ bytesUp: this.up, bytesDown: this.down });
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
module.exports = { MeterBridge };
