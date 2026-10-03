/**
 * 契约用例共用的假 qwentts 上游:health、声线的注册与列表、合成。每个用例的装置都从
 * 它起一个,记下收到的每一次请求。
 *
 * 真上游要 qwentts 的 exe、GGUF 权重与 CUDA,这里要的只是代理发出的请求与对答复的加工。
 */
import { createServer } from 'node:http';

/** 假上游对一个 16 bit 单声道 24 kHz 的 PCM 块回多少字节 */
export const CHUNK_BYTES = 4800;

/** 44 字节的 24 kHz 单声道 16 bit WAV 头;流式时长度未知,写 0 */
export function wavHeader(dataLength = 0) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLength, 40);
  return h;
}

/**
 * 起一个假上游。routes 给同名路径一个 (req, res, body) 处理函数,没给的路由回 404。
 * 每次请求的 body 都记进 calls。
 */
export async function startFakeTts(overrides = {}) {
  const calls = [];
  const voices = new Set();

  const routes = {
    '/health': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    },
    '/v1/audio/voices': (req, res, body) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ voices: [...voices].map((name) => ({ name })) }));
        return;
      }
      voices.add(body?.name);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: body?.name }));
    },
    '/v1/audio/speech': (req, res, body) => {
      if (body?.response_format === 'pcm') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(CHUNK_BYTES, 0x11));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.concat([wavHeader(CHUNK_BYTES), Buffer.alloc(CHUNK_BYTES, 0x22)]));
    },
    ...overrides,
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      calls.push({ method: req.method, path, body, raw });
      const handler = routes[path];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `fake upstream: no route ${path}` } }));
        return;
      }
      handler(req, res, body);
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    /** 上游收到的请求,按顺序 */
    calls,
    /** 某个路由收到的请求 */
    at: (path) => calls.filter((c) => c.path === path),
    /** 上游收到过哪些合成的 input */
    inputs: () => calls.filter((c) => c.path === '/v1/audio/speech').map((c) => c.body?.input),
    /** 已注册的声线名 */
    voices,
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}
