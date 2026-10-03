/**
 * 装置用的假声线:代理只对参考音频做内容哈希与 base64,不解码,所以内容任意,
 * 但必须存在 —— 缺 <声线>.wav、<声线>-24k.spk/.rvq 时代理启动即退出。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = join(HERE, 'fixtures');
const src = resolve(HERE, '..', '..', 'src');

mkdirSync(fixtures, { recursive: true });

writeFileSync(join(fixtures, 'test-voice.wav'), Buffer.from('fake-reference-wav', 'utf8'));
writeFileSync(join(fixtures, 'test-voice.txt'), '这是测试声线的参考转写。', 'utf8');
writeFileSync(join(src, 'test-voice-24k.spk'), Buffer.from('fake-spk-latent', 'utf8'));
writeFileSync(join(src, 'test-voice-24k.rvq'), Buffer.from('fake-rvq-latent', 'utf8'));
console.log('已生成装置声线文件');
