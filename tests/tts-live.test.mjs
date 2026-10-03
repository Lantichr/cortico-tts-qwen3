/**
 * 对一台跑着的部署做端到端核对:剥标记确实发生在这个后端上、中文方括号确实原样送进
 * 上游、标记不再被念成英文单词。
 *
 * 需要 Qwen3-TTS 服务真的在跑(default 打 worlds.vtuber.ttsUrl)。没在跑就整组跳过,
 * 所以它不挡离线跑用例。这里只用短句,单次请求约 1–2 秒。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { post, wavSeconds } from './helpers/proxy-harness.mjs';

const TARGET = process.env.CORTICO_TTS_URL ?? 'http://127.0.0.1:8010';
const CASE_TIMEOUT_MS = 30_000;

/** 服务不在就跳过:用例的价值在于对着真后端跑,而不在于原地失败 */
async function reachable() {
  try {
    const res = await fetch(`${TARGET}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const live = await reachable();
const options = live
  ? { timeout: CASE_TIMEOUT_MS }
  : { skip: `Qwen3-TTS 服务没在跑(${TARGET});先起服务或设 CORTICO_TTS_URL` };

/** 合一句,返回 { status, seconds } */
async function synth(input) {
  const res = await post(TARGET, '/v1/audio/speech', { input });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, seconds: res.status === 200 ? wavSeconds(buf) : 0 };
}

describe(`对真后端的语音链路(${TARGET})`, () => {
  it('只有标记的段是失败段', options, async () => {
    const res = await post(TARGET, '/v1/audio/speech/stream', { input: '[sigh]' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /voice tags/);
  });

  it('中文方括号原样送给上游,能被合成', options, async () => {
    const res = await synth('[笑]这是一句测试。');
    assert.equal(res.status, 200);
    assert.ok(res.seconds > 0.2, `应合成出音频,实际 ${res.seconds.toFixed(2)}s`);
  });

  /** 标记被剥掉后,标记不再变成念出来的英文单词:两句的音频时长接近 */
  it('带标记与不带标记的同一句话,音频时长接近', options, async () => {
    const plain = await synth('今天天气不错。');
    const tagged = await synth('[laughing] 今天天气不错。[sigh]');
    assert.equal(plain.status, 200);
    assert.equal(tagged.status, 200);
    const delta = Math.abs(tagged.seconds - plain.seconds);
    const tol = Math.max(0.35, plain.seconds * 0.15);
    assert.ok(
      delta <= tol,
      `差 ${delta.toFixed(2)}s 超出容差 ${tol.toFixed(2)}s:标记可能被念出来了(${plain.seconds.toFixed(2)}s vs ${tagged.seconds.toFixed(2)}s)`,
    );
  });

  it('这个后端没有对齐模型,/v1/audio/align 回 501', options, async () => {
    const res = await post(TARGET, '/v1/audio/align', { input: '对齐' });
    assert.equal(res.status, 501);
  });
});
