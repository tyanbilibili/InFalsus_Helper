/* InFalsus Helper Rating v1.0.0
 *
 * The requested curve is score-based, not accuracy-based:
 *   score >= 100,000,000   -> constant + 2
 *   score =  98,000,000    -> constant + 1
 *   98M < score < 100M     -> linear from +1 to +2
 *   score <  98,000,000    -> constant + 1 - (98,000,000 - score) / 3,000,000
 *
 * Values between 98M and 100M use the same linear slope, and negative chart
 * values are clamped to zero. Exact rational arithmetic is used until display.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InFalsusHelperRating = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const INPUT_SCHEMA = 'infalsus-helper-plays/v1';
  const SCORE_BASE = 98000000n;
  const SCORE_LINEAR_STEP = 2000000n;
  const SCORE_BELOW_BASE_STEP = 3000000n;
  const SCORE_CAP = 100000000n;
  const DENOMINATOR = 40;

  const fail = message => { throw new Error(message); };
  const has = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
  const object = (x, name) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(name + ' 必须是对象');
  };
  function gcd(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a || 1n;
  }
  function rat(n, d = 1n) {
    n = BigInt(n);
    d = BigInt(d);
    if (d <= 0n) fail('分母必须为正');
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
  }
  const add = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
  const sub = (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
  const mul = (a, b) => rat(a.n * b.n, a.d * b.d);
  const div = (a, b) => rat(a.n * b.d, a.d * b.n);
  const cmp = (a, b) => {
    const left = a.n * b.d;
    const right = b.n * a.d;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  // Truncation (drop extra digits), never rounding. The user asked for 去尾法
  // everywhere so that a displayed delta always equals new - old exactly.
  function fixed(value, digits = 4) {
    const scale = 10n ** BigInt(digits);
    const scaled = value.n * scale;
    const q = scaled / value.d;
    const negative = q < 0n;
    const s = (negative ? -q : q).toString().padStart(digits + 1, '0');
    const body = digits ? s.slice(0, -digits) + '.' + s.slice(-digits) : s;
    return negative ? '-' + body : body;
  }
  function number(value) {
    return Number(fixed(value, 12));
  }
  const exact = value => ({
    numerator: value.n.toString(),
    denominator: value.d.toString()
  });
  const ZERO = rat(0);
  const ONE = rat(1);

  function constantValue(value) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      fail('谱面定数必须为一位小数数值');
    }
    const text = String(value);
    if (!/^\d{1,2}(?:\.\d{1,6})?$/.test(text)) fail('谱面定数必须为一位小数数值');
    const [whole, fraction = ''] = text.split('.');
    const parsed = rat(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
    if (cmp(parsed, rat(999, 10)) > 0) fail('谱面定数必须在 0.0-99.9 之间');
    return parsed;
  }

  function scoreValue(score, constant) {
    const s = BigInt(score);
    const c = constant && typeof constant === 'object' &&
      typeof constant.n === 'bigint' && typeof constant.d === 'bigint'
      ? constant
      : constantValue(constant);
    if (s >= SCORE_CAP) return add(c, rat(2));
    if (s >= SCORE_BASE) {
      return add(add(c, ONE), div(rat(s - SCORE_BASE), rat(SCORE_LINEAR_STEP)));
    }
    const candidate = sub(add(c, ONE), div(rat(SCORE_BASE - s), rat(SCORE_BELOW_BASE_STEP)));
    return cmp(candidate, ZERO) < 0 ? ZERO : candidate;
  }

  function chartMap(catalog) {
    let rows;
    if (Array.isArray(catalog)) rows = catalog;
    else if (catalog && Array.isArray(catalog.songs)) {
      rows = catalog.songs.flatMap(song => Object.values(song.charts || {}));
    } else fail('catalog 必须包含 songs');
    const map = new Map();
    for (const chart of rows) {
      object(chart, 'chart');
      if (typeof chart.id !== 'string' || !chart.id || map.has(chart.id)) {
        fail('曲库谱面 ID 缺失或重复');
      }
      const ratingValue = constantValue(chart.rating);
      map.set(chart.id, {
        ...chart,
        ratingValue,
        ratingNumber: number(ratingValue)
      });
    }
    return map;
  }

  function normalizeScore(record) {
    if (typeof record.score === 'bigint') return record.score;
    if (typeof record.score === 'number' && Number.isSafeInteger(record.score)) {
      return BigInt(record.score);
    }
    if (typeof record.score === 'string' && /^\d{1,19}$/.test(record.score)) {
      return BigInt(record.score);
    }
    fail('score 必须为非负整数字符串');
  }

  function evaluateInternal(play, map, inputIndex) {
    object(play, 'play');
    const chart = map.get(play.chart_id);
    if (!chart) fail('未知 chart_id: ' + String(play.chart_id));
    const score = normalizeScore(play);
    const value = scoreValue(score, chart.ratingValue);
    const capped = score >= SCORE_CAP;
    const counts = play.counts && typeof play.counts === 'object' && !Array.isArray(play.counts)
      ? { ...play.counts }
      : null;
    return {
      value,
      data: {
        input_index: inputIndex,
        chart_id: chart.id,
        title: chart.title,
        difficulty: chart.difficulty,
        constant: chart.ratingNumber,
        constant_display: fixed(chart.ratingValue, 1),
        score: score.toString(),
        counts,
        rating: number(value),
        rating_display: fixed(value),
        rating_exact: exact(value),
        formula_zone: capped ? 'cap_plus_2' : score >= SCORE_BASE ? 'linear_plus1_to_plus2' : 'below_base_third_step',
        eligible: true,
        exclusion_reasons: []
      }
    };
  }

  function evaluatePlay(play, catalog) {
    return evaluateInternal(play, chartMap(catalog), 0).data;
  }

  function calculate(input, catalog, options = {}) {
    object(input, '输入');
    if (input.schema !== INPUT_SCHEMA || !Array.isArray(input.plays)) {
      fail('输入需要 schema="' + INPUT_SCHEMA + '" 和 plays 数组');
    }
    if (input.plays.length > 100000) fail('单次最多 100000 条记录');
    const map = chartMap(catalog);
    const best = new Map();
    const evaluated = [];
    input.plays.forEach((play, i) => {
      let result;
      try {
        result = evaluateInternal(play, map, i);
      } catch (error) {
        fail('plays[' + i + ']: ' + error.message);
      }
      evaluated.push(result.data);
      const previous = best.get(result.data.chart_id);
      if (!previous || cmp(result.value, previous.value) > 0 ||
          (cmp(result.value, previous.value) === 0 &&
           BigInt(result.data.score) > BigInt(previous.data.score))) {
        best.set(result.data.chart_id, result);
      }
    });
    const ordered = [...best.values()].sort((a, b) => {
      const byValue = -cmp(a.value, b.value);
      if (byValue) return byValue;
      return a.data.chart_id < b.data.chart_id ? -1 :
        a.data.chart_id > b.data.chart_id ? 1 : 0;
    });
    const selected = ordered.slice(0, 30);
    let total = ZERO;
    const top30 = selected.map((entry, index) => {
      const weight = index < 10 ? 2 : 1;
      const contribution = div(mul(entry.value, rat(weight)), rat(DENOMINATOR));
      total = add(total, contribution);
      return {
        ...entry.data,
        rank: index + 1,
        weight,
        contribution: number(contribution),
        contribution_display: fixed(contribution, 6),
        contribution_exact: exact(contribution)
      };
    });
    const constants = [...map.values()]
      .map(chart => chart.ratingValue)
      .sort((a, b) => -cmp(a, b))
      .slice(0, 30);
    const cap = div(
      constants.reduce((sum, constant, index) =>
        add(sum, mul(add(constant, rat(2)), rat(index < 10 ? 2 : 1))), ZERO),
      rat(DENOMINATOR)
    );
    return {
      algorithm: 'InFalsus_Helper_Score_Rating',
      version: VERSION,
      input_schema: INPUT_SCHEMA,
      catalog_as_of: catalog.meta?.as_of ?? null,
      catalog_chart_count: map.size,
      rating: number(total),
      rating_display: fixed(total),
      rating_text: options.ratingText ?? fixed(total, 3),
      rating_exact: exact(total),
      theoretical_max: number(cap),
      theoretical_max_display: fixed(cap),
      input_count: input.plays.length,
      eligible_play_count: evaluated.length,
      eligible_chart_count: best.size,
      selected_count: top30.length,
      zero_filled_slots: 30 - top30.length,
      denominator: DENOMINATOR,
      top10_weight: 2,
      remaining_weight: 1,
      coverage_complete: top30.length === 30,
      top30,
      warning: '非官方自定算法：98M 为定数+1，100M及以上为定数+2；低于98M按每300万扣1点，最低为0。Top10双权重，其余20张单权重。'
    };
  }

  return Object.freeze({
    VERSION,
    INPUT_SCHEMA,
    SCORE_BASE,
    SCORE_LINEAR_STEP,
    SCORE_BELOW_BASE_STEP,
    SCORE_CAP,
    scoreValue,
    evaluatePlay,
    calculate,
    fixed
  });
});
