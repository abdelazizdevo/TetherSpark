const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function walk(directory) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, file.name);
    if (file.isDirectory()) walk(full);
    else if (/\.(cjs|js)$/.test(full)) execFileSync(process.execPath, ['--check', full], { stdio: 'inherit' });
  }
}
for (const directory of ['src', 'scripts', 'tests']) walk(path.resolve(__dirname, '..', directory));
console.log('All JavaScript syntax checks passed.');
