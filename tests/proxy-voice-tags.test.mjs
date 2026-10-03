/**
 * 语气词标记的契约:只有标记的段是失败段(400 且不碰上游),标记与正文同在时标记被剥掉,
 * 形状不像标记的方括号原样保留。
 *
 * 上游是假的:装置不装 qwentts、不带权重,断言的是代理转发前对 input 做了什么。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTts } from './helpers/fake-upstream.mjs';
import { post, startProxy } from './helpers/proxy-harness.mjs';

describe('代理的语气词标记处理', () => {
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

  /** 剥空即失败段:回 400,且代理不与上游说话 */
  it('input 只有标记时回 400,不请求上游', async () => {
    const before = upstream.at('/v1/audio/speech').length;
    for (const input of ['[sigh]', '[laughing]', '[Question-ah]', '[sigh] [laughing]']) {
      const res = await post(proxy.baseUrl, '/v1/audio/speech', { input });
      const body = await res.json();
      assert.equal(res.status, 400, `${input} 应为 400:${JSON.stringify(body)}`);
      assert.equal(body.error.message, 'input is empty after removing voice tags');
    }
    assert.equal(
      upstream.at('/v1/audio/speech').length,
      before,
      '只有标记的段不该打到上游',
    );
  });

  it('input 为空串时回 400(扩展探流式路由走的就是这条)', async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech/stream', { input: '' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.message, 'input is empty');
  });

  /** 带正文时标记被剥掉,空出来的连续空格收成一个 */
  it('标记与正文同在时剥掉标记,正文原样转发', async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech', {
      input: '[laughing] 今天天气不错 [sigh] 你说呢',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.inputs().at(-1), '今天天气不错 你说呢');
  });

  /** 标记前后粘着正文、以及全是英文短句的边界 */
  it('标记紧贴正文时不吞字', async () => {
    const cases = [
      ['你好[laughing]呀', '你好呀'],
      ['[breath]嗯', '嗯'],
      ['Uhm[sigh]', 'Uhm'],
    ];
    for (const [input, expected] of cases) {
      const res = await post(proxy.baseUrl, '/v1/audio/speech', { input });
      assert.equal(res.status, 200, `${input} 应为 200`);
      assert.deepEqual(upstream.inputs().at(-1), expected, `${input} 的转发文本`);
    }
  });

  /** 正则只认 ASCII 词:中文方括号与中文正文都不动 */
  it('中文方括号按正文保留', async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech', { input: '[笑]' });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.inputs().at(-1), '[笑]');
  });

  it('中文正文里的方括号不被当成标记', async () => {
    const input = '他说[这里要笑]然后就笑了';
    const res = await post(proxy.baseUrl, '/v1/audio/speech', { input });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.inputs().at(-1), input);
  });

  /** 形状与词表两道门:表外英文方括号也被剥(扩展本来就不会放行这类) */
  it('形状像标记的英文方括号一律剥掉', async () => {
    const res = await post(proxy.baseUrl, '/v1/audio/speech', { input: '[not-a-real-tag] 正文' });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.inputs().at(-1), '正文');
  });
});
