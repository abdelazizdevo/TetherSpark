const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MeterBridge } = require('../src/meter.cjs');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

test('meter forwards actual bytes in both directions and reports the exact total', async () => {
  const sockets = new Set();
  const backend = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  const backendPort = await listen(backend);
  let measured;
  const bridge = new MeterBridge(bytes => { measured = bytes; }, { port: 0, backendPort });
  try {
    await bridge.start();
    const payload = Buffer.alloc(180000, 0x5a);
    await new Promise((resolve, reject) => {
      const client = net.connect(bridge.port, '127.0.0.1');
      let received = Buffer.alloc(0);
      client.setTimeout(3000, () => client.destroy(new Error('Forwarding timed out')));
      client.on('error', reject);
      client.once('connect', () => client.write(payload));
      client.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= payload.length) { assert.deepEqual(received, payload); client.destroy(); resolve(); }
      });
    });
    await bridge.stop();
    assert.deepEqual(measured, { bytesUp: 180000, bytesDown: 180000 });
    assert.equal(bridge.sockets.size, 0);
  } finally {
    await bridge.stop(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => backend.close(resolve));
  }
});
test('an occupied USB port produces an actionable startup error', async () => {
  const occupied = net.createServer(); const port = await listen(occupied);
  const bridge = new MeterBridge(() => {}, { port, backendPort: port });
  try { await assert.rejects(bridge.start(), /already in use/); }
  finally { await bridge.stop(); await new Promise(resolve => occupied.close(resolve)); }
});
test('stopping the bridge closes an active client and releases its port', async () => {
  const upstreamSockets = new Set();
  const backend = net.createServer(socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); });
  const backendPort = await listen(backend);
  const bridge = new MeterBridge(() => {}, { port: 0, backendPort });
  let client;
  try {
    await bridge.start();
    client = net.connect(bridge.port, '127.0.0.1');
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const closed = new Promise(resolve => client.once('close', resolve));
    await bridge.stop(); await closed;
    assert.equal(bridge.server.listening, false);
  } finally { client?.destroy(); await bridge.stop(); for (const socket of upstreamSockets) socket.destroy(); await new Promise(resolve => backend.close(resolve)); }
});
