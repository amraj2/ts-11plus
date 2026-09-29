/* Spark Stumble - a Stumble Guys style knockout race where answering questions is the controls.
 *
 * Flow: lobby -> "finding players" -> [splash -> countdown -> race -> results] x 3 rounds -> summary
 * Race: every runner auto-runs down a course with question gates. Reach a gate, answer it.
 *       Right answer = speed boost. Wrong answer / timeout = stumble. First N across the line qualify.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ config */
  const BANK = window.QUESTION_BANK;
  const SUBJECTS = Object.keys(BANK);
  const SAVE_KEY = 'sparkstumble-v1';

  const ROUNDS = [
    { name: 'Qualifier',   qualify: 20, gates: 4, blurb: 'Top 20 of 32 go through' },
    { name: 'Semi-final',  qualify: 10, gates: 4, blurb: 'Top 10 of 20 go through' },
    { name: 'Grand Final', qualify: 1,  gates: 5, blurb: 'First across the line wins the crown!' },
  ];
  const STAGE_LABELS = ['–', 'Qualifier', 'Semi-final', 'Final', 'Champion'];
  const FIELD = 32;
  const GATE_SPACING = 950;     // world units between gates
  const START_PAD = 700;        // start line -> first gate
  const FINISH_PAD = 700;       // last gate -> finish line
  const SKEW = 110;             // oblique-projection shear that gives the flat track some depth
  const GATE_TIME = 22;         // seconds the player gets per gate
  const GATE_TIME_RELAXED = 45;
  const STUMBLE_TIME = 1.8;
  const MAX_PROMPT_CHARS = 420; // keep long reading passages out - they are unfair in a race

  const ADJECTIVES = ['Wobbly', 'Zippy', 'Sneaky', 'Bouncy', 'Turbo', 'Fuzzy', 'Cosmic', 'Jolly', 'Mighty', 'Sparky', 'Giggly', 'Ninja', 'Speedy', 'Funky', 'Cheeky', 'Brave'];
  const NOUNS = ['Waffle', 'Panda', 'Noodle', 'Rocket', 'Muffin', 'Dragon', 'Pickle', 'Yeti', 'Taco', 'Comet', 'Bubble', 'Falcon', 'Jelly', 'Pixel', 'Nugget', 'Otter'];
  const COLORS = ['#ff6b6b', '#ff9f43', '#ffd23f', '#3ddc84', '#2ec4b6', '#4d9bff', '#8a6bff', '#ff6bd6', '#b5651d', '#8e9aaf'];
  const HATS = [
    { id: 'none',   label: 'No hat',     cost: 0 },
    { id: 'cap',    label: 'Cap',        cost: 0 },
    { id: 'party',  label: 'Party hat',  cost: 60 },
    { id: 'phones', label: 'Headphones', cost: 100 },
    { id: 'halo',   label: 'Halo',       cost: 150 },
    { id: 'crown',  label: 'Crown',      crowns: 3 },
  ];
  const BOT_HATS = ['none', 'none', 'cap', 'party', 'phones', 'halo'];

  /* ------------------------------------------------------------------ helpers */
  const $ = (id) => document.getElementById(id);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const stripTags = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const today = () => new Date().toISOString().slice(0, 10);

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
    return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  /* Questions that are short enough to answer inside a race, grouped by subject and difficulty level (1-3). */
  const POOLS = {};
  for (const subject of SUBJECTS) {
    POOLS[subject] = { 1: [], 2: [], 3: [] };
    BANK[subject].questions.forEach((q, i) => {
      if (stripTags(q[0]).length > MAX_PROMPT_CHARS) return;
      const level = q[4] && q[4][1] ? q[4][1] : 2;
      POOLS[subject][level].push(i);
    });
  }

  /* Chance of an easier / typical / harder question: later rounds are harder, and children who have been
   * answering well move a little further towards the hard end. */
  const LEVEL_MIX = [[0.55, 0.35, 0.10], [0.30, 0.45, 0.25], [0.15, 0.40, 0.45]];
  function levelWeights(roundIdx, rating) {
    const shift = clamp((rating - 0.5) * 0.5, -0.15, 0.2);
    const w = LEVEL_MIX[roundIdx].slice();
    w[0] = Math.max(0.05, w[0] - shift);
    w[2] = Math.max(0.05, w[2] + shift);
    const sum = w[0] + w[1] + w[2];
    return w.map((x) => x / sum);
  }
  function chooseLevel(weights) {
    let x = Math.random();
    for (let i = 0; i < 3; i++) { x -= weights[i]; if (x <= 0) return i + 1; }
    return 2;
  }
  const NO_SHUFFLE = /\b(all|none|both|neither) of (the|these)\b|above|below/i;

  /* ------------------------------------------------------------------ save data */
  const defaults = () => ({
    coins: 0, crowns: 0, xp: 0, bestStage: 0, runs: 0,
    color: COLORS[0], hat: 'cap', owned: ['none', 'cap'],
    nameA: 'Zippy', nameB: 'Panda', sound: true, relaxed: false,
    rating: 0.5, losses: 0, lastDaily: '',
  });
  let save = defaults();
  try { Object.assign(save, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch { /* private mode */ }
  const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ } };

  function levelInfo(xp) {
    let lvl = 1, need = 100;
    while (xp >= need) { xp -= need; lvl++; need = 100 + 40 * (lvl - 1); }
    return { lvl, into: xp, need };
  }

  /* ------------------------------------------------------------------ sound */
  const sfx = (() => {
    let ctx = null;
    function tone(freq, dur, type = 'sine', vol = 0.15, at = 0, slide = 0) {
      if (!save.sound) return;
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + at;
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t0 + dur);
        g.gain.setValueAtTime(vol, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        o.connect(g).connect(ctx.destination);
        o.start(t0); o.stop(t0 + dur + 0.02);
      } catch { /* audio unavailable */ }
    }
    return {
      unlock: () => tone(1, 0.01, 'sine', 0.001),
      click: () => tone(520, 0.06, 'square', 0.07),
      tick: () => tone(660, 0.1, 'square', 0.1),
      go: () => { tone(880, 0.5, 'square', 0.12); tone(1320, 0.5, 'triangle', 0.1); },
      correct: () => [523, 659, 784].forEach((f, i) => tone(f, 0.15, 'triangle', 0.18, i * 0.07)),
      wrong: () => tone(220, 0.35, 'sawtooth', 0.13, 0, -120),
      qualify: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.17, i * 0.09)),
      win: () => [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.28, 'triangle', 0.18, i * 0.1)),
      lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.3, 'sine', 0.15, i * 0.16)),
      pop: () => tone(300, 0.08, 'sine', 0.1, 0, 300),
    };
  })();

  /* ------------------------------------------------------------------ bean drawing */
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawHat(c, id) {
    switch (id) {
      case 'cap':
        c.fillStyle = '#e84a5f'; c.beginPath(); c.arc(0, -52, 18, Math.PI, 0); c.fill();
        c.fillRect(2, -55, 26, 5); break;
      case 'party':
        c.fillStyle = '#ff5ec4'; c.beginPath(); c.moveTo(-13, -53); c.lineTo(13, -53); c.lineTo(0, -86); c.closePath(); c.fill();
        c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.moveTo(-8, -63); c.lineTo(8, -70); c.stroke();
        c.fillStyle = '#ffd23f'; c.beginPath(); c.arc(0, -87, 5, 0, 7); c.fill(); break;
      case 'phones':
        c.strokeStyle = '#2a2350'; c.lineWidth = 5; c.beginPath(); c.arc(0, -40, 24, Math.PI * 1.02, Math.PI * 1.98); c.stroke();
        c.fillStyle = '#e84a5f'; roundRect(c, -29, -46, 10, 18, 4); c.fill(); roundRect(c, 19, -46, 10, 18, 4); c.fill(); break;
      case 'halo':
        c.strokeStyle = '#ffd23f'; c.lineWidth = 4; c.shadowColor = '#ffd23f'; c.shadowBlur = 8;
        c.beginPath(); c.ellipse(0, -68, 16, 5, 0, 0, 7); c.stroke(); c.shadowBlur = 0; break;
      case 'crown':
        c.fillStyle = '#ffc233'; c.strokeStyle = '#d99a00'; c.lineWidth = 2; c.beginPath();
        c.moveTo(-16, -54); c.lineTo(-17, -74); c.lineTo(-8, -64); c.lineTo(0, -78); c.lineTo(8, -64); c.lineTo(17, -74); c.lineTo(16, -54);
        c.closePath(); c.fill(); c.stroke(); break;
      default: break;
    }
  }

  /* Draws one bean with its feet at (x, y). pose: {cycle, lift, rot, arms, face, stars, t} */
  function drawBean(c, x, y, s, look, pose) {
    c.save();
    c.translate(x, y);
    c.scale(s, s);
    c.fillStyle = 'rgba(30,15,70,.22)';
    c.beginPath(); c.ellipse(0, 0, 22 * (1 - Math.min(pose.lift, 40) / 90), 7, 0, 0, 7); c.fill();
    c.translate(0, -pose.lift);
    if (pose.rot) { c.translate(0, -26); c.rotate(pose.rot); c.translate(0, 26); }

    const dark = shade(look.color, -0.28), light = shade(look.color, 0.38);
    for (const side of [-1, 1]) {           // legs
      const up = Math.max(0, Math.sin(pose.cycle + (side > 0 ? Math.PI : 0))) * 7;
      c.fillStyle = dark; roundRect(c, side * 8 - 5, -16 - up, 10, 17, 5); c.fill();
    }
    for (const side of [-1, 1]) {           // arms
      const swing = pose.arms === 'up' ? -1.9 : pose.arms === 'swing' ? Math.sin(pose.cycle + (side > 0 ? 0 : Math.PI)) * 0.8 : 0.25 * side;
      c.save(); c.translate(side * 21, -40); c.rotate(side * (pose.arms === 'up' ? -0.9 : 0.35) + (pose.arms === 'swing' ? swing * 0.5 : 0));
      c.fillStyle = dark; roundRect(c, -4, 0, 8, 17, 4); c.fill(); c.restore();
    }
    c.fillStyle = look.color; roundRect(c, -20, -57, 40, 47, 20); c.fill();      // body
    c.fillStyle = light; c.beginPath(); c.ellipse(1, -23, 11, 12, 0, 0, 7); c.fill(); // belly

    const ey = -43;                          // eyes
    if (pose.face === 'dizzy') {
      c.strokeStyle = '#1d1146'; c.lineWidth = 2.5;
      for (const ex of [-3, 11]) { c.beginPath(); c.moveTo(ex - 4, ey - 4); c.lineTo(ex + 4, ey + 4); c.moveTo(ex + 4, ey - 4); c.lineTo(ex - 4, ey + 4); c.stroke(); }
    } else {
      const look_y = pose.face === 'think' ? -2 : 0;
      for (const ex of [-3, 11]) {
        c.fillStyle = '#fff'; c.beginPath(); c.arc(ex, ey, 6.5, 0, 7); c.fill();
        c.fillStyle = '#1d1146'; c.beginPath(); c.arc(ex + 2, ey + look_y, 3.2, 0, 7); c.fill();
      }
    }
    c.strokeStyle = '#1d1146'; c.lineWidth = 2.2; c.lineCap = 'round'; c.beginPath();  // mouth
    if (pose.face === 'dizzy') c.arc(5, -31, 3, 0, 7);
    else if (pose.face === 'think') { c.moveTo(1, -31); c.lineTo(9, -31); }
    else c.arc(5, -33, 5, 0.15 * Math.PI, 0.85 * Math.PI);
    c.stroke();

    drawHat(c, look.hat);
    if (pose.stars) {                        // dizzy stars
      c.fillStyle = '#ffd23f';
      for (let i = 0; i < 3; i++) {
        const a = pose.t * 6 + i * 2.1;
        c.beginPath(); c.arc(Math.cos(a) * 20, -66 + Math.sin(a) * 5, 3.5, 0, 7); c.fill();
      }
    }
    c.restore();
  }

  /* ------------------------------------------------------------------ game state */
  let phase = 'idle';            // idle | countdown | race | over
  let screenName = 'lobby';
  let runToken = 0;              // bumps on quit so stale async chains stop
  let run = null;                // per-run stats
  let round = null;              // current round
  let runners = [];
  let player = null;
  let currentQ = null;           // question the player is answering
  let sheetTimer = 0;            // seconds until the answered sheet hides
  let rankTimer = 0, lastRankText = '';
  let tickerTimer = 0;
  let shake = 0;
  let particles = [];
  let roundResolve = null;
  let survivors = [];

  const nameOf = () => `${save.nameA} ${save.nameB}`;
  const gateX = (i) => START_PAD + i * GATE_SPACING;
  const courseLen = (cfg) => START_PAD + (cfg.gates - 1) * GATE_SPACING + FINISH_PAD;

  /* Difficulty tuning (see the balance notes in the README): bots answer correctly with `skill` and think for
   * botThinkBase() + (1 - skill) * BOT_THINK_SLOPE + up to BOT_THINK_JITTER seconds. Accurate kids face faster bots;
   * a kid who keeps going out early gets a small, gentle boost. */
  const BOT_THINK_SLOPE = 13;
  const BOT_THINK_JITTER = 5;

  function botSkillMean() {
    return clamp(0.5 + 0.28 * save.rating - Math.min(0.06, 0.02 * save.losses), 0.38, 0.82);
  }

  function botThinkBase() {
    return clamp(7.5 - 4 * (save.rating - 0.5), 5, 9.5) + Math.min(1.5, 0.5 * save.losses);
  }

  function makeRunners() {
    const mean = botSkillMean();
    const names = new Set([nameOf()]);
    const list = [];
    player = { id: 0, name: nameOf(), color: save.color, hat: save.hat, isPlayer: true, skill: 1, speed: 250 };
    list.push(player);
    while (list.length < FIELD) {
      const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
      if (names.has(name)) continue;
      names.add(name);
      const skill = clamp(mean + (Math.random() + Math.random() + Math.random() - 1.5) * 0.3, 0.25, 0.95);
      list.push({ id: list.length, name, color: pick(COLORS), hat: pick(BOT_HATS), isPlayer: false, skill, speed: rand(232, 262) });
    }
    return list;
  }

  function resetRunner(r, index, total) {
    Object.assign(r, {
      x: -rand(0, 55), state: 'wait', gate: 0, timer: 0, boost: 0, finishTime: null,
      phase: rand(0, 6.28), awaiting: false, queue: r.isPlayer ? 0 : rand(0, 110),
      lane: r.isPlayer ? 0.86 : clamp(((index + 0.5) / total) * 0.9 + rand(-0.03, 0.03) + 0.02, 0.04, 0.8),
    });
  }

  /* ------------------------------------------------------------------ screens */
  const SCREENS = ['lobby', 'finding', 'game', 'results', 'summary'];
  function show(name) {
    screenName = name;
    for (const s of SCREENS) $(s).hidden = s !== name;
    if (name === 'game') resize();
  }

  /* ------------------------------------------------------------------ lobby UI */
  const preview = $('preview'), pctx = preview.getContext('2d');

  function buildLobby() {
    $('nameA').innerHTML = ADJECTIVES.map((a) => `<option>${a}</option>`).join('');
    $('nameB').innerHTML = NOUNS.map((n) => `<option>${n}</option>`).join('');
    $('nameA').value = save.nameA; $('nameB').value = save.nameB;
    $('nameA').onchange = $('nameB').onchange = () => { save.nameA = $('nameA').value; save.nameB = $('nameB').value; persist(); };
    $('soundToggle').checked = save.sound;
    $('relaxedToggle').checked = save.relaxed;
    $('soundToggle').onchange = (e) => { save.sound = e.target.checked; persist(); $('muteBtn').textContent = save.sound ? '🔊' : '🔇'; };
    $('relaxedToggle').onchange = (e) => { save.relaxed = e.target.checked; persist(); };
    refreshLobby();
  }

  function refreshLobby() {
    const info = levelInfo(save.xp);
    $('crownCount').textContent = save.crowns;
    $('coinCount').textContent = save.coins;
    $('bestRank').textContent = STAGE_LABELS[save.bestStage];
    $('levelLabel').textContent = `Level ${info.lvl}`;
    $('levelFill').style.width = `${(info.into / info.need) * 100}%`;
    const daily = $('dailyBonus');
    daily.hidden = save.lastDaily === today();
    daily.textContent = '🎁 Daily bonus: +50 coins on your first race today!';
    $('muteBtn').textContent = save.sound ? '🔊' : '🔇';

    $('swatches').innerHTML = COLORS.map((c) => `<button class="swatch" style="background:${c}" data-color="${c}" aria-pressed="${c === save.color}" aria-label="Bean colour ${c}"></button>`).join('');
    $('hats').innerHTML = HATS.map((h) => {
      const owned = save.owned.includes(h.id) || (h.crowns && save.crowns >= h.crowns);
      const affordable = owned || (h.cost !== undefined && !h.crowns && save.coins >= h.cost);
      const sub = owned ? (save.hat === h.id ? 'Equipped' : 'Owned') : h.crowns ? `Win ${h.crowns} 👑` : `🪙 ${h.cost}`;
      return `<button class="hat" data-hat="${h.id}" aria-pressed="${save.hat === h.id}" ${affordable ? '' : 'disabled'}>${h.label}<small>${sub}</small></button>`;
    }).join('');
  }

  $('swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    save.color = b.dataset.color; persist(); sfx.click(); refreshLobby();
  });
  $('hats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hat]'); if (!b || b.disabled) return;
    const hat = HATS.find((h) => h.id === b.dataset.hat);
    if (!save.owned.includes(hat.id)) {
      if (!hat.crowns) save.coins -= hat.cost;
      save.owned.push(hat.id);
      sfx.win();
    } else sfx.click();
    save.hat = hat.id; persist(); refreshLobby();
  });

  /* ------------------------------------------------------------------ run flow */
  async function startRun() {
    sfx.unlock(); sfx.click();
    const token = ++runToken;
    if (save.lastDaily !== today()) { save.lastDaily = today(); save.coins += 50; run = { daily: 50 }; persist(); }
    else run = { daily: 0 };
    Object.assign(run, {
      coins: run.daily, xp: 0, answered: 0, correct: 0, streak: 0, bestStreak: 0,
      mistakes: [], stage: 0, champion: false, used: new Set(), queue: [], startLevel: levelInfo(save.xp).lvl,
    });

    await findPlayers();
    if (token !== runToken) return;

    runners = makeRunners();
    survivors = runners.slice();

    for (let i = 0; i < ROUNDS.length; i++) {
      startRound(i);
      show('game');
      await banner(`Round ${i + 1}<br>${ROUNDS[i].name}<small>${ROUNDS[i].blurb}</small>`, 2200);
      if (token !== runToken) return;
      await countdown();
      if (token !== runToken) return;
      await raceUntilOver();
      if (token !== runToken) return;
      const qualified = await showResults();
      if (token !== runToken) return;
      if (!qualified) break;
    }
    finishRun();
  }

  async function findPlayers() {
    show('finding');
    $('findCount').textContent = '1'; $('findFill').style.width = '3%';
    const steps = 22;
    for (let i = 1; i <= steps; i++) {
      const n = Math.min(FIELD, Math.round((i / steps) * FIELD));
      $('findCount').textContent = n;
      $('findFill').style.width = `${(n / FIELD) * 100}%`;
      $('findName').textContent = i < steps ? `${pick(ADJECTIVES)} ${pick(NOUNS)} joined!` : 'Get ready…';
      sfx.pop();
      await sleep(95 + Math.random() * 60);
    }
    await sleep(350);
  }

  function startRound(idx) {
    const cfg = ROUNDS[idx];
    round = { idx, cfg, len: courseLen(cfg), finished: [], over: false, t: 0, qualifiedPlayer: false, botThink: botThinkBase() };
    runners = survivors.slice();
    runners.forEach((r, i) => resetRunner(r, i, runners.length));
    run.stage = Math.max(run.stage, idx + 1);
    currentQ = null;
    $('sheet').hidden = true;
    $('hudRound').textContent = cfg.name;
    $('hudSlots').textContent = cfg.qualify === 1 ? 'Win the crown!' : `${cfg.qualify} qualify`;
    $('hudStreak').hidden = true;
    lastRankText = '';
    particles = [];
    buildMinimap();
    phase = 'countdown';
    updateRankHud(true);
  }

  async function banner(html, ms) {
    const el = $('banner');
    el.innerHTML = html; el.hidden = false;
    await sleep(ms);
    el.hidden = true;
  }

  async function countdown() {
    for (const n of ['3', '2', '1']) { sfx.tick(); await banner(n, 750); }
    sfx.go();
    phase = 'race';
    runners.forEach((r) => { r.state = 'run'; });
    banner('GO!', 650);
  }

  function raceUntilOver() {
    return new Promise((resolve) => { roundResolve = resolve; });
  }

  /* ------------------------------------------------------------------ simulation */
  function stepRunner(r, dt) {
    if (round.over) return;
    switch (r.state) {
      case 'run': {
        const mult = r.boost > 0 ? 1.5 : 1;
        r.boost = Math.max(0, r.boost - dt);
        r.x += r.speed * mult * dt;
        if (r.gate < round.cfg.gates && r.x >= gateX(r.gate) - r.queue) {
          r.x = gateX(r.gate) - r.queue;
          arriveAtGate(r);
        } else if (r.gate >= round.cfg.gates && r.x >= round.len) {
          finishRunner(r);
        }
        break;
      }
      case 'think':
        r.timer += dt;
        if (r.isPlayer) {
          const limit = save.relaxed ? GATE_TIME_RELAXED : GATE_TIME;
          if (r.awaiting && r.timer >= limit) answer(-1);
        } else if (r.timer >= r.thinkFor) {
          resolveGate(r, Math.random() < r.skill);
        }
        break;
      case 'stumble':
        r.timer -= dt;
        if (r.timer <= 0) { r.state = 'run'; r.timer = 0; }
        break;
      default: break;
    }
  }

  function arriveAtGate(r) {
    r.state = 'think';
    r.timer = 0;
    if (r.isPlayer) openQuestion();
    else r.thinkFor = round.botThink + (1 - r.skill) * BOT_THINK_SLOPE + rand(0, BOT_THINK_JITTER);
  }

  function resolveGate(r, correct) {
    r.gate++;
    r.queue = r.isPlayer ? 0 : rand(0, 110);
    if (correct) { r.state = 'run'; r.boost = 1.1; }
    else { r.state = 'stumble'; r.timer = STUMBLE_TIME; }
  }

  function finishRunner(r) {
    if (round.finished.length >= round.cfg.qualify) return;
    r.state = 'done';
    r.finishTime = round.t;
    round.finished.push(r);
    const left = round.cfg.qualify - round.finished.length;
    if (r.isPlayer) {
      round.qualifiedPlayer = true;
      $('sheet').hidden = true;
      burst(playerScreenX(), bandTop + bandH, 60);
      sfx.qualify();
    } else if (round.cfg.qualify > 1 && (left <= 3 || round.finished.length % 4 === 0)) {
      say(left > 0 ? `🏁 ${r.name} qualified! ${left} slot${left === 1 ? '' : 's'} left` : `🏁 ${r.name} took the last slot!`);
    } else if (round.cfg.qualify === 1) {
      say(`🏁 ${r.name} crossed the line!`);
    }
    if (round.finished.length >= round.cfg.qualify) endRound();
  }

  /* Once the player is safely through (or already out), the rest of the race is played out instantly. */
  function fastForward() {
    for (let i = 0; i < 6000 && !round.over; i++) {
      round.t += 0.05;
      for (const r of runners) if (!r.isPlayer) stepRunner(r, 0.05);
    }
  }

  function endRound() {
    if (round.over) return;
    round.over = true;
    phase = 'over';
    player.awaiting = false;
    $('sheet').hidden = true;
    const won = round.qualifiedPlayer;
    const final = round.cfg.qualify === 1;
    banner(won ? (final ? '👑 CHAMPION! 👑' : 'QUALIFIED!') : 'ROUND OVER!', 1600);
    if (won) { sfx[final ? 'win' : 'qualify'](); burst(playerScreenX(), bandTop, final ? 140 : 70); }
    else { sfx.lose(); shake = 0.4; }
    setTimeout(() => { if (roundResolve) { const done = roundResolve; roundResolve = null; done(); } }, 1900);
  }

  function computeStandings() {
    const fin = round.finished.slice();
    const rest = runners.filter((r) => !fin.includes(r)).sort((a, b) => b.x - a.x);
    return fin.concat(rest);
  }

  /* ------------------------------------------------------------------ questions */
  function pickQuestion() {
    if (!run.queue.length) run.queue = shuffle(SUBJECTS.slice());
    const subject = run.queue.pop();
    let level = chooseLevel(levelWeights(round.idx, save.rating));
    let pool = POOLS[subject][level];
    for (const alt of [level, 2, 1, 3]) {        // fall back to the nearest level that has questions
      pool = POOLS[subject][alt];
      if (pool.length) { level = alt; break; }
    }
    let idx, tries = 0;
    do { idx = pool[Math.floor(Math.random() * pool.length)]; tries++; } while (run.used.has(subject + idx) && tries < 60);
    run.used.add(subject + idx);
    const q = BANK[subject].questions[idx];
    const order = q[1].map((_, i) => i);
    if (!q[1].some((o) => NO_SHUFFLE.test(o)) && !NO_SHUFFLE.test(q[0])) shuffle(order);
    return { subject, q, order, gate: player.gate };
  }

  function openQuestion() {
    currentQ = pickQuestion();
    const { subject, q, order } = currentQ;
    $('sheetSubject').textContent = `${BANK[subject].icon} ${subject}`;
    $('sheetGate').textContent = `Gate ${player.gate + 1} of ${round.cfg.gates}`;
    $('qText').innerHTML = q[0];
    $('qOpts').innerHTML = order.map((orig, i) =>
      `<button class="opt" data-i="${i}"><span class="l">${'ABCD'[i]}</span><span>${q[1][orig]}</span></button>`).join('');
    $('timerFill').style.width = '100%'; $('timerFill').classList.remove('low');
    $('sheet').querySelector('.q-scroll').scrollTop = 0;
    $('sheet').hidden = false;
    sheetTimer = 0;
    player.awaiting = true;
  }

  function answer(displayIndex) {
    if (!player.awaiting || !currentQ) return;
    player.awaiting = false;
    const { q, order, subject } = currentQ;
    const correctDisplay = order.indexOf(q[2]);
    const correct = displayIndex === correctDisplay;
    const opts = $('qOpts').children;
    for (const b of opts) b.disabled = true;
    opts[correctDisplay].classList.add('right');
    if (!correct && displayIndex >= 0) opts[displayIndex].classList.add('wrong');

    run.answered++;
    if (correct) {
      run.correct++; run.streak++; run.bestStreak = Math.max(run.bestStreak, run.streak);
      earn(5, 10);
      resolveGate(player, true);
      player.boost = 1.1 + Math.min(run.streak, 5) * 0.15;
      burst(playerScreenX(), bandTop + bandH * 0.7, 26);
      sfx.correct();
      toast(run.streak >= 3 ? `🔥 Streak x${run.streak}!` : 'Correct! +5 🪙', 'good');
      sheetTimer = 0.7;
    } else {
      run.streak = 0;
      run.mistakes.push({
        subject, prompt: q[0], correct: q[1][q[2]], why: q[3],
        chosen: displayIndex >= 0 ? q[1][order[displayIndex]] : null,
      });
      resolveGate(player, false);
      shake = 0.35;
      burst(playerScreenX(), bandTop + bandH, 14, '#c9b48a');
      sfx.wrong();
      toast(displayIndex < 0 ? "Time's up!" : 'Oops! Stumble!', 'bad');
      sheetTimer = 1.7;
    }
    const streakEl = $('hudStreak');
    streakEl.hidden = run.streak < 2;
    streakEl.textContent = `🔥 x${run.streak}`;
    currentQ = null;
  }

  $('qOpts').addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (b && !b.disabled) answer(Number(b.dataset.i));
  });
  document.addEventListener('keydown', (e) => {
    if (screenName !== 'game') return;
    const i = '1234'.indexOf(e.key) >= 0 ? '1234'.indexOf(e.key) : 'abcd'.indexOf(e.key.toLowerCase());
    if (i >= 0 && e.key.length === 1) answer(i);
  });

  function earn(coins, xp) {
    run.coins += coins; run.xp += xp;
    save.coins += coins; save.xp += xp;
    persist();
  }

  /* ------------------------------------------------------------------ results */
  function showResults() {
    const standings = computeStandings();
    const cfg = round.cfg;
    const idx = standings.indexOf(player);
    const won = round.qualifiedPlayer;
    const final = cfg.qualify === 1;
    const rewards = [];

    if (won) {
      const c = final ? 100 : 20 + round.idx * 10;
      earn(c, final ? 60 : 25);
      rewards.push(`+${c} 🪙`, `+${final ? 60 : 25} XP`);
      if (final) { run.champion = true; save.crowns++; rewards.push('+1 👑'); }
      survivors = standings.slice(0, cfg.qualify);
    } else {
      earn(10, 5);
      rewards.push('+10 🪙 for trying', '+5 XP');
    }
    save.bestStage = Math.max(save.bestStage, run.champion ? 4 : run.stage);
    persist();

    const title = $('resTitle');
    title.className = 'results-title' + (won ? '' : ' bad');
    title.textContent = won ? (final ? '👑 CHAMPION!' : 'Qualified!') : 'Knocked out!';
    $('resSub').textContent = won
      ? (final ? 'You beat 31 other players. Legend!' : `You finished ${ordinal(idx + 1)} — on to the ${ROUNDS[round.idx + 1].name}!`)
      : (idx + 1 <= cfg.qualify + 3 ? `So close! You were ${ordinal(idx + 1)} — ${cfg.qualify} qualified.` : `You finished ${ordinal(idx + 1)}. Every gate you answer makes you faster!`);

    const shown = new Set([0, 1, 2, cfg.qualify - 1, cfg.qualify, idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < standings.length));
    let html = '', prev = -1;
    [...shown].sort((a, b) => a - b).forEach((i) => {
      if (prev >= 0 && i > prev + 1) html += '<li><span class="pos"></span>…</li>';
      const r = standings[i];
      const cls = [r.isPlayer ? 'me' : '', i === cfg.qualify ? 'cut' : ''].join(' ');
      const st = r.finishTime !== null ? `${r.finishTime.toFixed(1)}s` : 'DNF';
      html += `<li class="${cls}"><span class="pos">${i + 1}.</span><span class="dot" style="background:${r.color}"></span>${r.isPlayer ? 'You' : r.name}<span class="st">${st}</span></li>`;
      prev = i;
    });
    $('resList').innerHTML = html;
    $('resRewards').innerHTML = rewards.map((r) => `<span class="reward">${r}</span>`).join('');
    const last = round.idx === ROUNDS.length - 1;
    $('resNext').textContent = won && !last ? `Next: ${ROUNDS[round.idx + 1].name} ▶` : 'See my summary';
    show('results');
    return new Promise((resolve) => { $('resNext').onclick = () => { sfx.click(); resolve(won && !last); }; });
  }

  function finishRun() {
    const accuracy = run.answered ? run.correct / run.answered : 0.5;
    if (run.answered >= 3) save.rating = clamp(0.75 * save.rating + 0.25 * accuracy, 0.1, 0.95);
    save.losses = run.stage >= 2 ? 0 : save.losses + 1;
    save.runs++;
    persist();

    const info = levelInfo(save.xp);
    $('sumTitle').className = 'results-title' + (run.champion ? '' : '');
    $('sumTitle').textContent = run.champion ? '👑 You won the crown!' : `Out in the ${STAGE_LABELS[run.stage]}`;
    const cells = [
      [`${run.correct}/${run.answered}`, 'correct answers'],
      [run.bestStreak, 'best streak 🔥'],
      [`+${run.coins}`, 'coins earned 🪙'],
      [info.lvl > run.startLevel ? `Level ${info.lvl}!` : `Level ${info.lvl}`, info.lvl > run.startLevel ? 'LEVEL UP 🎉' : 'your level'],
    ];
    $('sumGrid').innerHTML = cells.map(([b, s]) => `<div class="sum-cell"><b>${b}</b><span>${s}</span></div>`).join('');

    $('mistakeHead').textContent = run.mistakes.length ? "Let's learn from these" : 'Perfect run!';
    $('mistakes').innerHTML = run.mistakes.length
      ? run.mistakes.map((m) => `<div class="mistake"><div class="mq">${m.prompt}</div>
          <div>${m.chosen === null ? '<span class="you">No answer (time ran out)</span>' : `You said: <span class="you">${m.chosen}</span>`} · Answer: <span class="ans">${m.correct}</span></div>
          <div class="why">💡 ${m.why}</div></div>`).join('')
      : '<div class="none">No mistakes at all — brilliant! 🌟</div>';
    show('summary');
    refreshLobby();
  }

  function quitRun() {
    runToken++;
    phase = 'idle';
    roundResolve = null;
    $('sheet').hidden = true; $('banner').hidden = true;
    refreshLobby();
    show('lobby');
  }

  /* ------------------------------------------------------------------ HUD helpers */
  let toastTimer = 0;
  function toast(msg, cls) {
    const el = $('toast');
    el.textContent = msg; el.className = `toast ${cls || ''}`; el.hidden = false;
    // restart the pop animation
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 1100);
  }
  function say(msg) { $('ticker').textContent = msg; tickerTimer = 3; }

  function buildMinimap() {
    const map = $('minimap');
    map.querySelectorAll('.mm-dot').forEach((d) => d.remove());
    runners.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'mm-dot' + (r.isPlayer ? ' me' : '');
      r.dot = d; map.appendChild(d);
    });
  }
  function updateMinimap() {
    for (const r of runners) r.dot.style.left = `${clamp(r.x / round.len, 0, 1) * 100}%`;
  }
  function updateRankHud(force) {
    const st = computeStandings();
    const rank = st.indexOf(player) + 1;
    const text = phase === 'race' || phase === 'over' ? `${ordinal(rank)} / ${runners.length}` : `– / ${runners.length}`;
    if (force || text !== lastRankText) { $('hudRank').textContent = text; lastRankText = text; }
    const left = Math.max(0, round.cfg.qualify - round.finished.length);
    if (round.cfg.qualify > 1) $('hudSlots').textContent = `${left} slot${left === 1 ? '' : 's'} left`;
  }

  $('muteBtn').onclick = () => { save.sound = !save.sound; $('soundToggle').checked = save.sound; $('muteBtn').textContent = save.sound ? '🔊' : '🔇'; persist(); };
  $('quitBtn').onclick = () => { if (confirm('Leave this race?')) quitRun(); };
  $('playBtn').onclick = startRun;
  $('againBtn').onclick = startRun;
  $('lobbyBtn').onclick = () => { refreshLobby(); show('lobby'); };

  /* ------------------------------------------------------------------ particles */
  function burst(x, y, n, color) {
    const palette = color ? [color] : ['#ffc233', '#ff4d6a', '#3d8bff', '#22c56b', '#ff6bd6', '#ffffff'];
    for (let i = 0; i < n; i++) {
      const a = rand(0, 6.28), v = rand(120, 420);
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 180, life: rand(0.7, 1.4), age: 0, size: rand(4, 9), color: pick(palette), spin: rand(-8, 8) });
    }
  }
  function updateParticles(dt) {
    for (const p of particles) { p.age += dt; p.vy += 700 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    particles = particles.filter((p) => p.age < p.life);
  }

  /* ------------------------------------------------------------------ rendering */
  const stage = $('stage'), ctx = stage.getContext('2d');
  let W = 0, H = 0, zoom = 1, cam = 0;
  let bandCenter = 0, bandTop = 0, bandH = 200;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = stage.clientWidth; H = stage.clientHeight;
    if (!W || !H) return;
    stage.width = W * dpr; stage.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    zoom = clamp(W / 820, 0.62, 1.15);
  }
  window.addEventListener('resize', resize);

  const playerScreenX = () => W * (W < 600 ? 0.3 : 0.28);
  function proj(x, lane) {
    return { x: playerScreenX() + (x - cam) * zoom + (lane - 0.5) * SKEW * zoom, y: bandTop + lane * bandH, s: zoom * (0.6 + 0.5 * lane) };
  }

  function quad(a, b, c, d) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); }

  function drawBackground() {
    const horizon = bandTop - 70 * zoom;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#7cc8ff'); sky.addColorStop(1, '#d6f1ff');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, horizon + 2);
    ctx.fillStyle = '#ffffffcc';
    for (let i = 0; i < 6; i++) {
      const cx = ((i * 330 - cam * 0.08) % (W + 300) + (W + 300)) % (W + 300) - 100, cy = 34 + (i % 3) * 30;
      ctx.beginPath(); ctx.ellipse(cx, cy, 50, 16, 0, 0, 7); ctx.ellipse(cx + 28, cy - 8, 34, 15, 0, 0, 7); ctx.ellipse(cx - 30, cy - 4, 30, 13, 0, 0, 7); ctx.fill();
    }
    for (const [col, amp, f, par, off] of [['#b7a2ff', 34, 150, 0.15, 0], ['#7fdc9b', 22, 95, 0.3, 40]]) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, horizon + 2);
      for (let x = 0; x <= W; x += 10) ctx.lineTo(x, horizon - 14 - amp * 0.5 - amp * 0.5 * Math.sin((x + cam * par + off) / f) - 6 * Math.sin((x + cam * par) / 37));
      ctx.lineTo(W, horizon + 2); ctx.fill();
    }
    ctx.fillStyle = '#7fe0a2'; ctx.fillRect(0, horizon, W, H - horizon);
  }

  function drawTrack() {
    const span = playerScreenX() / zoom + 400, right = (W - playerScreenX()) / zoom + 400;
    const first = Math.floor((cam - span) / 200) * 200, last = cam + right;
    for (let x = first; x < last; x += 200) {                    // floor stripes
      ctx.fillStyle = (x / 200) % 2 === 0 ? '#ffe28f' : '#ffd66b';
      quad(proj(x, 0), proj(x + 200, 0), proj(x + 200, 1), proj(x, 1)); ctx.fill();
    }
    for (let x = Math.floor((cam - span) / 100) * 100; x < last; x += 100) {   // rails
      const a = proj(x, -0.04), b = proj(x + 100, -0.04);
      ctx.fillStyle = (x / 100) % 2 === 0 ? '#ff4d6a' : '#ffffff';
      quad(a, b, { x: b.x, y: b.y - 24 * b.s }, { x: a.x, y: a.y - 24 * a.s }); ctx.fill();
    }
    const edge = (x, y0, y1, col) => { ctx.fillStyle = col; ctx.fillRect(x, y0, 6, y1 - y0); };
    edge(proj(0, 0).x, bandTop, bandTop + bandH, '#ffffffcc');   // start line
    drawGate(round.len, -1);
  }

  function drawGate(gx, gateIndex) {
    const a = proj(gx, 0), b = proj(gx, 1);
    if (a.x < -200 && b.x < -200) return;
    if (a.x > W + 200 && b.x > W + 200) return;
    const finish = gateIndex < 0;
    const ha = 150 * a.s, hb = 150 * b.s;
    const passed = !finish && player && gateIndex < player.gate;
    const active = !finish && player && player.state === 'think' && player.gate === gateIndex;
    const panel = () => quad(a, b, { x: b.x, y: b.y - hb }, { x: a.x, y: a.y - ha });

    if (finish) {                                               // chequered banner
      for (let u = 0; u < 8; u++) for (let v = 0; v < 4; v++) {
        const pt = (uu, vv) => ({ x: lerp(a.x, b.x, uu / 8), y: lerp(a.y, b.y, uu / 8) - vv / 4 * lerp(ha, hb, uu / 8) });
        ctx.fillStyle = (u + v) % 2 ? '#1d1146' : '#ffffff';
        quad(pt(u, v), pt(u + 1, v), pt(u + 1, v + 1), pt(u, v + 1)); ctx.fill();
      }
    } else if (active) {
      ctx.fillStyle = 'rgba(255,194,51,.88)'; panel(); ctx.fill();
      ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 3;
      for (let i = 1; i < 6; i++) { ctx.beginPath(); ctx.moveTo(lerp(a.x, b.x, i / 6), lerp(a.y, b.y, i / 6)); ctx.lineTo(lerp(a.x, b.x, i / 6), lerp(a.y, b.y, i / 6) - lerp(ha, hb, i / 6)); ctx.stroke(); }
    } else if (!passed) {
      ctx.fillStyle = 'rgba(120,80,255,.22)'; panel(); ctx.fill();
    }
    const frame = finish ? '#1d1146' : passed ? '#22c56b' : active ? '#ffc233' : '#5b2bd6';
    ctx.strokeStyle = frame; ctx.lineCap = 'round';
    ctx.lineWidth = 9 * a.s; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x, a.y - ha); ctx.stroke();
    ctx.lineWidth = 9 * b.s; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - hb); ctx.stroke();
    ctx.lineWidth = 10 * zoom; ctx.beginPath(); ctx.moveTo(a.x, a.y - ha); ctx.lineTo(b.x, b.y - hb); ctx.stroke();

    const mx = (a.x + b.x) / 2, my = (a.y - ha + b.y - hb) / 2 - 18 * zoom;
    const label = finish ? 'FINISH' : passed ? '✓' : `Q${gateIndex + 1}`;
    ctx.font = `900 ${16 * zoom}px "Arial Rounded MT Bold",system-ui,sans-serif`;
    const w = ctx.measureText(label).width + 18 * zoom;
    ctx.fillStyle = frame; roundRect(ctx, mx - w / 2, my - 14 * zoom, w, 26 * zoom, 9 * zoom); ctx.fill();
    ctx.fillStyle = frame === '#ffc233' ? '#1d1146' : '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my - zoom);
    if (active) {
      ctx.font = `900 ${64 * zoom}px "Arial Rounded MT Bold",system-ui,sans-serif`; ctx.fillStyle = '#fff';
      ctx.fillText('?', (a.x + b.x) / 2, (a.y + b.y) / 2 - (ha + hb) / 4);
    }
  }

  function poseFor(r, t) {
    const ph = r.phase;
    switch (r.state) {
      case 'run': {
        const boosted = r.boost > 0;
        return { cycle: t * (boosted ? 20 : 14) + ph, lift: boosted ? 10 + Math.abs(Math.sin(t * 10 + ph)) * 8 : Math.abs(Math.sin(t * 14 + ph)) * 4, rot: boosted ? 0.14 : 0.06, arms: boosted ? 'up' : 'swing', face: 'happy', t };
      }
      case 'think': return { cycle: 0, lift: Math.abs(Math.sin(t * 3 + ph)) * 3, rot: 0, arms: 'idle', face: 'think', t };
      case 'stumble': {
        const e = STUMBLE_TIME - r.timer;
        const down = Math.min(1, e / 0.2), up = clamp((e - 1.1) / 0.6, 0, 1);
        return { cycle: 0, lift: 0, rot: 1.45 * down * (1 - up * up), arms: 'idle', face: 'dizzy', stars: e < 1.5, t };
      }
      case 'done': return { cycle: 0, lift: Math.abs(Math.sin(t * 6 + ph)) * 16, rot: 0, arms: 'up', face: 'happy', t };
      default: return { cycle: 0, lift: Math.abs(Math.sin(t * 4 + ph)) * 4, rot: 0, arms: 'idle', face: 'happy', t };
    }
  }

  function drawRunners(t) {
    const order = runners.slice().sort((a, b) => a.lane - b.lane);
    for (const r of order) {
      const lane = r.lane + (r.isPlayer ? 0 : Math.sin(t * 0.7 + r.phase) * 0.015);
      const p = proj(r.x, lane);
      if (p.x < -80 || p.x > W + 80) continue;
      if (r.isPlayer) {
        ctx.strokeStyle = '#ffc233'; ctx.lineWidth = 4 * zoom;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 30 * p.s, 10 * p.s, 0, 0, 7); ctx.stroke();
      }
      drawBean(ctx, p.x, p.y, p.s * 1.05, r, poseFor(r, t));
      if (r.isPlayer) {
        const bob = Math.sin(t * 6) * 4;
        ctx.fillStyle = '#ffc233'; ctx.beginPath();
        ctx.moveTo(p.x, p.y - 100 * p.s + bob); ctx.lineTo(p.x - 9, p.y - 116 * p.s + bob); ctx.lineTo(p.x + 9, p.y - 116 * p.s + bob); ctx.closePath(); ctx.fill();
        ctx.font = `900 ${13 * zoom}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = '#1d1146';
        ctx.fillText('YOU', p.x, p.y - 122 * p.s + bob);
      }
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(1 - p.age / p.life, 0, 1);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.age * p.spin);
      ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function render(dt, t) {
    if (!W || !round) return;
    const sheetOpen = !$('sheet').hidden;
    const avail = sheetOpen ? H - $('sheet').offsetHeight : H;
    const targetH = clamp(avail * 0.36, 120, 240);
    bandH = lerp(bandH, targetH, 1 - Math.pow(0.001, dt));
    const target = Math.max(avail * 0.56, 145 + bandH / 2);
    bandCenter = lerp(bandCenter || target, target, 1 - Math.pow(0.001, dt));
    bandTop = bandCenter - bandH / 2;
    cam = player ? player.x : 0;

    ctx.save();
    if (shake > 0) { ctx.translate(rand(-6, 6) * shake * 2, rand(-6, 6) * shake * 2); shake = Math.max(0, shake - dt); }
    drawBackground();
    drawTrack();
    for (let i = 0; i < round.cfg.gates; i++) drawGate(gateX(i), i);
    drawRunners(t);
    drawParticles();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ preview (lobby) */
  function renderPreview(t) {
    pctx.clearRect(0, 0, 220, 220);
    const grd = pctx.createLinearGradient(0, 0, 0, 220);
    grd.addColorStop(0, '#bfe7ff'); grd.addColorStop(1, '#9de6b8');
    pctx.fillStyle = grd; pctx.fillRect(0, 0, 220, 220);
    drawBean(pctx, 110, 175, 2.3, { color: save.color, hat: save.hat }, { cycle: 0, lift: Math.abs(Math.sin(t * 3)) * 10, rot: Math.sin(t * 3) * 0.05, arms: 'up', face: 'happy', t });
  }

  /* ------------------------------------------------------------------ main loop */
  let last = performance.now(), clock = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now; clock += dt;

    if (screenName === 'lobby') { renderPreview(clock); return; }
    if (screenName !== 'game') return;

    if (phase === 'race') {
      round.t += dt;
      for (const r of runners) stepRunner(r, dt);
      if (player.state === 'done' && !round.over) fastForward();
      if (!round.over) {
        updateMinimap();
        rankTimer -= dt; if (rankTimer <= 0) { rankTimer = 0.25; updateRankHud(); }
        if (player.awaiting) {
          const limit = save.relaxed ? GATE_TIME_RELAXED : GATE_TIME;
          const left = 1 - player.timer / limit;
          $('timerFill').style.width = `${clamp(left, 0, 1) * 100}%`;
          $('timerFill').classList.toggle('low', left < 0.3);
        }
      }
    }
    if (phase !== 'idle' && round) updateMinimap();
    if (sheetTimer > 0) { sheetTimer -= dt; if (sheetTimer <= 0 && !player.awaiting) $('sheet').hidden = true; }
    if (tickerTimer > 0) { tickerTimer -= dt; if (tickerTimer <= 0) $('ticker').textContent = ''; }
    updateParticles(dt);
    render(dt, clock);
  }

  /* ------------------------------------------------------------------ boot */
  buildLobby();
  show('lobby');
  requestAnimationFrame(frame);

  // Expose a little for debugging in the console.
  window.__stumble = { get run() { return run; }, get round() { return round; }, get runners() { return runners; }, get q() { return currentQ; }, save };
})();
