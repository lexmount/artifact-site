// One authored reference tree supplies npx skills, npm, release assets and the legacy full guide.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'skills/artifact-site');
const topics = JSON.parse(readFileSync(path.join(skill, 'topics.json'), 'utf8'));
const files = ['SKILL.md', 'topics.json', ...topics.map(t => `references/${t.id}.md`)];
const hash = text => createHash('sha256').update(text).digest('hex');
const rows = files.sort().map(file => ({ file, content: readFileSync(path.join(skill, file)), sha256: hash(readFileSync(path.join(skill, file))) }));
const version = hash(rows.map(r => `${r.file}\0${r.sha256}\n`).join(''));
const releaseAt = process.argv.indexOf('--release');
// The production server build excludes the CLI directory and only checks authored references.
let manifest;
if (process.argv.includes('--npm') || releaseAt >= 0) {
  const release = releaseAt < 0 ? `v${JSON.parse(readFileSync(path.join(root, 'cli/package.json'), 'utf8')).version}` : process.argv[releaseAt + 1];
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release)) throw new Error('Invalid release tag');
  manifest = `format\t1\nrelease\t${release}\nversion\t${version}\n` + rows.map(r => `file\t${r.sha256}\t${r.file}\n`).join('');
}
const frontmatter = '---\nname: publish-to-artifact-site\ndescription: Publish and manage work on Yours (artifact-site). Complete compatibility reference generated from the installable skill.\n---\n\n';
const full = frontmatter + topics.map(t => readFileSync(path.join(skill, `references/${t.id}.md`), 'utf8').trim()).join('\n\n') + '\n';
const fullPath = path.join(root, 'src/content/publish-skill.md');
if (process.argv.includes('--check')) {
  // CLI distributions can ship ahead of a deployment's server documentation.
  if (!process.argv.includes('--distribution-only') && readFileSync(fullPath, 'utf8') !== full) throw new Error('Run npm run generate:skill to regenerate the full reference');
  for (const name of readdirSync(path.join(skill, 'references'))) {
    if (!files.includes(`references/${name}`)) throw new Error(`Unindexed reference: ${name}`);
  }
} else if (!process.argv.includes('--distribution-only')) {
  writeFileSync(fullPath, full);
}
if (process.argv.includes('--npm')) {
  const dest = path.join(root, 'cli/skill');
  rmSync(dest, { recursive: true, force: true });
  for (const row of rows) { mkdirSync(path.dirname(path.join(dest, row.file)), { recursive: true }); writeFileSync(path.join(dest, row.file), row.content); }
  writeFileSync(path.join(dest, 'manifest.tsv'), manifest);
}
if (releaseAt >= 0) {
  const dest = path.join(root, 'dist-skill');
  rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'skill-manifest.tsv'), manifest);
  for (const row of rows) writeFileSync(path.join(dest, 'skill--' + row.file.replaceAll('/', '--')), row.content);
  writeFileSync(path.join(dest, 'install.sh'), readFileSync(path.join(root, 'scripts/install-skill.sh')));
}
