/**
 * Qwen3-TTS 对接代理:把 Cortico vtuber 扩展的 VoxCPM2 形状请求,翻译给 qwentts.cpp 的
 * tts-server。它是扩展与上游之间唯一的那层,上游地址与声线配置由启动器经环境变量注入。
 *
 * 三处接口差异在这里抹平:
 *  1. 流式:扩展要 chunked WAV(它先读 44 字节头取采样率),而 qwentts 的流式只吐裸 PCM
 *     ——补一个头再原样转发。
 *  2. 声线:扩展每次请求都带 reference_audio(base64)+ prompt_text,而 qwentts 是注册制。
 *     按参考音频内容哈希注册成一条声线并缓存,同一份音频只抽取一次。
 *  3. 字段:扩展会发 cfg_value / inference_timesteps / max_steps 这类 VoxCPM2 专有字段,
 *     只挑 qwentts 认识的转发,免得它拒收。
 *
 * 上游不可达时返回 502,让扩展按自己的重试逻辑处理。对齐路由固定 501:这个后端没有
 * 强制对齐模型,扩展据此把片内动作退回按字符比例估计。
 *
 * 环境变量(启动器会设好;手工跑时可用默认值):
 *   QWEN_TTS_URL          上游地址,默认 http://127.0.0.1:8080
 *   QWEN_TTS_PROXY_PORT   监听端口,默认 8010(要和 worlds.vtuber.ttsUrl 的端口一致)
 *   QWEN_TTS_VOICES_DIR   参考音频目录,默认 <本目录>/voices
 *   QWEN_TTS_VOICE        默认声线的名字,默认 corhi
 *   QWEN_TTS_LANG         语言提示,默认 Chinese
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.QWEN_TTS_PROXY_PORT ?? 8010);
const UPSTREAM = (process.env.QWEN_TTS_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const LANGUAGE = process.env.QWEN_TTS_LANG ?? 'Chinese';
const VOICE = process.env.QWEN_TTS_VOICE ?? 'corhi';
const VOICES_DIR = process.env.QWEN_TTS_VOICES_DIR ?? join(HERE, 'voices');

/**
 * 部署声明的那条声线:参考音频取声线库里的同名 wav,特征取本目录预抽取的 .spk/.rvq,
 * 转写取声线库里的同名 .txt。走这条就不必每次重启重新抽取参考音频。
 * 带上转写才是 ICL 克隆(音色与语调都跟参考走);没有转写只能退到纯克隆。
 */
const DEFAULT_VOICE = {
  name: VOICE,
  wav: join(VOICES_DIR, `${VOICE}.wav`),
  spk: join(HERE, `${VOICE}-24k.spk`),
  rvq: join(HERE, `${VOICE}-24k.rvq`),
  refText: join(VOICES_DIR, `${VOICE}.txt`),
};

/** qwentts 认的采样参数;其余字段一律丢掉 */
const PASSTHROUGH = ['seed', 'temperature', 'top_k', 'top_p', 'repetition_penalty', 'max_new_tokens'];

const hashOf = (b64) => createHash('sha1').update(b64).digest('hex').slice(0, 8);
/** 默认参考音频的内容哈希:扩展送来的 reference_audio 与它相等就走部署声明的那条声线 */
const defaultRefHash = hashOf(readFileSync(DEFAULT_VOICE.wav).toString('base64'));
/** 声线名 → 注册 promise;同一个名字的并发请求合流到一次注册 */
const registered = new Map();

