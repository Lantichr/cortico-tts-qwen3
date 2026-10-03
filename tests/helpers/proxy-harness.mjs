/**
 * 起一个代理进程来测:代理按自身目录找 <声线>-24k.spk/.rvq、按 QWEN_TTS_VOICES_DIR
 * 找参考音频,所以把 src/ 与声线库都拷进一个临时运行时目录再起,仓库里不留临时文件。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const FIXTURES = join(HERE, 'fixtures');
const PROXY_ENTRY = join(SRC, 'proxy.mjs');

/** 装置声线名:与 tests/helpers/fixtures/<name>.wav 及 src/<name>-24k.spk|.rvq 同名 */
export const FIXTURE_VOICE = 'test-voice';

/** 装置用的假参考音频:代理只按内容哈希与 base64 用它,不解码 */
export function fixtureVoiceBytes() {
  return readFileSync(join(FIXTURES, `${FIXTURE_VOICE}.wav`));
}

let portCursor = 0;
/** 每个装置一批端口:不撞同机上别的服务,也不与固定端口约定绑死 */
function nextPort() {
  portCursor += 1;
  return 18800 + (process.pid % 400) + portCursor;
}

/** 起一个代理进程,返回 { baseUrl, log(), stop() } */
export async function startProxy(upstreamOrigin) {
  const runtime = mkdtempSync(join(tmpdir(), 'qwen3-tts-proxy-'));
  const voicesDir = join(runtime, 'voices');
  const scratch = join(runtime, 'src');
  mkdirSync(voicesDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  copyFileSync(PROXY_ENTRY, join(scratch, 'proxy.mjs'));
  copyFileSync(join(FIXTURES, `${FIXTURE_VOICE}.wav`), join(voicesDir, `${FIXTURE_VOICE}.wav`));
  copyFileSync(join(FIXTURES, `${FIXTURE_VOICE}.txt`), join(voicesDir, `${FIXTURE_VOICE}.txt`));
  copyFileSync(join(SRC, `${FIXTURE_VOICE}-24k.spk`), join(scratch, `${FIXTURE_VOICE}-24k.spk`));
  copyFileSync(join(SRC, `${FIXTURE_VOICE}-24k.rvq`), join(scratch, `${FIXTURE_VOICE}-24k.rvq`));

  const port = nextPort();
  const child = spawn(process.execPath, [join(scratch, 'proxy.mjs')], {
    cwd: scratch,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QWEN_TTS_URL: upstreamOrigin,
      QWEN_TTS_PROXY_PORT: String(port),
      QWEN_TTS_VOICES_DIR: voicesDir,
      QWEN_TTS_VOICE: FIXTURE_VOICE,
    },
  });

  let log = '';
  child.stdout.on('data', (c) => { log += c.toString(); });
  child.stderr.on('data', (c) => { log += c.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  // 就绪只看代理自己那句监听日志:上游可以是死的,那时 /health 按设计回 503
  const deadline = Date.now() + 10_000;
  while (!log.includes('代理已监听')) {
    if (child.exitCode !== null) throw new Error(`代理提前退出(${child.exitCode}):\n${log}`);
    if (Date.now() > deadline) throw new Error(`代理 10 秒没起监听:\n${log}`);
    await new Promise((r) => setTimeout(r, 25));
  }

  let stopped = false;
  return {
    baseUrl,
    /** 代理进程的输出,排查时看它 */
    log: () => log,
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      await new Promise((r) => setTimeout(r, 100));
      rmSync(runtime, { recursive: true, force: true });
    },
  };
}

/** 给代理发一个 JSON POST */
export async function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/** 读 WAV 头里的 data 长度与采样率,用例用它验流式补头 */
export function readWavHeader(buf) {
  return {
    riff: buf.subarray(0, 4).toString(),
    wave: buf.subarray(8, 12).toString(),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bitsPerSample: buf.readUInt16LE(34),
    dataLength: buf.readUInt32LE(40),
  };
}

/**
 * 整段合成的音频时长(秒)。流式答复的头里 data 长度写 0,所以按整块长度减去头算;
 * 流式超过 4 GiB 才需要再拆块,不在用例范围内。
 */
export function wavSeconds(buf) {
  const { sampleRate, bitsPerSample, channels, dataLength } = readWavHeader(buf);
  const bytesPerSecond = (sampleRate * bitsPerSample * channels) / 8;
  const data = dataLength > 0 ? dataLength : buf.length - 44;
  return data / bytesPerSecond;
}
