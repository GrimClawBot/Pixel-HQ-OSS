import { assertValidDeviceSnapshotV1 } from '../../contracts/src/device-snapshot-v1.js';

export function assertDeviceAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.readSnapshot !== 'function') {
    throw new TypeError('A Pixel device adapter must implement readSnapshot(request)');
  }
  return adapter;
}

export async function readDeviceSnapshot(adapter, request) {
  assertDeviceAdapter(adapter);
  const event = await adapter.readSnapshot(request);
  return assertValidDeviceSnapshotV1(event);
}
