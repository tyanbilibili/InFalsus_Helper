/* InFalsus Helper Rating v1.1.0
 *
 * Three switchable total-rating algorithms (see ALGORITHMS):
 *
 *  arcaea  (default, score curve)
 *    score >= 100,000,000   -> constant + 2
 *    score =  98,000,000    -> constant + 1
 *    98M < score < 100M     -> linear from +1 to +2
 *    score <  98,000,000    -> constant + 1 - (98,000,000 - score) / 3,000,000
 *
 *  djmax   (accuracy curve, same anchors as the reference launcher)
 *    accuracy = 100 * (2(S+P) + N) / (2(S+P+N+M))
 *    multiplier = piecewise-linear interpolation over DJMAX_ANCHORS
 *    value = constant * multiplier
 *
 *  phigros (square curve)
 *    score >= 100,000,000        -> constant
 *    70M <= score < 100M         -> constant * ((score - 55M) / 45M)^2
 *    score <  70,000,000         -> 0
 *
 * Top 30 aggregation: arcaea/djmax weight the first 10 charts by 2 and the rest
 * by 1 (divide by 40); phigros is a plain average (divide by 30).
 * Exact rational arithmetic is used everywhere; display values are truncated.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InFalsusHelperRating = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.1.0';
  const INPUT_SCHEMA = 'infalsus-helper-plays/v1';
  const SCORE_BASE = 98000000n;
  const SCORE_LINEAR_STEP = 2000000n;
  const SCORE_BELOW_BASE_STEP = 3000000n;
  const SCORE_CAP = 100000000n;
  const DENOMINATOR = 40;
  const ALGORITHMS = Object.freeze(['arcaea', 'djmax', 'phigros']);
  const DEFAULT_ALGORITHM = 'arcaea';
  const ALGORITHM_NAMES = Object.freeze({
    arcaea: 'Arcaea 算法',
    djmax: 'DJMAX 算法',
    phigros: 'Phigros 算法'
  });
  const ALGORITHM_WARNINGS = Object.freeze({
    arcaea: '非官方自定算法：98M 为定数+1，100M及以上为定数+2；低于98M按每300万扣1点，最低为0。Top10双权重，其余20张单权重。',
    djmax: '非官方算法：按判定数换算准确率，90% 以下为 0；90%–100% 按锚点分段线性插值得到系数，单谱 = 定数 × 系数。Top10双权重，其余20张单权重。',
    phigros: '非官方算法：100M 及以上为定数，70M–100M 为 定数 × ((分数−5500万)/4500万)²，70M 以下为 0。Top30 取算术平均（不加权）。'
  });
  const ALGORITHM_TAGS = Object.freeze({
    arcaea: 'ARCAEA',
    djmax: 'DJMAX',
    phigros: 'PHIGROS'
  });
  const ALGORITHM_RULES = Object.freeze({
    arcaea: 'SCORE CURVE / 98M BASE',
    djmax: 'ACCURACY CURVE / 90% BASE',
    phigros: 'SQUARE CURVE / 70M–100M'
  });
  // 每个算法的规则说明，直接下发给界面渲染，避免前后端各写一份。
  const ALGORITHM_FORMULAS = Object.freeze({
    arcaea: Object.freeze([
      ['≥ 100,000,000', '定数 + 2'],
      ['= 98,000,000', '定数 + 1'],
      ['98M ～ 100M', '从 +1 线性增长到 +2'],
      ['< 98,000,000', '定数 + 1 − 差值 ÷ 3,000,000'],
      ['总分', '(Top10×2 + Top11–30×1) ÷ 40'],
      ['同谱多次', '仅取最高单曲 Rating']
    ]),
    djmax: Object.freeze([
      ['准确率', '100 × (2(S+P) + N) ÷ 2(S+P+N+M)'],
      ['< 90%', '系数 0'],
      ['90% ～ 100%', '锚点分段线性插值（90→0.1271 … 99→0.9339 → 100→1）'],
      ['单谱 Rating', '定数 × 系数'],
      ['总分', '(Top10×2 + Top11–30×1) ÷ 40'],
      ['同谱多次', '仅取最高单曲 Rating']
    ]),
    phigros: Object.freeze([
      ['≥ 100,000,000', '定数'],
      ['70M ～ 100M', '定数 × ((分数 − 55,000,000) ÷ 45,000,000)²'],
      ['< 70,000,000', '0'],
      ['总分', 'Top30 算术平均（÷30，不加权）'],
      ['同谱多次', '仅取最高单曲 Rating'],
      ['补零', '不足 30 张按 0 计入平均']
    ])
  });
  const ZONE_LABELS = Object.freeze({
    cap_plus_2: 'CAP +2',
    cap_constant: 'CAP',
    linear_plus1_to_plus2: 'SCORE CURVE',
    below_base_third_step: 'SCORE CURVE',
    accuracy_curve: 'ACC CURVE',
    square_curve: 'SQUARE CURVE'
  });
  const ALGORITHM_META = Object.freeze(ALGORITHMS.map(id => Object.freeze({
    id,
    name: ALGORITHM_NAMES[id],
    tag: ALGORITHM_TAGS[id],
    rule: ALGORITHM_RULES[id],
    warning: ALGORITHM_WARNINGS[id],
    formula: ALGORITHM_FORMULAS[id]
  })));

  // Phigros curve constants.
  const PHIGROS_LOW = 70000000n;
  const PHIGROS_OFFSET = 55000000n;
  const PHIGROS_SPAN = 45000000n;

  // [accuracy percent, multiplier] — copied from the reference launcher's
  // interpolation curve; the curve itself is that project's own definition.
  const DJMAX_ANCHORS = Object.freeze([
    ['90', '0.1271'], ['94.5', '0.2390'], ['95.5', '0.3731'],
    ['96', '0.4713'], ['96.5', '0.5702'], ['97', '0.6706'],
    ['97.5', '0.7585'], ['98', '0.8294'], ['98.5', '0.8862'],
    ['99', '0.9339'], ['100', '1']
  ]);

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

  function decimal(value) {
    const text = String(value);
    if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(text)) fail('锚点必须为非负小数');
    const [whole, fraction = ''] = text.split('.');
    return rat(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  }

  function asConstant(constant) {
    return constant && typeof constant === 'object' &&
      typeof constant.n === 'bigint' && typeof constant.d === 'bigint'
      ? constant
      : constantValue(constant);
  }

  /** arcaea (default): score-based curve. */
  function scoreValue(score, constant) {
    const s = BigInt(score);
    const c = asConstant(constant);
    if (s >= SCORE_CAP) return add(c, rat(2));
    if (s >= SCORE_BASE) {
      return add(add(c, ONE), div(rat(s - SCORE_BASE), rat(SCORE_LINEAR_STEP)));
    }
    const candidate = sub(add(c, ONE), div(rat(SCORE_BASE - s), rat(SCORE_BELOW_BASE_STEP)));
    return cmp(candidate, ZERO) < 0 ? ZERO : candidate;
  }

  const djmaxPoints = DJMAX_ANCHORS.map(([accuracy, multiplier]) =>
    [decimal(accuracy), decimal(multiplier)]);

  /** Accuracy percentage from the four judgement counts, as an exact rational. */
  function djmaxAccuracy(counts) {
    if (!counts || typeof counts !== 'object') return null;
    const shiny = BigInt(counts.shiny || 0);
    const perfect = BigInt(counts.perfect || 0);
    const near = BigInt(counts.near || 0);
    const miss = BigInt(counts.miss || 0);
    const total = shiny + perfect + near + miss;
    if (total <= 0n) return null;
    return rat(100n * (2n * (shiny + perfect) + near), 2n * total);
  }

  /** Piecewise-linear interpolation over the reference curve's anchors. */
  function djmaxCoefficient(accuracy) {
    if (cmp(accuracy, rat(90)) < 0) return ZERO;
    for (let index = 1; index < djmaxPoints.length; index += 1) {
      const [high, upper] = djmaxPoints[index];
      const [low, lower] = djmaxPoints[index - 1];
      if (cmp(accuracy, high) <= 0) {
        return add(lower, mul(div(sub(accuracy, low), sub(high, low)), sub(upper, lower)));
      }
    }
    return ONE;
  }

  /** djmax: constant × accuracy multiplier. Needs judgement counts. */
  function djmaxValue(score, constant, counts, countsUnreliable) {
    // The best-score table stores the best *score* but not always that play's
    // judgements. When the counts don't belong to the best play, derive the
    // accuracy from the score instead (error < 0.002%).
    const accuracy = countsUnreliable ? accuracyFromScore(score) : djmaxAccuracy(counts);
    if (accuracy === null) return ZERO;
    return mul(asConstant(constant), djmaxCoefficient(accuracy));
  }

  /** score ≈ 100,000,000 × accuracy + shiny, so accuracy ≈ score / 1,000,000. */
  function accuracyFromScore(score) {
    const s = BigInt(score);
    if (s <= 0n) return null;
    return rat(s > SCORE_CAP ? SCORE_CAP : s, 1000000n);
  }

  /** phigros: constant × ((score - 55M) / 45M)^2, capped at the constant. */
  function phigrosValue(score, constant) {
    const s = BigInt(score);
    const c = asConstant(constant);
    if (s >= SCORE_CAP) return c;
    if (s < PHIGROS_LOW) return ZERO;
    const progress = rat(s - PHIGROS_OFFSET, PHIGROS_SPAN);
    return mul(c, mul(progress, progress));
  }

  function valueFor(algorithm, score, constant, counts, countsUnreliable) {
    if (algorithm === 'djmax') return djmaxValue(score, constant, counts, countsUnreliable);
    if (algorithm === 'phigros') return phigrosValue(score, constant);
    return scoreValue(score, constant);
  }

  /** Best achievable single-chart value, used for the theoretical maximum. */
  function maxValueFor(algorithm, constant) {
    if (algorithm === 'djmax' || algorithm === 'phigros') return constant;
    return add(constant, rat(2));
  }

  function weightFor(algorithm, index) {
    if (algorithm === 'phigros') return 1;
    return index < 10 ? 2 : 1;
  }

  function denominatorFor(algorithm) {
    return algorithm === 'phigros' ? 30 : DENOMINATOR;
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

  function zoneFor(algorithm, score) {
    if (algorithm === 'djmax') return 'accuracy_curve';
    if (algorithm === 'phigros') return score >= SCORE_CAP ? 'cap_constant' : 'square_curve';
    if (score >= SCORE_CAP) return 'cap_plus_2';
    return score >= SCORE_BASE ? 'linear_plus1_to_plus2' : 'below_base_third_step';
  }

  function evaluateInternal(play, map, inputIndex, algorithm = DEFAULT_ALGORITHM) {
    object(play, 'play');
    const chart = map.get(play.chart_id);
    if (!chart) fail('未知 chart_id: ' + String(play.chart_id));
    const score = normalizeScore(play);
    const counts = play.counts && typeof play.counts === 'object' && !Array.isArray(play.counts)
      ? { ...play.counts }
      : null;
    const value = valueFor(algorithm, score, chart.ratingValue, counts, play.counts_unreliable === true);
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
        algorithm,
        rating: number(value),
        rating_display: fixed(value),
        rating_exact: exact(value),
        formula_zone: zoneFor(algorithm, score),
        eligible: true,
        exclusion_reasons: []
      }
    };
  }

  function evaluatePlay(play, catalog, preparedMap, algorithm = DEFAULT_ALGORITHM) {
    return evaluateInternal(play, preparedMap || chartMap(catalog), 0, algorithm).data;
  }

  /** Build the chart lookup once when scoring many plays (e.g. the history page). */
  function buildChartMap(catalog) {
    return chartMap(catalog);
  }

  function calculate(input, catalog, options = {}) {
    object(input, '输入');
    if (input.schema !== INPUT_SCHEMA || !Array.isArray(input.plays)) {
      fail('输入需要 schema="' + INPUT_SCHEMA + '" 和 plays 数组');
    }
    if (input.plays.length > 100000) fail('单次最多 100000 条记录');
    const algorithm = ALGORITHMS.includes(options.algorithm) ? options.algorithm : DEFAULT_ALGORITHM;
    const denominator = denominatorFor(algorithm);
    const map = chartMap(catalog);
    const best = new Map();
    const evaluated = [];
    input.plays.forEach((play, i) => {
      let result;
      try {
        result = evaluateInternal(play, map, i, algorithm);
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
      const weight = weightFor(algorithm, index);
      const contribution = div(mul(entry.value, rat(weight)), rat(denominator));
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
        add(sum, mul(maxValueFor(algorithm, constant), rat(weightFor(algorithm, index)))), ZERO),
      rat(denominator)
    );
    return {
      algorithm,
      algorithm_name: ALGORITHM_NAMES[algorithm],
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
      denominator,
      top10_weight: algorithm === 'phigros' ? 1 : 2,
      remaining_weight: 1,
      coverage_complete: top30.length === 30,
      top30,
      warning: ALGORITHM_WARNINGS[algorithm]
    };
  }

  return Object.freeze({
    VERSION,
    INPUT_SCHEMA,
    SCORE_BASE,
    SCORE_LINEAR_STEP,
    SCORE_BELOW_BASE_STEP,
    SCORE_CAP,
    ALGORITHMS,
    DEFAULT_ALGORITHM,
    ALGORITHM_NAMES,
    ALGORITHM_META,
    ZONE_LABELS,
    DJMAX_ANCHORS,
    scoreValue,
    djmaxAccuracy,
    djmaxCoefficient,
    djmaxValue,
    phigrosValue,
    valueFor,
    evaluatePlay,
    buildChartMap,
    calculate,
    fixed
  });
});
