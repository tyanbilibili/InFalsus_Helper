'use strict';
// 存档档案（archive）：把游戏存档里的「历史记录环形表」与「最佳成绩表」
// 合并成一份长期档案，并按谱面记录历史最高分。
//
// 两张游戏内表：
//   历史表  1024 个槽位，滚动覆盖，含完整判定
//   最佳表  每个（歌曲×难度）一条，永久保留最高分，但判定数不一定是最高分那次
//
// 合并规则：同一个（歌曲×难度）只留最高分；分数相同的优先采用历史表的判定
// （历史表的判定一定属于那次游玩），最佳表的判定标记为不可靠。
const fs = require('node:fs/promises');
const { readStable, parseSave } = require('./save-reader.cjs');

const SCHEMA = 'infalsus-helper-archive/v1';

/** 把游戏的两张表合并进「每谱面最佳」映射。 */
function mergeBestScores(previous, parsed, now) {
  const best = { ...(previous || {}) };
  const consider = (key, candidate) => {
    const prev = best[key];
    if (!prev) {
      best[key] = candidate;
      return;
    }
    const prevScore = BigInt(prev.score);
    const nextScore = BigInt(candidate.score);
    if (nextScore > prevScore) {
      best[key] = candidate;
    } else if (nextScore === prevScore && prev.counts_unreliable && !candidate.counts_unreliable) {
      // 同分：历史表的判定更可信。
      best[key] = { ...candidate, updated_at: prev.updated_at || candidate.updated_at };
    }
  };
  for (const record of parsed.history) {
    consider(`${record.song_id}:${record.difficulty_flag}`, {
      song_id: record.song_id,
      difficulty_flag: record.difficulty_flag,
      score: String(record.score),
      counts: record.counts,
      counts_unreliable: false,
      source: 'history',
      updated_at: now
    });
  }
  for (const entry of parsed.highscores || []) {
    consider(`${entry.song_id}:${entry.difficulty_flag}`, {
      song_id: entry.song_id,
      difficulty_flag: entry.difficulty_flag,
      score: String(entry.score),
      counts: entry.counts,
      counts_unreliable: true,
      source: 'highscore',
      updated_at: now
    });
  }
  return best;
}

/** 新档案的初始结构。 */
function emptyArchive(key) {
  return {
    schema: SCHEMA,
    account_key: key,
    created_at: new Date().toISOString(),
    updated_at: null,
    records: [],
    best_scores: {},
    last_source_hash: null,
    last_rating: null
  };
}

class ArchiveStore {
  /** @param {object} service 组合根，提供 store / emit / dataRoot */
  constructor(service) {
    this.svc = service;
    // 存档文件 stat 缓存：mtime+size 没变就完全跳过读取。
    this.sourceStamp = null;
  }

  /** 读取档案；同一账号在内存里复用，避免每次轮询重新解析 200 KB JSON。 */
  async read(key) {
    const cached = this.svc.archive;
    if (cached && cached.account_key === key && Array.isArray(cached.records)) {
      return cached;
    }
    const found = await this.svc.store.read(`accounts/${key}/archive.json`);
    if (found?.schema === SCHEMA && found.account_key === key && Array.isArray(found.records)) {
      return found;
    }
    return emptyArchive(key);
  }

  /**
   * 把存档内容同步进档案。
   * @returns {{archive: object, added: Array, unchanged: boolean}}
   */
  async sync(account, announce) {
    const archive = await this.read(account.key);
    // 同步前的最佳成绩快照：算「本次变化」时必须用它，否则新旧两份完全相同。
    const previousBest = { ...(archive.best_scores || {}) };
    const needsUpgrade = archive.records.some(record =>
      !Number.isInteger(record.slot) || !Number.isInteger(record.history_order)) ||
      archive.best_scores === undefined;

    // 快路径：文件 mtime + size 未变 → 连读都不读（省掉 180 ms 稳定性等待 + 全量哈希）。
    const stamp = await fs.stat(account.file).catch(() => null);
    const cached = this.sourceStamp;
    if (stamp && cached && cached.key === account.key && !needsUpgrade &&
        archive.last_source_hash &&
        cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
      return { archive, added: [], unchanged: true, previousBest };
    }

    const stable = await readStable(account.file);
    if (archive.last_source_hash === stable.sha256 && !needsUpgrade) {
      this.rememberStamp(account, stamp);
      return { archive, added: [], unchanged: true, previousBest };
    }

    const parsed = parseSave(stable.buffer);
    const known = new Map(archive.records.map(record => [record.id, record]));
    const added = [];
    const now = new Date().toISOString();
    for (const record of parsed.history) {
      const existing = known.get(record.id);
      if (existing) {
        existing.slot = record.slot;
        existing.history_order = record.history_order;
      } else {
        const stored = { ...record, first_observed_at: now };
        known.set(record.id, stored);
        added.push(stored);
      }
    }
    const next = {
      ...archive,
      records: [...known.values()],
      best_scores: mergeBestScores(archive.best_scores, parsed, now),
      updated_at: now,
      last_source_hash: stable.sha256,
      coverage: {
        history_occupied: parsed.occupied,
        history_capacity: parsed.slots,
        highscore_count: parsed.highscores.length
      }
    };
    this.rememberStamp(account, stamp);
    await this.svc.store.write(`accounts/${account.key}/archive.json`, next, { backup: true });
    if (announce) {
      this.svc.emit('archive', {
        account_key: account.key,
        added: added.length,
        total: next.records.length
      });
    }
    return { archive: next, added, previousBest };
  }

  rememberStamp(account, stamp) {
    this.sourceStamp = {
      key: account.key,
      mtimeMs: stamp?.mtimeMs ?? null,
      size: stamp?.size ?? null
    };
  }
}

module.exports = { ArchiveStore, mergeBestScores, emptyArchive, SCHEMA };
