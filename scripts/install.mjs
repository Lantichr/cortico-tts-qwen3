/**
 * 一个把 C++ 侧的启动器与 Node 侧的代理拼成可交付目录的安装器。
 *
 *   node scripts/install.mjs --runtime <目录> [选项]
 *
 * 做的事:编译 launcher/llama-tts-server.c、把代理与启动器复制进运行时目录、写
 * launcher.ini、然后起一次冒烟(上游 health + 一次合成)。运行时目录就是 Cortico 里
 * worlds.vtuber.ttsRuntimeDir 指的那个。
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function required(name, hint) {
  const v = args[name];
  if (typeof v !== 'string' || !v) {
    console.error(`缺 --${name}${hint ? `(${hint})` : ''}`);
    console.error('用法见 docs/deployment.md,或 node scripts/install.mjs --help');
    process.exit(2);
  }
  return v;
}

if (args.help) {
  console.log(readFileSync(join(ROOT, 'docs', 'deployment.md'), 'utf8'));
  process.exit(0);
}

const runtime = resolve(required('runtime', 'Cortico 的 worlds.vtuber.ttsRuntimeDir'));
const serverExe = resolve(required('server-exe', 'qwentts 的 tts-server.exe'));
const talker = resolve(required('talker', 'qwen-talker-*.gguf'));
const codec = resolve(required('codec', 'qwen-tokenizer-*.gguf'));
const voicesDir = resolve(required('voices-dir', '参考音频目录'));
const voice = args.voice ?? 'corhi';
const ttsPort = args['tts-port'] ?? '8080';
const proxyPort = args['proxy-port'] ?? '8010';
const language = args.language ?? 'Chinese';
const alias = args.alias ?? 'qwen3-tts-base';
const nodeExe = args.node ?? process.execPath;
const cudaBin = typeof args['cuda-bin'] === 'string' ? args['cuda-bin'] : '';
const vcvars = typeof args.vcvars === 'string' ? args.vcvars : 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';

for (const [label, p] of [['server-exe', serverExe], ['talker', talker], ['codec', codec]]) {
  if (!existsSync(p)) { console.error(`--${label} 不存在: ${p}`); process.exit(2); }
}
if (!existsSync(voicesDir)) { console.error(`--voices-dir 不存在: ${voicesDir}`); process.exit(2); }

const voiceWav = join(voicesDir, `${voice}.wav`);
const voiceTxt = join(voicesDir, `${voice}.txt`);
if (!existsSync(voiceWav)) {
  console.error(`声线参考音频不存在: ${voiceWav}`);
  console.error(`要么把它放进 ${voicesDir},要么用 --voice 换一个名字。`);
  process.exit(2);
}
if (!existsSync(voiceTxt)) {
  console.warn(`[警告] 没有 ${voice}.txt。缺参考转写时上游只能走纯克隆,音色与语调的保真度会下降。`);
}

mkdirSync(runtime, { recursive: true });

/** 预抽取特征优先取声线库,其次取上一次装好的运行时目录(重装时不必再指一遍)。 */
function findLatent(ext) {
  const explicit = args[ext];
  if (typeof explicit === 'string') {
    if (!existsSync(explicit)) { console.error(`--${ext} 不存在: ${explicit}`); process.exit(2); }
    return resolve(explicit);
  }
  for (const dir of [voicesDir, runtime]) {
    const p = join(dir, `${voice}-24k.${ext}`);
    if (existsSync(p)) return p;
  }
  console.error(`找不到 ${voice}-24k.${ext}。用 qwen-codec.exe 从 24 kHz 单声道参考音频生成,`);
  console.error(`见 docs/deployment.md 第 3 步;也可以用 --spk / --rvq 直接指路径。`);
  process.exit(2);
}

const spk = findLatent('spk');
const rvq = findLatent('rvq');

