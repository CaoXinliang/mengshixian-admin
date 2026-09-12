'use strict';

const { spawnSync } = require('child_process');

const [, , runtimeNode, cliEntry, envId] = process.argv;
if (!runtimeNode || !cliEntry || !envId) {
  process.stderr.write('Usage: node tcb-nosql-execute.js <node> <tcb-cli> <env>\n');
  process.exit(2);
}

let command = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { command += chunk; });
process.stdin.on('end', () => {
  command = command.trim();
  try {
    const parsed = JSON.parse(command);
    if (!Array.isArray(parsed)) throw new Error('command must be a JSON array');
  } catch (error) {
    process.stderr.write(`Invalid MgoCommands JSON: ${error.message}\n`);
    process.exit(2);
  }

  const result = spawnSync(runtimeNode, [cliEntry, 'db', 'nosql', 'execute', '-e', envId, '-c', command, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
});

