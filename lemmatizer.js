/**
 * lemmatizer.js —— 轻量级英文词形还原 / 变形生成
 *
 * 作用：
 * 1. lemmatize(word)：把变形词还原为原型（ate→eat、cats→cat、bigger→big）。
 * 2. getInflections(lemma)：由原型生成常见变形，用于页面高亮时匹配各种形式。
 *
 * 实现方式：不规则变化表（动词/名词/形容词）+ 规则后缀处理，无外部依赖、离线可用。
 * 说明：规则后缀存在少量歧义（如 making 可能是 make/mak），这里采用“最常见”的还原结果，
 * 配合有道/本地词典二次校正，覆盖绝大多数场景。
 */
(function (global) {
  'use strict';

  // 不规则动词：原形 -> 常见变形数组（第三人称/过去式/过去分词/现在分词等）。
  // 这里收录最常用的不规则动词，用于把 ate→eat、went→go 这类直接命中。
  const IRREG_VERBS = {
    be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
    beat: ['beats', 'beat', 'beaten', 'beating'],
    become: ['becomes', 'became', 'become', 'becoming'],
    begin: ['begins', 'began', 'begun', 'beginning'],
    bend: ['bends', 'bent', 'bending'],
    bet: ['bets', 'bet', 'betting'],
    bite: ['bites', 'bit', 'bitten', 'biting'],
    blow: ['blows', 'blew', 'blown', 'blowing'],
    break: ['breaks', 'broke', 'broken', 'breaking'],
    bring: ['brings', 'brought', 'bringing'],
    build: ['builds', 'built', 'building'],
    burn: ['burns', 'burned', 'burnt', 'burning'],
    buy: ['buys', 'bought', 'buying'],
    catch: ['catches', 'caught', 'catching'],
    choose: ['chooses', 'chose', 'chosen', 'choosing'],
    come: ['comes', 'came', 'come', 'coming'],
    cost: ['costs', 'cost', 'costing'],
    cut: ['cuts', 'cut', 'cutting'],
    deal: ['deals', 'dealt', 'dealing'],
    die: ['dies', 'died', 'dying'],
    dig: ['digs', 'dug', 'digging'],
    do: ['does', 'did', 'done', 'doing'],
    draw: ['draws', 'drew', 'drawn', 'drawing'],
    dream: ['dreams', 'dreamed', 'dreamt', 'dreaming'],
    drink: ['drinks', 'drank', 'drunk', 'drinking'],
    drive: ['drives', 'drove', 'driven', 'driving'],
    eat: ['eats', 'ate', 'eaten', 'eating'],
    fall: ['falls', 'fell', 'fallen', 'falling'],
    feed: ['feeds', 'fed', 'feeding'],
    feel: ['feels', 'felt', 'feeling'],
    fight: ['fights', 'fought', 'fighting'],
    find: ['finds', 'found', 'finding'],
    fly: ['flies', 'flew', 'flown', 'flying'],
    forget: ['forgets', 'forgot', 'forgotten', 'forgetting'],
    forgive: ['forgives', 'forgave', 'forgiven', 'forgiving'],
    freeze: ['freezes', 'froze', 'frozen', 'freezing'],
    get: ['gets', 'got', 'gotten', 'getting'],
    give: ['gives', 'gave', 'given', 'giving'],
    go: ['goes', 'went', 'gone', 'going'],
    grow: ['grows', 'grew', 'grown', 'growing'],
    hang: ['hangs', 'hung', 'hanged', 'hanging'],
    have: ['has', 'had', 'having'],
    hear: ['hears', 'heard', 'hearing'],
    hide: ['hides', 'hid', 'hidden', 'hiding'],
    hit: ['hits', 'hit', 'hitting'],
    hold: ['holds', 'held', 'holding'],
    hurt: ['hurts', 'hurt', 'hurting'],
    keep: ['keeps', 'kept', 'keeping'],
    know: ['knows', 'knew', 'known', 'knowing'],
    lay: ['lays', 'laid', 'laying'],
    lead: ['leads', 'led', 'leading'],
    learn: ['learns', 'learned', 'learnt', 'learning'],
    leave: ['leaves', 'left', 'leaving'],
    lend: ['lends', 'lent', 'lending'],
    let: ['lets', 'let', 'letting'],
    lie: ['lies', 'lay', 'lain', 'lying'],
    light: ['lights', 'lit', 'lighted', 'lighting'],
    lose: ['loses', 'lost', 'losing'],
    make: ['makes', 'made', 'making'],
    mean: ['means', 'meant', 'meaning'],
    meet: ['meets', 'met', 'meeting'],
    pay: ['pays', 'paid', 'paying'],
    put: ['puts', 'put', 'putting'],
    read: ['reads', 'read', 'reading'],
    ride: ['rides', 'rode', 'ridden', 'riding'],
    ring: ['rings', 'rang', 'rung', 'ringing'],
    rise: ['rises', 'rose', 'risen', 'rising'],
    run: ['runs', 'ran', 'run', 'running'],
    say: ['says', 'said', 'saying'],
    see: ['sees', 'saw', 'seen', 'seeing'],
    sell: ['sells', 'sold', 'selling'],
    send: ['sends', 'sent', 'sending'],
    set: ['sets', 'set', 'setting'],
    shake: ['shakes', 'shook', 'shaken', 'shaking'],
    shine: ['shines', 'shone', 'shining'],
    shoot: ['shoots', 'shot', 'shooting'],
    show: ['shows', 'showed', 'shown', 'showing'],
    shut: ['shuts', 'shut', 'shutting'],
    sing: ['sings', 'sang', 'sung', 'singing'],
    sink: ['sinks', 'sank', 'sunk', 'sinking'],
    sit: ['sits', 'sat', 'sitting'],
    sleep: ['sleeps', 'slept', 'sleeping'],
    speak: ['speaks', 'spoke', 'spoken', 'speaking'],
    spend: ['spends', 'spent', 'spending'],
    stand: ['stands', 'stood', 'standing'],
    steal: ['steals', 'stole', 'stolen', 'stealing'],
    stick: ['sticks', 'stuck', 'sticking'],
    swear: ['swears', 'swore', 'sworn', 'swearing'],
    sweep: ['sweeps', 'swept', 'sweeping'],
    swim: ['swims', 'swam', 'swum', 'swimming'],
    take: ['takes', 'took', 'taken', 'taking'],
    teach: ['teaches', 'taught', 'teaching'],
    tear: ['tears', 'tore', 'torn', 'tearing'],
    tell: ['tells', 'told', 'telling'],
    think: ['thinks', 'thought', 'thinking'],
    throw: ['throws', 'threw', 'thrown', 'throwing'],
    tie: ['ties', 'tied', 'tying'],
    understand: ['understands', 'understood', 'understanding'],
    use: ['uses', 'used', 'using'],
    wake: ['wakes', 'woke', 'woken', 'waking'],
    wear: ['wears', 'wore', 'worn', 'wearing'],
    win: ['wins', 'won', 'winning'],
    write: ['writes', 'wrote', 'written', 'writing'],
  };

  // 不规则名词复数：复数 -> 单数
  const NOUN_LEMMA = {
    children: 'child',
    men: 'man',
    women: 'woman',
    people: 'person',
    feet: 'foot',
    teeth: 'tooth',
    geese: 'goose',
    mice: 'mouse',
    oxen: 'ox',
    leaves: 'leaf',
    knives: 'knife',
    lives: 'life',
    wives: 'wife',
    wolves: 'wolf',
    halves: 'half',
    selves: 'self',
    shelves: 'shelf',
    thieves: 'thief',
    loaves: 'loaf',
    calves: 'calf',
    scarves: 'scarf',
    hooves: 'hoof',
    analyses: 'analysis',
    bases: 'basis',
    crises: 'crisis',
    theses: 'thesis',
    hypotheses: 'hypothesis',
    diagnoses: 'diagnosis',
    phenomena: 'phenomenon',
    criteria: 'criterion',
    data: 'datum',
    media: 'medium',
    bacteria: 'bacterium',
    curricula: 'curriculum',
    indices: 'index',
    matrices: 'matrix',
    vertices: 'vertex',
    appendices: 'appendix',
    cacti: 'cactus',
    foci: 'focus',
    fungi: 'fungus',
    nuclei: 'nucleus',
    syllabi: 'syllabus',
    stimuli: 'stimulus',
    alumni: 'alumnus',
  };

  // 不规则形容词比较级/最高级：变形 -> 原级
  const ADJ_LEMMA = {
    better: 'good',
    best: 'good',
    worse: 'bad',
    worst: 'bad',
    farther: 'far',
    further: 'far',
    farthest: 'far',
    furthest: 'far',
    less: 'little',
    least: 'little',
    more: 'many',
    most: 'many',
    elder: 'old',
    eldest: 'old',
  };

  // 由不规则动词表构建“变形 -> 原形”反向映射。
  const VERB_LEMMA = {};
  Object.keys(IRREG_VERBS).forEach((base) => {
    VERB_LEMMA[base] = base; // 原形也映射到自身
    IRREG_VERBS[base].forEach((form) => {
      VERB_LEMMA[form] = base;
    });
  });

  // 判断是否以辅音字母 + 元音字母 + 辅音字母结尾（用于需要双写尾字母的情况，如 run->running）。
  function isCvc(word) {
    if (word.length < 3) return false;
    const c = word.slice(-3);
    return isConsonant(c[0]) && isVowel(c[1]) && isConsonant(c[2]);
  }

  function isVowel(ch) {
    return 'aeiou'.indexOf(ch) !== -1;
  }
  function isConsonant(ch) {
    return 'bcdfghjklmnpqrstvwxyz'.indexOf(ch) !== -1;
  }

  /**
   * 词形还原：返回单词原型（小写）。
   * 优先命中不规则表，其次按规则后缀处理。
   */
  function lemmatize(word) {
    if (!word) return '';
    const w = word.toLowerCase().replace(/[^a-z']/g, '');
    if (!w) return word.toLowerCase();

    // 1) 直接命中不规则/原形表
    if (VERB_LEMMA[w]) return VERB_LEMMA[w];
    if (NOUN_LEMMA[w]) return NOUN_LEMMA[w];
    if (ADJ_LEMMA[w]) return ADJ_LEMMA[w];

    // 2) 规则后缀
    // -ies -> -y（studies->study, flies->fly）
    if (w.length > 4 && w.endsWith('ies')) {
      return w.slice(0, -3) + 'y';
    }
    // -ves -> -f / -fe（knives->knife, leaves->leaf）
    if (w.length > 4 && w.endsWith('ves')) {
      const stem = w.slice(0, -3);
      return stem + 'fe'; // 常见形式为 -fe，也有 -f；这里优先 -fe
    }
    // -ing
    if (w.length > 5 && w.endsWith('ing')) {
      return handleIng(w);
    }
    // -ied -> -y（studied->study）
    if (w.length > 5 && w.endsWith('ied')) {
      return w.slice(0, -3) + 'y';
    }
    // -ed
    if (w.length > 4 && w.endsWith('ed')) {
      return handleEd(w);
    }
    // -ier / -iest -> -y（happier->happy）
    if (w.length > 5 && w.endsWith('ier')) return w.slice(0, -3) + 'y';
    if (w.length > 6 && w.endsWith('iest')) return w.slice(0, -4) + 'y';
    // 注意：不再对 -er/-est 做“双写比较级/最高级”还原（bigger->big），
    // 否则 matter->mat、better->bet、latter->lat 等大量常见词会被误判。
    // -es 复数/第三人称（boxes->box, churches->church, goes->go）
    if (w.length > 3 && w.endsWith('es') && !w.endsWith('ies') && !w.endsWith('ves')) {
      return w.slice(0, -2);
    }
    // -s 复数/第三人称（cats->cat, dogs->dog）
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
      return w.slice(0, -1);
    }

    return w;
  }

  function handleIng(w) {
    let stem = w.slice(0, -3); // 去掉 -ing
    // lying->lie, dying->die（已在不规则表，但保留兜底）
    if (w.endsWith('ying') && w.length > 4) return stem.slice(0, -1) + 'ie'; // dying->die 特殊
    if (stem.length >= 2) {
      // 双写还原：running->run, swimming->swim
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && isCvc(stem.slice(0, -1))) {
        return stem.slice(0, -1);
      }
    }
    // 不再无条件补 e（conditioning->condition）。去 e 形式（using->use）由不规则表
    // 或 content.js 借助 lemmatizeCandidates + 本地词典二次确认。
    return stem;
  }

  function handleEd(w) {
    let stem = w.slice(0, -2); // 去掉 -ed
    if (stem.length >= 2) {
      // 双写还原：stopped->stop
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && isCvc(stem.slice(0, -1))) {
        return stem.slice(0, -1);
      }
    }
    // 不再无条件补 e（conditioned->condition）。
    return stem;
  }

  /**
   * 生成一个变形词的多个候选原型（按可能性排序），用于 content.js 结合本地词典确认。
   *
   * 例如 conditioning 既可能是 condition（直接 +ing），也可能是 conditione（去 e 后再 +ing），
   * 单靠规则无法确定；返回多个候选后，content.js 会用本地词典/缓存逐一校验，命中即采用。
   */
  function lemmatizeCandidates(word) {
    if (!word) return [];
    const w = word.toLowerCase().replace(/[^a-z']/g, '');
    if (!w) return [word.toLowerCase()];

    const out = [];
    const push = (x) => {
      if (x && out.indexOf(x) === -1) out.push(x);
    };

    // 1) 不规则表 / 原形表直接命中，返回唯一结果。
    if (VERB_LEMMA[w]) return [VERB_LEMMA[w]];
    if (NOUN_LEMMA[w]) return [NOUN_LEMMA[w]];
    if (ADJ_LEMMA[w]) return [ADJ_LEMMA[w]];

    // 2) 规则后缀，每个后缀给出多个候选。
    if (w.length > 4 && w.endsWith('ies')) {
      push(w.slice(0, -3) + 'y');
      push(w.slice(0, -3) + 'ie');
      return out;
    }
    if (w.length > 4 && w.endsWith('ves')) {
      const stem = w.slice(0, -3);
      push(stem + 'fe');
      push(stem + 'f');
      return out;
    }
    if (w.length > 5 && w.endsWith('ing')) {
      const stem = w.slice(0, -3);
      // dying->die / tying->tie / lying->lie（不规则表已覆盖，此处兜底）
      if (w.endsWith('ying') && w.length > 4) {
        push(stem.slice(0, -1) + 'ie');
        return out;
      }
      // 双写还原：running->run, hopping->hop
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && isCvc(stem.slice(0, -1))) {
        push(stem.slice(0, -1));
        push(stem);
        return out;
      }
      // 去 e 优先（using->use），其次保留原形（conditioning->condition）。
      push(stem + 'e');
      push(stem);
      return out;
    }
    if (w.length > 5 && w.endsWith('ied')) {
      push(w.slice(0, -3) + 'y');
      return out;
    }
    if (w.length > 4 && w.endsWith('ed')) {
      const stem = w.slice(0, -2);
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && isCvc(stem.slice(0, -1))) {
        push(stem.slice(0, -1));
        push(stem);
        return out;
      }
      push(stem + 'e');
      push(stem);
      return out;
    }
    if (w.length > 5 && w.endsWith('ier')) {
      push(w.slice(0, -3) + 'y');
      return out;
    }
    if (w.length > 6 && w.endsWith('iest')) {
      push(w.slice(0, -4) + 'y');
      return out;
    }
    // 注意：不再对 -er/-est 做“双写比较级/最高级”候选（原因同上，matter->mat 等误判）。
    if (w.length > 3 && w.endsWith('es') && !w.endsWith('ies') && !w.endsWith('ves')) {
      push(w.slice(0, -2));
      return out;
    }
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
      push(w.slice(0, -1));
      return out;
    }

    push(w);
    return out;
  }

  /**
   * 生成原型的所有常见变形，用于高亮匹配（原型 + 复数 + 动词时态 + 比较级等）。
   */
  function getInflections(lemma) {
    const forms = new Set();
    const base = lemma.toLowerCase();
    forms.add(base);

    // 多词短语（含空格，如 kung fu / pull up stakes）不做形态还原，只返回短语本身，
    // 避免生成 "kung fus"、"pull up stakesed" 之类无意义变形。
    if (base.indexOf(' ') >= 0) {
      return [base];
    }

    // 不规则动词的所有变形
    if (IRREG_VERBS[base]) {
      IRREG_VERBS[base].forEach((f) => forms.add(f));
    }

    // 规则复数 / 第三人称单数
    forms.add(base + 's');
    forms.add(base + 'es');

    // 动词过去式 / 过去分词 / 现在分词
    forms.add(base + 'ed');
    forms.add(base + 'd');
    forms.add(base + 'ing');

    // 注意：不再生成 -er/-est 比较级/最高级。这类后缀对名词/动词会产生大量误判
    // （mat->mater/matter、run->runner、better 被当作 bet 等），故整体关闭以换取准确性。

    // 以 e 结尾：去 e 加 -ing/-ed（make->making/made 不规则已在表；care->caring/cared）
    if (base.endsWith('e')) {
      forms.add(base.slice(0, -1) + 'ing');
      forms.add(base.slice(0, -1) + 'ed');
    }

    // 辅音 + y 结尾：y->ies / ied / ying（study->studies/studied/studying）
    if (base.length > 2 && isConsonant(base[base.length - 2]) && base.endsWith('y')) {
      const stem = base.slice(0, -1);
      forms.add(stem + 'ies');
      forms.add(stem + 'ied');
      forms.add(stem + 'ier');
      forms.add(stem + 'iest');
    }

    // CVC 双写（run->running, stop->stopped）。不再生成 -er/-est 比较级，
    // 避免把 matter/better/latter 等常见词误当作 mat/bet/lat 的变形。
    if (isCvc(base)) {
      const last = base[base.length - 1];
      forms.add(base + last + 'ing');
      forms.add(base + last + 'ed');
    }

    return Array.from(forms);
  }

  global.LV_LEMMATIZER = { lemmatize, lemmatizeCandidates, getInflections };
})(typeof window !== 'undefined' ? window : self);
