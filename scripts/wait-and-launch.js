// Waits for the Vite dev server to be reachable, compiles the main/preload
// processes, then launches Electron pointed at it. Kept as a small plain-JS
// script (not TypeScript) so it can run directly under Node without a build
// step of its own.
const { spawn } = require('node:child_process');
const waitOn = require('wait-on');
const path = require('node:path');

async function main() {
  await waitOn({ resources: ['http-get://localhost:5173'], timeout: 30000 });

  const tsc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.main.json'], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..')
  });

  tsc.on('exit', (code) => {
    if (code !== 0) {
      process.exit(code ?? 1);
    }

    const electronBinary = require('electron');
    const electron = spawn(electronBinary, ['.'], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development' }
    });

    electron.on('exit', (electronCode) => process.exit(electronCode ?? 0));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