async function register(name, payload) {
  registered.set(
    name,
    (async () => {
      const res = await fetch(`${UPSTREAM}/v1/audio/voices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ name, ...payload }),
      });
      const detail = (await res.text()).trim();
      if (!res.ok) throw new Error(`注册声线「${name}」失败 HTTP ${res.status} ${detail.slice(0, 160)}`);
      console.log(`已注册声线「${name}」:${detail.slice(0, 120)}`);
    })().catch((err) => {
      registered.delete(name);
      throw err;
    }),
  );
  return registered.get(name);
}

/** 上游注册表在内存里,服务一重启就空:先问一次,已在就免了重新抽取。 */
async function isRegistered(name) {
  try {
    const list = await (await fetch(`${UPSTREAM}/v1/audio/voices`)).json();
    return Array.isArray(list.voices) && list.voices.some((v) => v?.name === name);
  } catch {
    return false;
  }
}

/** 声线库里按字节比对找回是哪一份参考音频,再取它的同名 .txt 当转写。 */
function transcriptFor(b64) {
  let raw;
  try {
    raw = Buffer.from(b64, 'base64');
  } catch {
    return '';
  }
  let files;
  try {
    files = readdirSync(VOICES_DIR);
  } catch {
    return '';
  }
  for (const file of files) {
    if (!/\.wav$/i.test(file)) continue;
    try {
      if (!readFileSync(join(VOICES_DIR, file)).equals(raw)) continue;
      return readFileSync(join(VOICES_DIR, file.replace(/\.wav$/i, '.txt')), 'utf8').trim();
    } catch {
      /* 没有同名 txt,或读不动 */
    }
  }
  return '';
}

async function voiceFor(incoming) {
  const b64 = typeof incoming.reference_audio === 'string' ? incoming.reference_audio : '';
  const prompt = typeof incoming.prompt_text === 'string' ? incoming.prompt_text.trim() : '';

  // 没带参考音频,或带的正是部署声明那份:用预抽取的声线
  const useDefault = b64.length === 0 || hashOf(b64) === defaultRefHash;
  const name = useDefault ? DEFAULT_VOICE.name : `ref-${hashOf(b64)}`;

  if (registered.has(name) || (await isRegistered(name))) {
    registered.set(name, Promise.resolve());
    return name;
  }

  const payload = useDefault
    ? {
        ref_text: readFileSync(DEFAULT_VOICE.refText, 'utf8').trim(),
        spk_b64: readFileSync(DEFAULT_VOICE.spk).toString('base64'),
        rvq_b64: readFileSync(DEFAULT_VOICE.rvq).toString('base64'),
      }
    : { ref_text: prompt || transcriptFor(b64), wav_b64: b64 };

  await register(name, payload);
  return name;
}

/** 上游固定 24 kHz 单声道 16 bit。流式时长度未知,写 0——扩展只用采样率那个字段。 */
function wavHeader(dataLength) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(24000 * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLength, 40);
  return h;
}

function buildUpstreamBody(incoming, voice, stream) {
  const body = {
    input: incoming.input,
    voice,
    language: typeof incoming.language === 'string' && incoming.language ? incoming.language : LANGUAGE,
    response_format: stream ? 'pcm' : 'wav',
  };
  for (const key of PASSTHROUGH) {
    if (incoming[key] !== undefined && incoming[key] !== null) body[key] = incoming[key];
  }
  return body;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fail(res, code, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { message } }));
}

createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];

  // 扩展的 health 轮询:上游活着就算健康
  if (path === '/health') {
    try {
      const up = await fetch(`${UPSTREAM}/health`);
      res.writeHead(up.status, { 'content-type': 'application/json' });
      res.end(await up.text());
    } catch (err) {
      fail(res, 503, `上游不可达:${err.message}`);
    }
    return;
  }

  // 后端没有强制对齐模型:明确拒绝,让扩展回落到按比例估计
  if (path === '/v1/audio/align') {
    fail(res, 501, 'aligner not available (qwen3-tts backend)');
    return;
  }

  if (path !== '/v1/audio/speech' && path !== '/v1/audio/speech/stream') {
    fail(res, 404, `no route ${path}`);
    return;
  }

  const streaming = path.endsWith('/stream');
  let incoming;
  try {
    incoming = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    fail(res, 400, 'body is not valid JSON');
    return;
  }

  // 扩展探流式能力时打的就是空 body:就地回 400,别让它每 30 秒白跑一次上游。
  // 回 400 而非 404 才能被认成「路由在」。
  if (typeof incoming.input !== 'string' || incoming.input.length === 0) {
    fail(res, 400, 'input is empty');
    return;
  }

  let voice;
  try {
    voice = await voiceFor(incoming);
  } catch (err) {
    fail(res, 502, String(err.message ?? err));
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildUpstreamBody(incoming, voice, streaming)),
    });
  } catch (err) {
    fail(res, 502, `上游不可达:${err.message}`);
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    // 上游可能刚重启过,注册表没了:放掉缓存,下一次请求重新注册
    if (/voice|speaker/i.test(detail)) registered.delete(voice);
    fail(res, upstream.status || 502, `上游 ${upstream.status}:${detail.slice(0, 200)}`);
    return;
  }

  if (!streaming) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(buf.length) });
    res.end(buf);
    return;
  }

  // 流式:先补 WAV 头,再把上游的 PCM 边收边转,不缓冲整段
  res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
  res.write(wavHeader(0));
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error(`流式转发中断:${err.message}`);
  }
  res.end();
}).listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`Qwen3-TTS 代理已监听 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM}`);
  console.log(`  默认声线「${DEFAULT_VOICE.name}」(${DEFAULT_VOICE.wav})  语言 ${LANGUAGE}`);
  console.log(`  声线库 ${VOICES_DIR}`);
});
