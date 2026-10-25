'use strict';
// 精确定数（precise constants）：当前修改表 + 随程序分发的默认表。
//
// 两张表的分工：
//   当前表   user_data/precise-constants.json —— 只保存被改过的谱面
//   默认表   <exe 同级>/data/precise-defaults.json —— 随包分发，可被“设为默认”覆盖
// 两份文件互不覆盖；读取时默认表只作为“当前表不存在”时的初始值。
const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEMA = 'infalsus-precise-constants/v1';

/** 校验并提取 {values} 结构。 */
function valuesOf(stored) {
  return stored?.schema === SCHEMA &&
    stored.values && typeof stored.values === 'object' && !Array.isArray(stored.values)
    ? { ...stored.values }
    : {};
}

class PreciseConstants {
  /** @param {object} service 组合根，提供 store / appRoot / appHome / dataRoot */
  constructor(service) {
    this.svc = service;
    this.values = {};
    this.defaults = {};
  }

  /** 便携默认表：与 exe 同级，方便直接替换。 */
  externalPath() {
    return path.join(this.svc.appHome, 'data', 'precise-defaults.json');
  }

  /** 兜底默认表：打包进 resources 的那份。 */
  bundledPath() {
    return path.join(this.svc.appRoot, 'data', 'precise-defaults.json');
  }

  async readFile(file) {
    try {
      return valuesOf(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      return {};
    }
  }

  async writeFile(values, file = this.externalPath()) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({
      schema: SCHEMA,
      updated_at: new Date().toISOString(),
      values
    }, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, file);
  }

  /** 读取默认表（便携位置优先，其次内置，最后兼容旧的 user_data 位置）。 */
  async loadDefaults() {
    const externalPath = this.externalPath();
    const bundledPath = this.bundledPath();
    const external = await this.readFile(externalPath);
    if (Object.keys(external).length) {
      this.defaults = external;
      return;
    }
    if (externalPath !== bundledPath) {
      const bundled = await this.readFile(bundledPath);
      if (Object.keys(bundled).length) {
        this.defaults = bundled;
        await this.writeFile(bundled, externalPath).catch(() => {});
        return;
      }
    }
    // 1.1.0 早期版本把默认表存在 user_data 里，这里迁移过来。
    const legacy = valuesOf(await this.svc.store.read('precise-defaults.json'));
    if (!Object.keys(legacy).length) {
      this.defaults = {};
      return;
    }
    this.defaults = legacy;
    const moved = await this.writeFile(legacy, externalPath).then(() => true, () => false);
    if (moved) {
      await fs.unlink(path.join(this.svc.dataRoot, 'precise-defaults.json')).catch(() => {});
    }
  }

  /** 读取当前修改表；文件不存在时采用默认表（全新安装即自带一份）。 */
  async loadCurrent() {
    const stored = await this.svc.store.read('precise-constants.json');
    this.values = stored === null ? { ...this.defaults } : valuesOf(stored);
  }

  async writeCurrent() {
    await this.svc.store.write('precise-constants.json', {
      schema: SCHEMA,
      updated_at: new Date().toISOString(),
      values: this.values
    }, { backup: true });
  }

  /** 把当前表提升为默认表（供打包分发）。 */
  async saveAsDefaults() {
    this.defaults = { ...this.values };
    try {
      await this.writeFile(this.defaults);
    } catch {
      try {
        await this.writeFile(this.defaults, this.bundledPath());
      } catch (error) {
        throw new Error('无法写入默认精确定数表，请把程序放在可写目录后再试。' +
          (error?.message ? `（${error.message}）` : ''));
      }
    }
  }

  /** 还原成默认表。 */
  async resetToDefaults() {
    this.values = { ...this.defaults };
    await this.writeCurrent();
  }

  /**
   * 合并界面提交的整张表：只保留与游戏原定数不同的项。
   * @param {object} values chart_id -> "11.7"
   * @param {Map} baseCharts chart_id -> 原谱面（含 rating）
   */
  async save(values, baseCharts) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('INVALID_PRECISE_CONSTANTS');
    }
    const normalized = {};
    for (const [chartId, value] of Object.entries(values)) {
      const chart = baseCharts.get(chartId);
      if (!chart || !/^\d{1,2}(?:\.\d)?$/.test(String(value))) {
        throw new Error('INVALID_PRECISE_CONSTANT');
      }
      const numeric = Number(value);
      if (!(numeric >= 0 && numeric <= 99.9)) throw new Error('INVALID_PRECISE_CONSTANT');
      if (Math.round(numeric * 10) !== Math.round(Number(chart.rating) * 10)) {
        normalized[chartId] = numeric.toFixed(1);
      }
    }
    this.values = normalized;
    await this.writeCurrent();
  }

  /** 某个谱面实际生效的定数（开发者模式开启时才用精确值）。 */
  effective(chart, developerMode) {
    const edited = developerMode ? this.values[chart.id] : null;
    return edited ?? Number(chart.rating).toFixed(1);
  }
}

module.exports = { PreciseConstants, valuesOf, SCHEMA };
