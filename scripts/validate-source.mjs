import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }

  return files;
}

function displayPath(path) {
  return relative(ROOT, path) || path;
}

const files = await collectFiles(ROOT);
const javascriptFiles = files.filter((file) => JAVASCRIPT_EXTENSIONS.has(extname(file)));
const jsonFiles = files.filter((file) => extname(file) === '.json');
let failed = false;

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) continue;
  failed = true;
  console.error(`JavaScript syntax check failed: ${displayPath(file)}`);
  if (result.stderr) console.error(result.stderr.trim());
}

for (const file of jsonFiles) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    failed = true;
    console.error(`JSON parse failed: ${displayPath(file)}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failed) process.exit(1);

console.log(`Validated ${javascriptFiles.length} JavaScript files and ${jsonFiles.length} JSON files.`);
