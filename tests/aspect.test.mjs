import test from 'node:test';
import assert from 'node:assert/strict';
import { aspectVerdict, ruleScore, ASPECT_TARGET, ASPECT_TOLERANCE } from '../collect/judge-rule.mjs';
import { extractFromDom } from '../collect/extract.mjs';

const R = (w, h) => aspectVerdict({ video: { width: w, height: h } });

test('aspectVerdict: 9:16 容差 ±3% 边界', () => {
  assert.equal(ASPECT_TARGET, 9 / 16);
  assert.equal(ASPECT_TOLERANCE, 0.03);
  assert.equal(R(1080, 1920).ok, true);
  assert.equal(R(720, 1280).ok, true);
  // 容差边界：0.5625*0.97=0.545625，*1.03=0.579375
  assert.equal(R(1048, 1920).ok, true);   // 0.54583
  assert.equal(R(1112, 1920).ok, true);   // 0.57917
  assert.equal(R(1040, 1920).ok, false);  // 0.54167 低于下界
  assert.equal(R(1120, 1920).ok, false);  // 0.58333 高于上界
});

test('aspectVerdict: 横屏/方图/非 9:16 竖屏全部拒绝', () => {
  for (const [w, h] of [[1920, 1080], [1080, 1080], [1080, 1350], [1080, 1440], [1280, 720]]) {
    const v = R(w, h);
    assert.equal(v.ok, false, `${w}x${h} 应拒绝`);
    assert.equal(v.known, true, `${w}x${h} 应有已知分辨率`);
    assert.match(v.reason, /不是 9:16 竖屏/);
  }
});

test('aspectVerdict: 分辨率未知拒绝且 known=false', () => {
  for (const c of [{}, { video: {} }, { video: { width: null, height: null } }, { video: { width: 0, height: 0 } }, { video: { width: -1, height: 1920 } }, { video: { width: 'abc', height: 1920 } }]) {
    const v = aspectVerdict(c);
    assert.equal(v.ok, false);
    assert.equal(v.known, false);
    assert.match(v.reason, /分辨率未知/);
  }
});

test('ruleScore: 非 9:16 与未知分辨率一票否决 score=0', () => {
  const profile = { mustHave: [], niceToHave: [], mustNot: [], threshold: 0 };
  const base = { videoId: 'x', desc: 'demo video', challenges: [], duration: 20, stats: { playCount: 100000, diggCount: 10000 } };
  const bad = ruleScore({ ...base, video: { width: 1920, height: 1080 } }, profile);
  assert.equal(bad.veto, true);
  assert.equal(bad.ruleScore, 0);
  assert.match(bad.vetoReason, /9:16/);
  const unknown = ruleScore({ ...base, video: { width: null, height: null } }, profile);
  assert.equal(unknown.veto, true);
  assert.equal(unknown.ruleScore, 0);
  const good = ruleScore({ ...base, video: { width: 1080, height: 1920 } }, profile);
  assert.equal(good.veto, false);
  assert.equal(good.detail.aspectOk, true);
  assert.ok(good.tags.includes('竖屏'));
});

test('extractFromDom: 把 <video> 的固有尺寸映射进 video.width/height', async () => {
  const fakePage = (videoWidth, videoHeight) => ({
    evaluate: async () => ({
      desc: 'demo', author: 'someone', like: '1.2K', comment: '3', share: '4', music: 'bgm',
      src: 'https://example.com/v.mp4', poster: 'https://example.com/p.jpg',
      videoWidth, videoHeight,
      canonical: 'https://www.tiktok.com/@someone/video/1234567890',
      pageUrl: 'https://www.tiktok.com/@someone/video/1234567890',
      title: 't',
    }),
  });

  const portrait = await extractFromDom(fakePage(1080, 1920));
  assert.equal(portrait.videoId, '1234567890');
  assert.equal(portrait.video.width, 1080);
  assert.equal(portrait.video.height, 1920);
  assert.equal(portrait.video.ratio, 0.5625);
  assert.equal(aspectVerdict(portrait).ok, true);

  const landscape = await extractFromDom(fakePage(1920, 1080));
  assert.equal(aspectVerdict(landscape).ok, false);

  const unknown = await extractFromDom(fakePage(0, 0));
  assert.equal(unknown.video.width, null);
  assert.equal(unknown.video.height, null);
  assert.equal(aspectVerdict(unknown).known, false);
  assert.equal(aspectVerdict(unknown).ok, false);
});
