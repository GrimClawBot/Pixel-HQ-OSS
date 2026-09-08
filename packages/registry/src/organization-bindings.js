import { readFileSync } from 'node:fs';

const PUBLIC_FIXTURE = Object.freeze({
  registry_id: 'pixel.organization-registry',
  schema_version: '0.1.0',
  classification: 'synthetic-public',
  source: 'pixel.public-registry.fixture.v1',
});
const ORGANIZATION_REGISTRY = JSON.parse(readFileSync(
  new URL('../data/organization-registry-v0.1.json', import.meta.url),
  'utf8',
));

function fail() {
  throw new RangeError('Organization Registry Systems binding is unavailable');
}

export function getSystemsJobBinding(registry = ORGANIZATION_REGISTRY) {
  if (
    !registry
    || registry.registry_id !== PUBLIC_FIXTURE.registry_id
    || registry.schema_version !== PUBLIC_FIXTURE.schema_version
    || registry.provenance?.classification !== PUBLIC_FIXTURE.classification
    || registry.provenance?.source !== PUBLIC_FIXTURE.source
    || !Array.isArray(registry.departments)
  ) return fail();
  for (const candidate of registry.departments) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail();
  }
  const department = registry.departments.find((candidate) => (
    candidate.department_ref === 'Infrastructure / HomeLab'
  ));
  if (!department || !Array.isArray(department.roles) || !department.roles.includes('Systems')) return fail();
  return Object.freeze({ department_ref: department.department_ref, role_ref: 'Systems' });
}
