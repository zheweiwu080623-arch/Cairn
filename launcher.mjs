import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3210);
const URL = `http://localhost:${PORT}`;

// 显示名与本机品牌一致（data/brand.json → 默认 Cairn）
const __dir = dirname(fileURLToPath(import.meta.url));
function appName() {
  try {
    if (process.env.PLANNER_APP_NAME) return process.env.PLANNER_APP_NAME;
    const raw = readFileSync(join(__dir, 'data', 'brand.json'), 'utf8');
    const name = JSON.parse(raw).app_name;
    if (name && String(name).trim()) return String(name).trim();
  } catch { /* 没有就用默认 */ }
  return 'Cairn';
}

console.log(`正在启动 ${appName()} 桌面端…`);

async function waitFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ping() {
  try {
    const res = await fetch(`${URL}/api/state`);
    return res.ok;
  } catch {
    return false;
  }
}

let server = null;
async function ensureServer() {
  if (await ping()) { console.log('  服务已在运行，复用现有实例。'); return; }
  server = spawn(process.execPath, ['server.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT) },
  });
  server.on('error', (e) => { console.error('启动服务失败：', e.message); process.exit(1); });
  process.on('SIGINT', () => { server.kill(); process.exit(0); });
  process.on('SIGTERM', () => { server.kill(); process.exit(0); });
  for (let i = 0; i < 40; i++) { if (await ping()) break; await waitFor(250); }
}

async function openApp() {
  if (process.env.OPEN_BROWSER === '0') {
    console.log(`  打开浏览器访问：${URL}`);
    return;
  }
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'microsoft-edge',
  ];
  let opened = false;
  if (process.platform === 'win32') {
    for (const e of edgeCandidates) {
      if (existsSync(e)) {
        spawn(e, [`--app=${URL}`, '--new-window'], { detached: true, stdio: 'ignore' }).unref();
        opened = true;
        break;
      }
    }
  }
  if (!opened) {
    const cmd = process.platform === 'win32' ? `start "" "${URL}"`
      : process.platform === 'darwin' ? `open "${URL}"` : `xdg-open "${URL}"`;
    exec(cmd);
  }
  console.log(`  已在桌面窗口打开：${URL}`);
}

await ensureServer();
await openApp();
