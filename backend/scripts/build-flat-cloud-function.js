'use strict';

const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(process.argv[2] || '');
const outputDir = path.resolve(process.argv[3] || '');
if (!sourceDir || !outputDir || sourceDir === outputDir) {
  throw new Error('Usage: node build-flat-cloud-function.js <sourceDir> <newOutputDir>');
}
if (path.basename(outputDir).toLowerCase() !== 'api') {
  throw new Error('The output directory must be named api so CloudBase deploys the correct function.');
}
if (fs.existsSync(outputDir)) {
  throw new Error(`Refusing to overwrite existing output directory: ${outputDir}`);
}

const rootFiles = ['index.js', 'app.js', 'package.json'];
const libDir = path.join(sourceDir, 'lib');
const libFiles = fs.readdirSync(libDir).filter((name) => name.endsWith('.js')).sort();
fs.mkdirSync(outputDir, { recursive: true });

for (const name of rootFiles) {
  const source = path.join(sourceDir, name);
  let content = fs.readFileSync(source, 'utf8');
  if (name.endsWith('.js')) {
    content = content.replace(/require\((['"])\.\/lib\/([^'"]+)\1\)/g, "require('./$2')");
  }
  fs.writeFileSync(path.join(outputDir, name), content, 'utf8');
}
for (const name of libFiles) {
  fs.copyFileSync(path.join(libDir, name), path.join(outputDir, name));
}

const outputFiles = fs.readdirSync(outputDir).sort();
for (const name of outputFiles.filter((item) => item.endsWith('.js'))) {
  const content = fs.readFileSync(path.join(outputDir, name), 'utf8');
  if (content.includes("require('./lib/")) {
    throw new Error(`Nested lib require remains in ${name}`);
  }
}
process.stdout.write(`${JSON.stringify({ sourceDir, outputDir, filesCount: outputFiles.length, files: outputFiles })}\n`);