// ── 编译启动器 ────────────────────────────────────────────────────────────
const launcherExe = join(runtime, 'llama-tts-server.exe');
const obj = join(runtime, 'llama-tts-server.obj');
const src = join(ROOT, 'src', 'launcher', 'llama-tts-server.c');
console.log(`编译启动器 -> ${launcherExe}`);
const cl = `@echo off\r\ncall "${vcvars}" >nul || (echo VCVARS_FAILED & exit /b 1)\r\ncl /nologo /utf-8 /O2 /W3 /Fe:"${launcherExe}" /Fo:"${obj}" "${src}" /link /SUBSYSTEM:CONSOLE\r\nexit /b %errorlevel%\r\n`;
const clCmd = join(runtime, '.build-launcher.cmd');
writeFileSync(clCmd, cl, 'ascii');
try {
  execFileSync('cmd.exe', ['/c', clCmd], { stdio: ['ignore', 'inherit', 'inherit'] });
} catch {
  console.error(`编译失败。vcvars 路径用 --vcvars 指定;当前试的是 ${vcvars}`);
  process.exit(1);
} finally {
  rmSync(clCmd, { force: true });
  rmSync(obj, { force: true });
}

// ── 铺文件与配置 ─────────────────────────────────────────────────────────
copyFileSync(join(ROOT, 'src', 'proxy.mjs'), join(runtime, 'proxy.mjs'));
copyFileSync(spk, join(runtime, `${voice}-24k.spk`));
copyFileSync(rvq, join(runtime, `${voice}-24k.rvq`));

const ini = [
  '# 由 install.mjs 生成;改完重启 TTS 服务生效。',
  `server_exe=${serverExe}`,
  `model=${talker}`,
  `codec=${codec}`,
  `node=${nodeExe}`,
  'proxy=proxy.mjs',
  `proxy_port=${proxyPort}`,
  `tts_port=${ttsPort}`,
  `language=${language}`,
  `alias=${alias}`,
  `cuda_bin=${cudaBin}`,
  `voices_dir=${voicesDir}`,
  `voice=${voice}`,
  '# extra_args 原样追加给上游,用来开它的调优开关,例如 --clamp-fp16 或 --max-batch 2',
  `extra_args=${typeof args['extra-args'] === 'string' ? args['extra-args'] : ''}`,
  '',
].join('\r\n');
writeFileSync(join(runtime, 'launcher.ini'), ini, 'utf8');
console.log(`已写 ${join(runtime, 'launcher.ini')}`);

/* 运行时目录是构建产物:留一张字条,免得有人在这里改源码或不知道为什么有这些文件。 */
writeFileSync(
  join(runtime, 'README.md'),
  [
    '# 这是 cortico-tts-qwen3 装出来的运行时目录',
    '',
    '不要在这里改源码:`proxy.mjs` 与 `llama-tts-server.exe` 每次安装都会被覆盖。',
    '改 `src/` 之后重跑安装器。',
    '',
    '| 文件 | 是什么 |',
    '|---|---|',
    '| `llama-tts-server.exe` | 启动器。Cortico 的 vtuber 扩展按这个文件名拉起服务 |',
    '| `launcher.ini` | 配置。唯一事实来源,改完重启 TTS 服务生效 |',
    '| `proxy.mjs` | 接口翻译代理,监听 `worlds.vtuber.ttsUrl` 的端口 |',
    '| `<voice>-24k.spk` / `.rvq` | 参考音频的预抽取特征 |',
    '',
    'Cortico 侧:`worlds.vtuber.ttsRuntimeDir` 指向本目录,`worlds.vtuber.ttsUrl` 指向代理端口。',
    '',
  ].join('\n'),
  'utf8',
);

// ── 冒烟 ─────────────────────────────────────────────────────────────────
const smoke = spawn(launcherExe, [], { cwd: runtime, stdio: ['ignore', 'ignore', 'pipe'] });
let tail = '';
smoke.stderr.on('data', (c) => { tail = (tail + c.toString()).slice(-2000); });

const deadline = Date.now() + 90_000;
let ok = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  if (smoke.exitCode !== null) break;
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) { ok = true; break; }
  } catch { /* 还没起来 */ }
}

if (ok) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: '安装冒烟,一二三。', response_format: 'wav' }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const sec = buf.length > 44 ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(40, true) / 48000 : 0;
  console.log(`冒烟:HTTP ${res.status}  ${buf.length} 字节  ${sec.toFixed(2)}s 音频  ${Date.now() - t0}ms`);
}

smoke.kill();
await new Promise((r) => setTimeout(r, 1500));

if (!ok) {
  console.error('\n冒烟失败。启动器输出:');
  console.error(tail.trim() || '(无输出)');
  process.exit(1);
}
console.log(`\n装好了。把 Cortico 的 worlds.vtuber.ttsRuntimeDir 指向 ${runtime}`);
console.log(`并把 worlds.vtuber.ttsUrl 指向 http://127.0.0.1:${proxyPort}`);
