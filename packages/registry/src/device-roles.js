const storageRole = Object.freeze({
  role_id: 'PIXEL-STORAGE-01',
  display_name: 'Storage',
  owning_department: 'Infrastructure / HomeLab',
  purpose: 'Authoritative storage role',
  adapter_contract: 'pixel.device.adapter.v1',
});

export const DEVICE_ROLES = Object.freeze({
  [storageRole.role_id]: storageRole,
});

export function getDeviceRole(roleId) {
  const role = DEVICE_ROLES[roleId];
  if (!role) {
    throw new RangeError(`Unknown Pixel device role: ${roleId}`);
  }
  return role;
}
