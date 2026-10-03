/**
 * 代理与上游之间的契约:流式补 WAV 头、非流式原样透传、只发 qwentts 认识的字段、
 * 上游不可达与没有对齐模型时的答复、上游重启后声线注册的恢复。
 *
 * 上游是假的:这里断言代理发出的请求与它对答复的加工,不涉及合成质量。
 * 每个用例都限时,挂住时报一条失败而不是把整轮测试拖死。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_BYTES, startFakeTts, wavHeader } from './helpers/fake-upstream.mjs';
import { post, startProxy } from './helpers/proxy-harness.mjs';

const CASE_TIMEOUT_MS = 15_000;

describe('代理的接口翻译', () => {
  let upstream;
  let proxy;

  before(async () => {
    upstream = await startFakeTts();
    proxy = await startProxy(upstream.origin);
  });

  after(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  /** 扩展先读 44 字节头取采样率,所以流式必须补头;长度未知写 0 */
  it('流式答复带 44 字节 WAV 头,采样率 24000', { timeout: CASE_TIMEOUT_MS }, async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech/stream', { input: '流式' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 44 + CHUNK_BYTES, '头 + 上游 PCM');
    assert.deepEqual(buf.subarray(0, 44), wavHeader(0));
    assert.equal(buf.readUInt32LE(24), 24000, '采样率');
    assert.equal(buf.readUInt16LE(22), 1, '声道数');
    assert.equal(buf.readUInt16LE(34), 16, '位深');
    assert.equal(buf.readUInt32LE(40), 0, '流式长度写 0');
    assert.ok(buf.subarray(44).every((b) => b === 0x11), '头之后是上游的 PCM');
    assert.equal(upstream.at('/v1/audio/speech').at(-1).body.response_format, 'pcm');
  });

  it('非流式原样回上游的 WAV 字节', { timeout: CASE_TIMEOUT_MS }, async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech', { input: '整段' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 44 + CHUNK_BYTES);
    assert.ok(buf.subarray(44).every((b) => b === 0x22));
    assert.equal(upstream.at('/v1/audio/speech').at(-1).body.response_format, 'wav');
  });

  /** VoxCPM2 专有字段面板上还留着,但在这个后端上不起作用 */
  it('只转发 qwentts 认识的字段', { timeout: CASE_TIMEOUT_MS }, async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech', {
      input: '字段',
      seed: 42,
      temperature: 1,
      top_k: 20,
      top_p: 0.8,
      repetition_penalty: 1.1,
      max_new_tokens: 200,
      cfg_value: 2,
      inference_timesteps: 9,
      max_steps: 200,
      prompt_text: '参考转写',
      instructions: '用开心的语气',
    });
    assert.equal(res.status, 200);
    const body = upstream.at('/v1/audio/speech').at(-1).body;
    assert.deepEqual(Object.keys(body).sort(), [
      'input',
      'language',
      'max_new_tokens',
      'repetition_penalty',
      'response_format',
      'seed',
      'temperature',
      'top_k',
      'top_p',
      'voice',
    ]);
    assert.equal(body.seed, 42);
    assert.equal(body.max_new_tokens, 200);
    assert.equal(body.voice, 'test-voice');
  });

  it('language 缺省时用代理的默认语言', { timeout: CASE_TIMEOUT_MS }, async () => {
    await post(proxy.baseUrl, '/v1/audio/speech', { input: '缺省语言' });
    assert.equal(upstream.at('/v1/audio/speech').at(-1).body.language, 'Chinese');
  });

  /** 没有强制对齐模型:扩展据此把片内动作退回按字符比例估计 */
  it('/v1/audio/align 固定回 501,不转给上游', { timeout: CASE_TIMEOUT_MS }, async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/align', { input: '对齐' });
    assert.equal(res.status, 501);
    assert.deepEqual(upstream.at('/v1/audio/align'), []);
  });

  it('别的路由回 404', { timeout: CASE_TIMEOUT_MS }, async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/nothing', {});
    assert.equal(res.status, 404);
  });

  it('body 不是 JSON 时回 400', { timeout: CASE_TIMEOUT_MS }, async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(res.status, 400);
  });

  it('上游的错误状态与正文原样回给扩展', { timeout: CASE_TIMEOUT_MS }, async () => {
    const broken = await startFakeTts({
      '/v1/audio/speech': (req, res) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('GGML_ASSERT: pool_used');
      },
    });
    const withBroken = await startProxy(broken.origin);
    try {
      const res = await post(withBroken.baseUrl, '/v1/audio/speech', { input: '上游炸了' });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.match(body.error.message, /GGML_ASSERT/);
    } finally {
      await withBroken.stop();
      await broken.close();
    }
  });

  /**
   * 上游重启后注册表空了,而代理还记着"已注册":一次失败的合成要让它放掉这份缓存,
   * 下一次请求自己重新注册。
   */
  it('上游合成失败后下一次请求重新注册声线', { timeout: CASE_TIMEOUT_MS }, async () => {
    let failFirst = true;
    const flaky = await startFakeTts({
      '/v1/audio/speech': (req, res) => {
        if (failFirst) {
          failFirst = false;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unknown speaker test-voice' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wavHeader(CHUNK_BYTES));
      },
    });
    const retrying = await startProxy(flaky.origin);
    try {
      const first = await post(retrying.baseUrl, '/v1/audio/speech', { input: '第一次' });
      assert.equal(first.status, 500, '上游拒收该声线');
      // 上游的内存注册表随着重启消失:代理那边的缓存此刻与上游不一致
      flaky.voices.clear();
      const second = await post(retrying.baseUrl, '/v1/audio/speech', { input: '第二次' });
      assert.equal(second.status, 200, '放掉缓存后应重新注册并成功');
      const registrations = flaky.at('/v1/audio/voices').filter((c) => c.method === 'POST');
      assert.equal(registrations.length, 2, '两次注册:首次合成一次,失败后重来一次');
    } finally {
      await retrying.stop();
      await flaky.close();
    }
  });

  /** undici 的 fetch 失败只给 'fetch failed',够不着的地址看不到,所以只断言状态与有正文 */
  it('上游不可达时回 502', { timeout: CASE_TIMEOUT_MS }, async () => {
    const lonely = await startProxy('http://127.0.0.1:1');
    try {
      const res = await post(lonely.baseUrl, '/v1/audio/speech', { input: '没人接' });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(typeof body.error.message, 'string');
      assert.ok(body.error.message.length > 0, '正文要说一句失败原因');
    } finally {
      await lonely.stop();
    }
  });
});
