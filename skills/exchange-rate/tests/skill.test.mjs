import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('Skill metadata matches its canonical folder and size limits', async () => {
  const source = await readFile(join(ROOT, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/u.exec(source);
  assert.ok(frontmatter);
  assert.equal(frontmatter[1], basename(ROOT));
  assert.match(frontmatter[1], /^[a-z0-9-]{1,64}$/);
  assert.ok([...frontmatter[2]].length <= 1024);
  assert.ok(source.split('\n').length < 500);
});

test('all local script imports and Skill reference files are self-contained', async () => {
  const files = await readdir(join(ROOT, 'scripts'), { recursive: true });
  for (const file of files.filter(file => file.endsWith('.mjs'))) {
    const path = join(ROOT, 'scripts', file);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/from ['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `unexpected dependency: ${specifier}`);
      const imported = resolve(path, '..', specifier);
      assert.ok(!relative(ROOT, imported).startsWith('..'), `${file} imports outside the Skill`);
      await readFile(imported);
    }
  }
  await readFile(join(ROOT, 'references/pingan-api.md'));
});

test('realistic eval prompts are present and have unique IDs', async () => {
  const evals = JSON.parse(await readFile(join(ROOT, 'evals/evals.json'), 'utf8'));
  assert.equal(evals.skill_name, 'exchange-rate');
  assert.equal(evals.evals.length, 3);
  assert.equal(new Set(evals.evals.map(entry => entry.id)).size, 3);
  assert.ok(evals.evals.every(entry => entry.prompt && entry.expected_output));
});
