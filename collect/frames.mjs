// frames.mjs — 从本地 mp4 抽若干关键帧并转 base64，供视觉模型打分。
// ffmpeg 不在 PATH 时，回退到本机 imageio_ffmpeg 自带的二进制。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 在常见位置找 ffmpeg 可执行文件，找不到返回 null。 */
export function findFfmpeg({ env = process.env } = {}) {
  const explicit = (env.TIKTOK_FFMPEG || '').trim();
  if (explicit && existsSync(explicit)) return explicit;

  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const pythonRoot = join(appData, 'Python');
  const versions = listDir(pythonRoot)
    .filter((entry) => entry.isDirectory() && /^Python3/i.test(entry.name))
    .map((entry) => join(pythonRoot, entry.name))
    .sort()
    .reverse();

  for (const base of versions) {
    const binDir = join(base, 'site-packages', 'imageio_ffmpeg', 'binaries');
    const found = listDir(binDir)
      .filter((entry) => entry.isFile() && /^ffmpeg.*\.exe$/i.test(entry.name))
      .map((entry) => join(binDir, entry.name))
      .sort()
      .reverse();
    if (found.length) return found[0];
  }
  return null;
}

/** 按视频时长算抽帧时间点（避开首尾黑帧）。 */
export function frameTimes(durationSec, count = 3) {
  const total = Number(durationSec);
  const safe = Number.isFinite(total) && total > 1 ? total : 15;
  const n = Math.max(1, Math.min(Number(count) || 3, 5));
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const ratio = n === 1 ? 0.3 : 0.08 + (0.72 * i) / (n - 1);
    points.push(Number(Math.min(Math.max(safe * ratio, 0.4), Math.max(safe - 0.6, 0.4)).toFixed(2)));
  }
  return points;
}

/**
 * 抽帧并返回 base64 数组。
 * @returns {{ok:boolean, frames:Array<{time:number,mime:string,data:string,bytes:number}>, code?:string, message?:string, ffmpeg?:string}}
 */
export function extractFrames(videoPath, { durationSec, count = 3, width = 480, tmpDir, ffmpeg, signal } = {}) {
  if (!videoPath || !existsSync(videoPath)) {
    return { ok: false, frames: [], code: 'VIDEO_NOT_FOUND', message: '找不到本地视频文件，无法抽帧。' };
  }
  const bin = ffmpeg || findFfmpeg();
  if (!bin) {
    return { ok: false, frames: [], code: 'FFMPEG_MISSING', message: '未找到 ffmpeg，可设置 TIKTOK_FFMPEG 指向可执行文件。' };
  }
  const workDir = tmpDir || join(tmpdir(), `tiktok-frames-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const times = frameTimes(durationSec, count);
  const frames = [];
  try {
    for (const time of times) {
      signal?.throwIfAborted?.();
      const out = join(workDir, `f-${String(time).replace('.', '_')}.jpg`);
      execFileSync(
        bin,
        ['-y', '-loglevel', 'error', '-ss', String(time), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out],
        { stdio: 'ignore', timeout: 30_000 },
      );
      if (!existsSync(out)) continue;
      const bytes = statSync(out).size;
      if (bytes < 1024) continue;
      frames.push({ time, mime: 'image/jpeg', data: readFileSync(out).toString('base64'), bytes });
    }
  } catch (error) {
    return { ok: false, frames, code: 'FRAME_EXTRACT_FAILED', message: String(error?.message || error).slice(0, 200), ffmpeg: bin };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响结果。
    }
  }

  if (!frames.length) {
    return { ok: false, frames, code: 'FRAME_EXTRACT_EMPTY', message: '抽帧结果为空，视频可能损坏或编码不受支持。', ffmpeg: bin };
  }
  return { ok: true, frames, ffmpeg: bin };
}
