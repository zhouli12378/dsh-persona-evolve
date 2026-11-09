/**
 * dsh-persona-evolve —— 纯逻辑层（不依赖 DSH，可单独用 CLI 跑）
 *
 * 一句话：给人设里的「可演化」小节换一茬新枝叶，根（铁律/边界）不动。
 */

import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 在 markdown 里定位 `## <title>` 这一节，返回其正文的行区间与原始文本。 */
export function locateSection(text, title) {
  const lines = text.split(/\r?\n/);
  // 标题按前缀匹配：允许「## 最近的样子（可演化）」这种带后缀的写法
  const head = new RegExp(`^##\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { lines, start, end, body: lines.slice(start, end).join('\n') };
}

/** 去掉模型可能带出来的代码围栏，只留正文。 */
export function stripFences(s) {
  const m = String(s ?? '').match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : String(s ?? '')).trim();
}

/**
 * 校验并清洗模型给出的新小节：只留 `- ` 开头的条目，超过 maxLines 截断。
 * 返回 { ok, bullets, reason }
 */
export function normalizeBullets(raw, maxLines = 8) {
  const text = stripFences(raw);
  const bullets = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => '- ' + l.replace(/^[-*]\s+/, '').trim())
    .filter((l) => l.length > 3);

  if (bullets.length === 0) return { ok: false, bullets: [], reason: '模型没给出任何条目' };
  const forbidden = ['铁律', '## ', 'ignore previous', '忽略以上', '忽略之前的指示'];
  for (const b of bullets) {
    if (forbidden.some((f) => b.includes(f))) {
      return { ok: false, bullets: [], reason: '新条目里出现了不该出现的内容：' + b };
    }
    if (b.length > 120) return { ok: false, bullets: [], reason: '有条目太长（>120 字）' };
  }
  return { ok: true, bullets: bullets.slice(0, maxLines), reason: '' };
}

/** 拼提示词：只让模型产出小节条目，别碰别的。 */
export function buildPrompt({ sectionTitle, sectionBody, transcript, maxLines }) {
  return [
    {
      role: 'system',
      content: [
        '你在维护一份 AI 助手的人设文件。文件里有一节是"可以随相处变化的枝叶"，其余部分是根，禁止改动。',
        '你的任务：读最近的真实对话，判断这个人设有没有长出新的、稳定的东西（新的习惯、偏好、口吻、相处方式）。',
        '',
        `输出要求：`,
        `- 只输出新的「${sectionTitle}」小节的条目（Markdown 列表），最多 ${maxLines} 条；`,
        `- 每条以 "- " 开头，一句话，具体、可观察，不要形容词堆砌；`,
        `- 保留仍然成立的旧条目，删掉已经不符合的；`,
        `- 没长出真东西就原样输出旧条目；`,
        '- 不要输出标题、不要解释、不要代码块。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `## 现在的小节内容\n${sectionBody.trim() || '（空）'}`,
        '',
        `## 最近的对话（节选）\n${transcript.slice(-12000)}`,
      ].join('\n'),
    },
  ];
}

/**
 * 主流程：读文件 → 问模型 → 校验 → 备份 → 写回。
 * @param {object} o
 * @param {string} o.personaPath    人设文件路径（如 AGENTS.md）
 * @param {string} o.sectionTitle   可演化小节的标题（不含 ##）
 * @param {number} o.maxLines       条目上限
 * @param {string} o.transcript     最近对话文本
 * @param {(messages:any[])=>Promise<string>} o.chat  调用模型的函数
 * @param {string} [o.logPath]      日志文件
 * @param {boolean} [o.dryRun]      只算不写
 */
export async function evolve({ personaPath, sectionTitle, maxLines = 8, transcript, chat, logPath, dryRun = false }) {
  const before = await readFile(personaPath, 'utf8');
  const found = locateSection(before, sectionTitle);
  if (!found) throw new Error(`人设文件里找不到「## ${sectionTitle}」这一节：${personaPath}`);

  // 小节里除了条目列表，还可能有序言（`> 说明` 之类）：只替换列表，序言原样保留
  const bodyLines = found.body.split(/\r?\n/);
  const firstBullet = bodyLines.findIndex((l) => /^[-*]\s+/.test(l.trim()));
  const preamble = (firstBullet < 0 ? bodyLines : bodyLines.slice(0, firstBullet))
    .join('\n')
    .replace(/\s+$/, '');
  const oldBullets = bodyLines
    .slice(firstBullet < 0 ? bodyLines.length : firstBullet)
    .filter((l) => /^[-*]\s+/.test(l.trim()))
    .join('\n');

  const prompt = buildPrompt({ sectionTitle, sectionBody: oldBullets || found.body, transcript, maxLines });
  const raw = await chat(prompt);
  const { ok, bullets, reason } = normalizeBullets(raw, maxLines);
  if (!ok) return { changed: false, reason, before: oldBullets, after: oldBullets };

  const after = bullets.join('\n');
  const changed = after.trim() !== oldBullets.trim();
  if (!changed) return { changed: false, reason: '和现在一样，没有新长出来的东西', before: oldBullets, after };

  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(personaPath, join(dirname(personaPath), `.${stamp}.persona.bak`));
    const lines = [...found.lines];
    const replacement = [];
    if (preamble) replacement.push(preamble, '');
    replacement.push(...bullets, '');
    const next = [...lines.slice(0, found.start), ...replacement, ...lines.slice(found.end)];
    await writeFile(personaPath + '.tmp', next.join('\n'), 'utf8');
    await copyFile(personaPath + '.tmp', personaPath);
    const { rm } = await import('node:fs/promises');
    await rm(personaPath + '.tmp', { force: true });
  }

  if (logPath) {
    const entry = `\n### ${new Date().toISOString()}\n- 旧：\n${oldBullets.trim()}\n- 新：\n${after}\n`;
    try {
      const prev = await readFile(logPath, 'utf8').catch(() => '');
      await writeFile(logPath, prev + entry, 'utf8');
    } catch { /* 日志失败不影响主流程 */ }
  }

  return { changed: true, reason: '已更新', before: oldBullets, after };
}

/** 便宜的兜底：把最近对话压成纯文本（调用方负责从会话里取消息）。 */
export function transcriptFromMessages(messages, limit = 60) {
  return (messages ?? [])
    .slice(-limit)
    .map((m) => {
      const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : String(m.role ?? '?');
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
          : '';
      return `${who}: ${String(text).trim()}`;
    })
    .filter((l) => l.length > 3)
    .join('\n');
}
