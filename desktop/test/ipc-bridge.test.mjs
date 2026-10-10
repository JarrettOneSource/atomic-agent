import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { IpcBridge } = require('../out/main/ipc-bridge.js');

test('both transports invoke the same application handler with the supplied sender', async () => {
  const nativeCalls = new Map();
  const bridge = new IpcBridge({ handle: (name, fn) => nativeCalls.set(name, fn), on() {} });
  bridge.handle('agent:read', async (event, value) => ({ sender: event.sender.id, value }));
  assert.deepEqual(await nativeCalls.get('agent:read')({ sender: { id: 1 } }, 'native'), { sender: 1, value: 'native' });
  assert.deepEqual(await bridge.invoke('agent:read', ['browser'], { id: 2 }), { sender: 2, value: 'browser' });
  await assert.rejects(bridge.invoke('not-registered', [], { id: 2 }), /Unknown application method/);
});

test('one-way and synchronous messages retain the application contract', () => {
  const bridge = new IpcBridge({ handle() {}, on() {} });
  let queue = [];
  bridge.on('app:keep', (_event, value) => { queue = value; });
  bridge.on('app:take', (event) => { event.returnValue = queue; queue = []; });
  bridge.send('app:keep', [['pending']], { id: 1 });
  assert.deepEqual(bridge.send('app:take', [], { id: 1 }), ['pending']);
  assert.deepEqual(bridge.send('app:take', [], { id: 1 }), []);
  assert.throws(() => bridge.send('not-registered', [], { id: 1 }), /Unknown application message/);
});
