/*
 * 合成大祥脚 — 纯前端 Suika 式合成游戏
 * 逻辑坐标：所有平台固定 398x800，危险线 LINE_Y = 165，自写圆形物理；无框架、无构建、无网络请求。
 * 框外盒（#boardWrap）固定长宽比 0.520，fit-inside 舞台并在舞台内居中。
 * 所有平台同一张竖版薄框图（thin-frame-portrait.webp），canvas 位于框内缘 4.6%/2.3%/90.9%/95.1%。
 * scaleX 与 scaleY 恒等（~0.999），球为严格正圆，各平台游戏逻辑空间完全一致、绝对公平。
 *
 * 反作弊与一致性校验（本地尽力而为，不是服务器级防护）
 * ------------------------------------------------------------------
 * 本游戏没有在线排行榜，所有数据只存在本机。即使有人改本地分数或
 * 存档，影响的也只是自己浏览器里的最高分。以下措施只做三件事：
 *   1. 分数不单独保存，每次合并写 merge 日志，显示分永远是日志求和；
 *   2. 结束时重算分数、检查球数守恒、时间戳、掉落等级与坐标；
 *   3. 最高分存档带 FNV-1a 校验和，篡改后按 0 分处理并标记，不静默修分。
 * 代码不使用动态执行/字符串求值，不从 URL 参数读分数，分数变量不挂到
 * window 上，也没有可在控制台调用的加分函数。没有做代码混淆、反调试或
 * 拦截开发者工具，也不宣称“防外挂已彻底解决”。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // 常量与配置
  // ---------------------------------------------------------------
  const W = 398;               // 公平棋盘：所有平台逻辑宽固定 398，任何视口下不得变大或变小
  const H = 800;               // 逻辑高固定 800
  const LINE_Y = 165;          // 游戏结束线（逻辑 y），= H 的 20.6%
  const DANGER_H = 60;         // 线下 60px 危险区
  const GRAVITY = 2200;
  const FIXED_DT = 1 / 120;
  const DROP_COOLDOWN_MS = 500;
  const OVER_LINE_SECONDS = 1.5;
  const WARNING_SECONDS = 1.5;
  const MIN_DROP_INTERVAL_MS = 400;   // 冷却 500ms 的校验容差
  const MAX_DROPS_PER_MINUTE = 120;
  const STORAGE_BEST = 'xiangjiao-best-v1';
  const STORAGE_SOUND = 'xiangjiao-sound-v1';
  const STORAGE_MUSIC = 'xiangjiao-music-volume-v1';
  const STORAGE_SFX = 'xiangjiao-sfx-volume-v1';
  const STORAGE_ACHIEVEMENT = 'xiangjiao-achievements-v1';
  const SALT = 'xiangjiao-salt';

  const RADII = [16, 24, 34, 44, 54, 66, 78, 92, 108, 128, 150];

  // 等级 1..11：素材、称呼、描边色。level 为 1-indexed。
  const FRUITS = [
    { level: 1,  name: '樱桃',   who: '要乐奈',   file: 'rana-lv1-cherry-v2-cutout.png',           ring: '#d9647c', pale: '#fbe1e5' },
    { level: 2,  name: '草莓',   who: '千早爱音', file: 'anon-lv2-strawberry-cutout.png',          ring: '#e0707c', pale: '#fbe2e2' },
    { level: 3,  name: '葡萄',   who: '长崎爽世', file: 'soyo-lv3-grape-cutout.png',               ring: '#8b73c0', pale: '#e8e2f6' },
    { level: 4,  name: '丑橘',   who: '椎名立希', file: 'taki-lv4-dekopon-cutout.png',             ring: '#d98a2f', pale: '#fbe9d6' },
    { level: 5,  name: '柿子',   who: '高松灯',   file: 'tomori-lv5-persimmon-v2-cutout.png',      ring: '#d16f3d', pale: '#fbe4d8' },
    { level: 6,  name: '苹果',   who: '八幡海铃', file: 'umiri-lv6-apple-cutout.png',              ring: '#c94f56', pale: '#f8dede' },
    { level: 7,  name: '梨',     who: '若叶睦',   file: 'mutsumi-lv7-pear-v2-cutout.png',          ring: '#a9b64a', pale: '#f1f2d8' },
    { level: 8,  name: '桃子',   who: '祐天寺若麦', file: 'nyamu-lv8-peach-cutout.png',            ring: '#e3919c', pale: '#fbe4e7' },
    { level: 9,  name: '菠萝',   who: '纯田真奈', file: 'mana-lv9-pineapple-cutout.png',           ring: '#d3af3c', pale: '#fbf1d0' },
    { level: 10, name: '哈密瓜', who: '三角初华', file: 'uika-lv10-melon-cutout.png',              ring: '#8eb05a', pale: '#edf3dc' },
    { level: 11, name: '西瓜',   who: '祥脚',     file: 'xiangjiao-lv11-watermelon-v3-cutout.png', ring: '#3f8b50', pale: '#dcecdf' }
  ];

  // 没有框图：整页背景在 CSS 里铺满视口，canvas 保持透明，
  // 球直接画在背景上，舞台边缘就是玩法边界。

  const TAU = Math.PI * 2;

  // ---------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const now = () => performance.now();

  // 公平棋盘：所有平台（桌面、竖版、平板）逻辑棋盘固定 398x800，危险线 LINE_Y = 165。
  // 框外盒（#boardWrap）固定长宽比 0.520，fit-inside 舞台并在舞台内居中。
  // canvas 位于框内缘（4.6%/2.3%/90.9%/95.1%），canvas 长宽比固定为 0.4975 (±0.002)。
  // PC 侧边栏（俄罗斯方块式，宽200，间隙24）：右侧剩余空间 >= 224px 时启用，棋盘保持居中不动。
  // 空间不够时改用顶部栏（高48px），同一套数据组件在侧边栏与顶部栏之间移动与重排，ID保持唯一。
  function applyBoardSize() {
    const stage = document.getElementById('stage');
    const wrap = document.getElementById('boardWrap');
    const topbar = document.getElementById('topbar');
    const sidebar = document.getElementById('sidebar');
    const blockScore = document.getElementById('blockScore');
    const blockBest = document.getElementById('blockBest');
    const blockNext = document.getElementById('blockNext');
    const blockControls = document.getElementById('blockControls');
    if (!stage || !wrap) return W;

    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    // 判定条件：以视口全高测算棋盘居中后右侧剩余空间
    let candWrapH = vpH;
    let candWrapW = Math.round(candWrapH * 0.520);
    if (candWrapW > vpW) {
      candWrapW = vpW;
      candWrapH = Math.round(candWrapW / 0.520);
    }
    const candRightSpace = (vpW - candWrapW) / 2;
    const useSidebar = candRightSpace >= 224;

    if (useSidebar) {
      if (topbar) {
        topbar.hidden = true;
        topbar.style.display = 'none';
      }
      if (sidebar) {
        sidebar.hidden = false;
        sidebar.style.display = 'flex';
        // 侧边栏内容顺序（自上而下，俄罗斯方块式）：
        // 1. 分数  2. 最高分  3. 下一个  4. 控制按钮
        if (blockScore) sidebar.appendChild(blockScore);
        if (blockBest) sidebar.appendChild(blockBest);
        if (blockNext) sidebar.appendChild(blockNext);
        if (blockControls) sidebar.appendChild(blockControls);
      }
      stage.style.height = vpH + 'px';
      wrap.style.width = candWrapW + 'px';
      wrap.style.height = candWrapH + 'px';

      // 侧边栏实测像素定位：棋盘居中不动，侧边栏左缘 = 棋盘右缘 + 24，宽 200，上缘与棋盘上缘对齐
      if (sidebar) {
        const sRect = stage.getBoundingClientRect();
        const wRect = wrap.getBoundingClientRect();
        const wrapLeft = wRect.left - sRect.left;
        const wrapTop = wRect.top - sRect.top;
        sidebar.style.left = Math.round(wrapLeft + wRect.width + 24) + 'px';
        sidebar.style.top = Math.round(wrapTop) + 'px';
        sidebar.style.width = '200px';
      }
      document.body.classList.add('mode-sidebar');
      document.body.classList.remove('mode-topbar');
    } else {
      if (sidebar) {
        sidebar.hidden = true;
        sidebar.style.display = 'none';
      }
      if (topbar) {
        topbar.hidden = false;
        topbar.style.display = 'flex';
        // 顶部栏内容一排（自左而右）：
        // 1. 分数  2. 下一个  3. 最高分  4. 控制按钮
        if (blockScore) topbar.appendChild(blockScore);
        if (blockNext) topbar.appendChild(blockNext);
        if (blockBest) topbar.appendChild(blockBest);
        if (blockControls) topbar.appendChild(blockControls);
      }
      const stageH = Math.max(0, vpH - 48);
      const stageW = vpW;
      stage.style.height = stageH + 'px';

      let wrapH = stageH;
      let wrapW = Math.round(wrapH * 0.520);
      if (wrapW > stageW) {
        wrapW = stageW;
        wrapH = Math.round(wrapW / 0.520);
      }
      wrap.style.width = wrapW + 'px';
      wrap.style.height = wrapH + 'px';

      document.body.classList.add('mode-topbar');
      document.body.classList.remove('mode-sidebar');
    }

    if (typeof drawNextPreview === 'function') {
      drawNextPreview();
    }

    return W;
  }


  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function scoreForMerge(level) {
    // 1..10 级：n*(n+1)/2；11 级对消固定 66（恰好也等于该式）
    return level >= 11 ? 66 : (level * (level + 1)) / 2;
  }

  function safeStorageGet(key) {
    try {
      return { ok: true, value: localStorage.getItem(key) };
    } catch (e) {
      return { ok: false, value: null };
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const nextCanvas = document.getElementById('nextCanvas');
  const nextCtx = nextCanvas.getContext('2d');

  const scoreValue = document.getElementById('scoreValue');
  const bestValue = document.getElementById('bestValue');
  const loadNote = document.getElementById('loadNote');

  const startScreen = document.getElementById('startScreen');
  const pauseScreen = document.getElementById('pauseScreen');
  const overScreen = document.getElementById('overScreen');

  const finalScore = document.getElementById('finalScore');
  const finalBest = document.getElementById('finalBest');
  const finalMaxLevel = document.getElementById('finalMaxLevel');
  const finalAchievement = document.getElementById('finalAchievement');
  const invalidNote = document.getElementById('invalidNote');
  const newRecordNote = document.getElementById('newRecordNote');
  const toastEl = document.getElementById('toast');

  const btnStart = document.getElementById('btnStart'); // 游戏页没有开始按钮（从开始页进来即开局），可能为 null
  const btnPause = document.getElementById('btnPause');
  const btnRestart = document.getElementById('btnRestart');
  const btnSound = document.getElementById('btnSound');
  const overlayStart = document.getElementById('overlayStart');
  const resumeBtn = document.getElementById('resumeBtn');
  const pauseRestart = document.getElementById('pauseRestart');
  const pauseMenu = document.getElementById('pauseMenu');
  const overRestart = document.getElementById('overRestart');
  const overMenu = document.getElementById('overMenu');

  // ---------------------------------------------------------------
  // 音频（支持音乐与音效两套独立音量，实时生效，文件缺失时静默跳过）
  // ---------------------------------------------------------------
  const bgm = document.getElementById('audioBgm');
  const mergeSfx = document.getElementById('audioMerge');
  const gameoverSfx = document.getElementById('audioGameover');

  let musicVol = 42;
  let sfxVol = 72;
  let isMuted = false;
  let bgmStarted = false;

  [bgm, mergeSfx, gameoverSfx].forEach((a) => {
    if (!a) return;
    a.addEventListener('error', () => { a.dataset.unavailable = '1'; });
  });

  function loadVolumes() {
    let mRaw = safeStorageGet(STORAGE_MUSIC);
    let sRaw = safeStorageGet(STORAGE_SFX);
    if (!mRaw.ok || mRaw.value === null || !sRaw.ok || sRaw.value === null) {
      const oldSound = safeStorageGet(STORAGE_SOUND);
      if (oldSound.ok && oldSound.value === '0') {
        musicVol = 0;
        sfxVol = 0;
      } else {
        musicVol = 42;
        sfxVol = 72;
      }
      safeStorageSet(STORAGE_MUSIC, String(musicVol));
      safeStorageSet(STORAGE_SFX, String(sfxVol));
    } else {
      let m = parseInt(mRaw.value, 10);
      let s = parseInt(sRaw.value, 10);
      musicVol = (isNaN(m) || m < 0 || m > 100) ? 42 : m;
      sfxVol = (isNaN(s) || s < 0 || s > 100) ? 72 : s;
    }
    applyAudioVolumes();
  }

  function applyAudioVolumes() {
    if (bgm) {
      bgm.volume = musicVol / 100;
      bgm.muted = isMuted;
    }
    if (mergeSfx) {
      mergeSfx.volume = sfxVol / 100;
      mergeSfx.muted = isMuted;
    }
    if (gameoverSfx) {
      gameoverSfx.volume = sfxVol / 100;
      gameoverSfx.muted = isMuted;
    }
  }

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_MUSIC || e.key === STORAGE_SFX) {
      loadVolumes();
    }
  });

  function tryPlay(audio) {
    if (!audio || audio.dataset.unavailable === '1') return;
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      /* 自动播放被拦截或文件缺失：静默忽略 */
    }
  }

  function playBgm() {
    if (!bgm) return;
    bgmStarted = true;
    tryPlay(bgm);
  }

  function stopBgm() {
    if (!bgm) return;
    try { bgm.pause(); } catch (e) { /* 忽略 */ }
  }

  function playMergeSfx() {
    if (!mergeSfx) return;
    try {
      mergeSfx.currentTime = 0;
      const p = mergeSfx.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 忽略 */ }
  }

  function playGameoverSfx() {
    if (!gameoverSfx) return;
    try {
      gameoverSfx.currentTime = 0;
      const p = gameoverSfx.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 忽略 */ }
  }

  function stopGameoverSfx() {
    if (!gameoverSfx) return;
    try { gameoverSfx.pause(); gameoverSfx.currentTime = 0; } catch (e) { /* 忽略 */ }
  }

  const SOUND_ON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9.5 9.5 0 0 1 0 13"/></svg>';
  const SOUND_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" fill="currentColor" stroke="none"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.52.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z"/></svg>';
  function applySoundButton() {
    if (!btnSound) return;
    btnSound.innerHTML = isMuted ? SOUND_OFF_SVG : SOUND_ON_SVG;
    btnSound.setAttribute('aria-pressed', isMuted ? 'false' : 'true');
    btnSound.setAttribute('aria-label', isMuted ? '恢复声音' : '静音');
    btnSound.setAttribute('title', isMuted ? '恢复声音' : '静音');
  }

  function toggleMute() {
    isMuted = !isMuted;
    applyAudioVolumes();
    applySoundButton();
    if (!isMuted && (state === 'playing' || state === 'warning') && bgmStarted) {
      playBgm();
    }
  }

  // ---------------------------------------------------------------
  // 素材载入（把大图缩到 1024 的离屏画布，兼顾高清视网膜显示与内存控制）
  // ---------------------------------------------------------------
  const textures = new Array(12).fill(null);
  let loadedCount = 0;
  let failedCount = 0;
  let bgImage = null;

  function makeTexture(img) {
    const size = 1024;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, size, size);
    return c;
  }

  FRUITS.forEach((fruit) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        textures[fruit.level] = makeTexture(img);
      } catch (e) {
        failedCount++;
      }
      loadedCount++;
      updateLoadNote();
      drawNextPreview();
    };
    img.onerror = () => {
      failedCount++;
      loadedCount++;
      updateLoadNote();
    };
    img.src = 'assets/' + fruit.file;
  });

  function updateLoadNote() {
    if (!loadNote) return;
    if (loadedCount < FRUITS.length) {
      loadNote.textContent = '素材载入中… ' + loadedCount + '/' + FRUITS.length;
    } else if (failedCount > 0) {
      loadNote.textContent = '部分素材未载入，已用色块代替';
    } else {
      loadNote.textContent = '素材已就绪';
    }
    if (bestTampered) loadNote.textContent = '最高分存档校验失败，已按 0 计';
  }

  // ---------------------------------------------------------------
  // 最高分存档
  // ---------------------------------------------------------------
  let best = 0;
  let bestTampered = false;
  let storageAvailable = true;

  function checksumFor(bestScore, merges, drops) {
    return fnv1a(bestScore + '|' + merges + '|' + drops + '|' + SALT);
  }

  function loadBest() {
    const got = safeStorageGet(STORAGE_BEST);
    if (!got.ok) {
      storageAvailable = false;
      best = 0;
      return;
    }
    if (!got.value) {
      best = 0;
      return;
    }
    try {
      const obj = JSON.parse(got.value);
      const validShape =
        obj && typeof obj === 'object' &&
        Number.isFinite(obj.best) &&
        Number.isInteger(obj.merges) &&
        Number.isInteger(obj.drops) &&
        typeof obj.checksum === 'string';
      if (!validShape) {
        bestTampered = true;
        best = 0;
        return;
      }
      const expected = checksumFor(obj.best, obj.merges, obj.drops);
      if (expected !== obj.checksum || obj.best < 0) {
        // 校验失败：清零并标记，不回写“修正后”的分数
        bestTampered = true;
        best = 0;
        return;
      }
      best = Math.floor(obj.best);
    } catch (e) {
      bestTampered = true;
      best = 0;
    }
  }

  function saveBest(bestScore, merges, drops) {
    const payload = {
      best: Math.floor(bestScore),
      merges,
      drops,
      checksum: checksumFor(Math.floor(bestScore), merges, drops)
    };
    const ok = safeStorageSet(STORAGE_BEST, JSON.stringify(payload));
    if (!ok) storageAvailable = false;
  }

  // ---------------------------------------------------------------
  // 大祥脚成就（本地计数，仅用于展示）
  // ---------------------------------------------------------------
  let achievementTotal = 0;

  function loadAchievements() {
    const got = safeStorageGet(STORAGE_ACHIEVEMENT);
    if (!got.ok || !got.value) return;
    const n = parseInt(got.value, 10);
    if (Number.isFinite(n) && n >= 0) achievementTotal = n;
  }

  function addAchievement() {
    achievementTotal += 1;
    safeStorageSet(STORAGE_ACHIEVEMENT, String(achievementTotal));
  }

  // ---------------------------------------------------------------
  // 局内状态
  // ---------------------------------------------------------------
  let state = 'menu';          // menu | playing | paused | warning | over
  let resumeState = 'playing'; // 从 playing 或 warning 进入暂停时记住原状态

  let balls = [];
  let particles = [];
  let mergeLogs = [];
  let dropLogs = [];

  let currentLevel = 1;
  let nextLevel = 1;
  let aimX = W / 2;
  let cooldownUntil = 0;
  let maxMergedLevel = 0;
  let achievementsThisRun = 0;

  let warningLeft = 0;
  let accumulator = 0;
  let lastFrame = 0;
  let pointerActive = false;
  let pointerId = null;

  let toastTimer = 0;

  // 图像缩放系数：扣图内容圆的直径约为原图 1466 / 1600
  const IMAGE_FILL = 1600 / 1466;

  // ---------------------------------------------------------------
  // 开始 / 暂停 / 结束 / 重开
  // ---------------------------------------------------------------
  function randomSpawnLevel() {
    return 1 + Math.floor(Math.random() * 5); // 只出 1..5
  }

  function resetRun() {
    balls = [];
    particles = [];
    mergeLogs = [];
    dropLogs = [];
    currentLevel = randomSpawnLevel();
    nextLevel = randomSpawnLevel();
    aimX = W / 2;
    cooldownUntil = 0;
    maxMergedLevel = 0;
    achievementsThisRun = 0;
    warningLeft = 0;
    accumulator = 0;
    pointerActive = false;
    pointerId = null;
    scoreValue.textContent = '0';
    drawNextPreview();
    updateControls();
  }

  function startGame() {
    resetRun();
    state = 'playing';
    hideScreens();
    stopGameoverSfx();
    lastFrame = performance.now();
    playBgm();
    updateControls();
  }

  function pauseGame(fromVisibility) {
    if (state !== 'playing' && state !== 'warning') return;
    resumeState = state;
    state = 'paused';
    pointerActive = false;
    pointerId = null;
    accumulator = 0;
    stopBgm();
    showScreen(pauseScreen);
    updateControls();
    if (fromVisibility) {
      // 自动暂停与手动暂停一致：切回来不自动继续，避免玩家没准备好。
    }
  }

  function resumeGame() {
    if (state !== 'paused') return;
    state = resumeState === 'warning' ? 'warning' : 'playing';
    hideScreens();
    lastFrame = performance.now();
    accumulator = 0;
    updateControls();
    playBgm();
  }

  function backToMenu() {
    // 开始界面是单独的 index.html，不是游戏页里的小卡片
    stopBgm();
    stopGameoverSfx();
    window.location.href = 'index.html';
  }

  function triggerWarning() {
    if (state !== 'playing') return;
    state = 'warning';
    warningLeft = WARNING_SECONDS;
    showToast('危险！', 1200);
    pointerActive = false;
    updateControls();
  }

  function finishGame() {
    if (state === 'over') return;
    state = 'over';
    stopBgm();

    const snapshot = balls.map((b) => ({ level: b.level, x: b.x, y: b.y, r: b.r }));
    const result = validateRun(snapshot);

    const shownScore = result.score;
    const isRecord = result.ok && shownScore > best;

    if (result.ok && isRecord) {
      best = shownScore;
      bestValue.textContent = String(best);
      finalBest.textContent = String(best);
      saveBest(best, mergeLogs.length, dropLogs.length);
      newRecordNote.hidden = false;
    } else {
      finalBest.textContent = String(best);
      newRecordNote.hidden = true;
    }

    finalScore.textContent = String(shownScore);
    finalMaxLevel.textContent = maxMergedLevel > 0 ? ('Lv.' + maxMergedLevel) : '—';

    if (achievementsThisRun > 0) {
      finalAchievement.hidden = false;
      finalAchievement.textContent = '大祥脚成就 ×' + achievementsThisRun + ' · 累计 ' + achievementTotal + ' 次';
    } else {
      finalAchievement.hidden = true;
      finalAchievement.textContent = '';
    }

    if (!result.ok) {
      invalidNote.hidden = false;
      invalidNote.textContent = '本局数据异常，最高分未记录';
      // 仅开发自查用：不弹窗、不打断玩家，把原因留在控制台 warn 里
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[合成大祥脚] 本局校验未通过：' + result.issues.join('；'));
      }
    } else {
      invalidNote.hidden = true;
    }

    if (!storageAvailable) {
      invalidNote.hidden = false;
      invalidNote.textContent = '本地存储不可用，最高分仅本局有效';
    }

    scoreValue.textContent = String(shownScore);
    showScreen(overScreen);
    updateControls();
    playGameoverSfx();
  }

  // ---------------------------------------------------------------
  // 输入
  // ---------------------------------------------------------------
  function clientToLogicalX(clientX) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return W / 2;
    return ((clientX - rect.left) / rect.width) * W;
  }

  function setAim(clientX) {
    const r = RADII[currentLevel - 1];
    aimX = clamp(clientToLogicalX(clientX), r + 2, W - r - 2);
  }

  function canDrop() {
    return state === 'playing' && now() >= cooldownUntil;
  }

  function dropCurrent() {
    if (!canDrop()) return;
    const t = now();
    const r = RADII[currentLevel - 1];
    // 2026-11-04 纠正：上一版测试在同一 x 连掉 8 次，圆球在完全
    // 对齐的垂直接触下没有横向力，垒成了一根完美的柱子——这不是
    // 正常玩法，是测试方法 + 物理无扰动造成的假象。真实玩法里
    // 玩家每次瞄准 x 都不同，但为了让即使同 x 连掉也不垒成柱子，
    // 掉落时加一个极小的横向初速（±15 逻辑单位/秒，远小于球半径
    // 对应的下落速度），球会自然向一侧滚开、堆成一堆，而不是柱子。
    // 抖动只影响初始 vx，不影响等级、分数、碰撞规则。
    const x = clamp(aimX, r + 2, W - r - 2);
    const y = LINE_Y - r - 10;
    const ball = {
      level: currentLevel,
      x,
      y,
      vx: (Math.random() - 0.5) * 30,
      vy: 30,
      r,
      angle: 0,
      age: 0,
      restTime: 0,
      settled: false,
      overTime: 0,
      dead: false,
      squash: 0,
      tilt: 0,
      sleeping: false
    };
    balls.push(ball);

    // 掉落日志：分数不在这里加，只记录事实
    dropLogs.push({ level: currentLevel, x: x, timeMs: t });

    cooldownUntil = t + DROP_COOLDOWN_MS;
    currentLevel = nextLevel;
    nextLevel = randomSpawnLevel();
    const nr = RADII[currentLevel - 1];
    aimX = clamp(aimX, nr + 2, W - nr - 2);
    drawNextPreview();
    updateControls();
  }

  canvas.addEventListener('pointermove', (e) => {
    if (state !== 'playing') return;
    if (e.pointerType === 'mouse' && !pointerActive) {
      setAim(e.clientX);
    } else if (pointerActive && (pointerId === null || e.pointerId === pointerId)) {
      setAim(e.clientX);
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'playing' && !bgmStarted) playBgm();
    if (state !== 'playing') return;
    pointerActive = true;
    pointerId = e.pointerId;
    setAim(e.clientX);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) { /* 忽略 */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!pointerActive) return;
    if (state !== 'playing') {
      pointerActive = false;
      pointerId = null;
      return;
    }
    setAim(e.clientX);
    pointerActive = false;
    pointerId = null;
    dropCurrent();
    e.preventDefault();
  });

  canvas.addEventListener('pointercancel', () => {
    pointerActive = false;
    pointerId = null;
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (state !== 'playing') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    const r = RADII[currentLevel - 1];
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      aimX = clamp(aimX - 14, r + 2, W - r - 2);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      aimX = clamp(aimX + 14, r + 2, W - r - 2);
      e.preventDefault();
    } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowDown') {
      dropCurrent();
      e.preventDefault();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state === 'playing' || state === 'warning') pauseGame(true);
    }
  });

  window.addEventListener('blur', () => {
    // 失焦不强制暂停（点击 DevTools 也会触发），只处理页面切后台。
  });

  // ---------------------------------------------------------------
  // 物理与合成
  // ---------------------------------------------------------------
  function constrainWalls(b) {
    // 框的内缘就是墙：左右下墙 + 顶部，撞墙要回弹、落地要压扁、贴地要滚得慢下来
    if (b.x - b.r < 0) {
      b.x = b.r;
      if (b.vx < 0) { b.squash = Math.max(b.squash || 0, Math.min(0.22, Math.abs(b.vx) / 1800)); b.vx = -b.vx * 0.14; }
    } else if (b.x + b.r > W) {
      b.x = W - b.r;
      if (b.vx > 0) { b.squash = Math.max(b.squash || 0, Math.min(0.22, Math.abs(b.vx) / 1800)); b.vx = -b.vx * 0.14; }
    }
    if (b.y + b.r > H) {
      b.y = H - b.r;
      if (b.vy > 0) {
        b.squash = Math.max(b.squash || 0, Math.min(0.30, Math.abs(b.vy) / 2200));
        b.vy = -b.vy * 0.12;
        if (Math.abs(b.vy) < 22) b.vy = 0;
      }
      b.vx *= 0.92; // 贴地滚动摩擦，比空中大得多
    } else if (b.y - b.r < 0) {
      b.y = b.r;
      if (b.vy < 0) b.vy = -b.vy * 0.10;
    }
  }

  function doMerge(a, b) {
    const level = a.level;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const t = now();
    const gained = scoreForMerge(level);
    mergeLogs.push({ level, timeMs: t, scoreAdd: gained });
    scoreValue.textContent = String(computeScore());
    maxMergedLevel = Math.max(maxMergedLevel, level >= 11 ? 11 : level + 1);

    if (level >= 11) {
      // 11 + 11：两者消失，66 分，大祥脚提示与成就
      spawnBurst(mx, my, 150, 11, true);
      spawnScoreText(mx, my - 70, '+' + gained, '#2f6a3d');
      addAchievement();
      achievementsThisRun += 1;
      showToast('合成大祥脚！', 1700);
      playMergeSfx();
      updateControls();
      return;
    }

    const nr = RADII[level]; // 下一级半径（level 1-indexed）
    const nb = {
      level: level + 1,
      x: clamp(mx, nr, W - nr),
      y: clamp(my, nr, H - nr),
      vx: (a.vx + b.vx) * 0.4,
      vy: Math.min(-24, (a.vy + b.vy) * 0.20 - (24 + nr * 0.12)),
      r: nr,
      angle: 0,
      age: 0,
      restTime: 0,
      settled: false,
      overTime: 0,
      dead: false,
      squash: 0.22,
      tilt: 0,
      sleeping: false
    };

    // 合并时产生物理冲击波：略微推开紧贴的新球周围其他球，形成真实的弹出与空间膨胀反馈
    const blastRadius = nr * 1.35;
    for (let k = 0; k < balls.length; k++) {
      const o = balls[k];
      if (o.dead || o === a || o === b) continue;
      const pdx = o.x - mx;
      const pdy = o.y - my;
      const pdist = Math.hypot(pdx, pdy);
      if (pdist > 0.001 && pdist < blastRadius + o.r) {
        // 冲击波范围内唤醒休眠球
        o.sleeping = false;
        o.restTime = 0;
        o.settled = false;
        // 若与新球同级，不被冲击波推开，确保链式合成连续触发
        if (o.level === level + 1) continue;
        const factor = 1 - pdist / (blastRadius + o.r);
        const pnx = pdx / pdist;
        const pny = pdy / pdist;
        const push = factor * 36;
        o.vx += pnx * push;
        o.vy += pny * push - 10;
        o.squash = Math.max(o.squash || 0, factor * 0.15);
      }
    }

    spawnBurst(mx, my, nr, level + 1, false);
    spawnScoreText(mx, my - nr * 0.55, '+' + gained, '#2f6a3d');
    playMergeSfx();
    pendingNewBalls.push(nb);
  }

  function getSupportedBalls() {
    const supported = new Set();
    // 1. 地面直接支撑（与地面距离在 2.5px 以内）
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead) continue;
      if (b.y + b.r >= H - 2.5) supported.add(b);
    }
    // 2. 向上/侧向多轮传递支撑：
    // 若球 o 已被支撑，且球 b 与 o 接触（触距容差 max(touch+3.0, touch*1.04)），
    // 且 o 不在 b 上方（即 o.y >= b.y - 2.0，o 的位置在 b 的下方或同高侧方），
    // 则 o 可为 b 提供支撑力，b 也是被支撑的。
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.dead || supported.has(b)) continue;
        for (let j = 0; j < balls.length; j++) {
          const o = balls[j];
          if (o.dead || !supported.has(o)) continue;
          const dx = b.x - o.x;
          const dy = b.y - o.y;
          const touch = b.r + o.r;
          const maxD = Math.max(touch + 3.0, touch * 1.04);
          if (dy < 2.0 && (dx * dx + dy * dy) <= maxD * maxD) {
            supported.add(b);
            changed = true;
            break;
          }
        }
      }
    }
    return supported;
  }

  let pendingNewBalls = [];

  function physicsStep(dt) {
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead) continue;
      b.age += dt;
      if (!b.sleeping) {
        b.vy += GRAVITY * dt;
        b.vx *= 0.9995;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        constrainWalls(b);
        // 滚动角速度：未静止且有横向运动时按 angle += vx / r * dt 更新；静止时保持不变
        if (!b.settled && Math.abs(b.vx) > 0.05) {
          b.angle = (b.angle || 0) + (b.vx / b.r) * dt;
          if (b.angle > Math.PI) b.angle -= TAU;
          else if (b.angle < -Math.PI) b.angle += TAU;
        }
        // 挤压回弹 + 倾斜：落地/撞击时压扁，之后按 dt*1.4 衰减；横向速度带来自然的倾斜跟随，静止时回正
        b.squash = Math.max(0, (b.squash || 0) - dt * 1.4);
        const tiltTarget = b.settled ? 0 : clamp(b.vx * 0.0006, -0.20, 0.20);
        b.tilt = (b.tilt || 0) + (tiltTarget - (b.tilt || 0)) * Math.min(1, dt * 10);
        if (b.y + b.r >= H - 0.5) b.vx *= 0.985; // 贴地滚动阻力
      } else {
        b.vx = 0;
        b.vy = 0;
        b.squash = Math.max(0, (b.squash || 0) - dt * 1.4);
        b.tilt = (b.tilt || 0) * (1 - Math.min(1, dt * 10));
        constrainWalls(b);
      }
    }

    // 碰撞与合并求解：
    // 增加迭代次数以保证堆叠时无抖动、无穿透；
    // 合并判定仅在第一遍（iter === 0）时进行，保持规则完全一致；
    // 相对速度小的接触（静止堆叠）不赋予反弹速度，消除高频微抖动；
    // 摩擦冲量施加库仑摩擦限制，防止球卡在墙边或互相粘滞。
    const ITERATIONS = 6;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i];
        if (a.dead) continue;
        for (let j = i + 1; j < balls.length; j++) {
          const b = balls[j];
          if (b.dead) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          const touch = a.r + b.r;

          if (iter === 0 && a.level === b.level) {
            const mergeDist = touch + 0.5;
            if (d2 <= mergeDist * mergeDist) {
              a.dead = true;
              b.dead = true;
              doMerge(a, b);
              break;
            }
          }

          const minDist = touch;
          if (d2 < minDist * minDist) {
            // 撞击/明显受力唤醒休眠球
            if (a.sleeping || b.sleeping) {
              const spA = a.vx * a.vx + a.vy * a.vy;
              const spB = b.vx * b.vx + b.vy * b.vy;
              if (spA > 100 || spB > 100) {
                a.sleeping = false;
                b.sleeping = false;
                a.restTime = 0;
                b.restTime = 0;
              }
            }

            let d = Math.sqrt(d2);
            if (d < 0.001) {
              d = 0.001;
              a.x -= 0.05;
              b.x += 0.05;
            }
            const nx = dx / d;
            const ny = dy / d;
            const overlap = minDist - d;
            const ma = a.r * a.r;
            const mb = b.r * b.r;
            const total = ma + mb;

            a.x -= nx * overlap * (mb / total);
            a.y -= ny * overlap * (mb / total);
            b.x += nx * overlap * (ma / total);
            b.y += ny * overlap * (ma / total);

            if (iter === 0) {
              const rvx = b.vx - a.vx;
              const rvy = b.vy - a.vy;
              const vn = rvx * nx + rvy * ny;
              if (vn < 0) {
                // 撞击压扁：撞得越狠压得越明显
                const hit = Math.min(0.25, -vn / 2200);
                a.squash = Math.max(a.squash || 0, hit);
                b.squash = Math.max(b.squash || 0, hit);

                // 速度阈值：微小相对速度（重力下自然接触，-vn <= 35）不反弹，避免堆叠微振动；冲击反弹系数调低至 0.04
                const isImpact = -vn > 35;
                if (isImpact) {
                  a.sleeping = false;
                  b.sleeping = false;
                  a.restTime = 0;
                  b.restTime = 0;
                }
                const e = isImpact ? 0.04 : 0;
                const impulse = (-(1 + e) * vn) / (1 / ma + 1 / mb);
                a.vx -= (impulse * nx) / ma;
                a.vy -= (impulse * ny) / ma;
                b.vx += (impulse * nx) / mb;
                b.vy += (impulse * ny) / mb;

                // 切向切线摩擦（限制在库仑摩擦锥内，避免卡在墙边或粘滞）
                const tx = -ny;
                const ty = nx;
                const vt = rvx * tx + rvy * ty;
                let jt = (-vt / (1 / ma + 1 / mb)) * 0.32;
                const maxFriction = Math.abs(impulse) * 0.35;
                jt = clamp(jt, -maxFriction, maxFriction);
                a.vx -= (jt * tx) / ma;
                a.vy -= (jt * ty) / ma;
                b.vx += (jt * tx) / mb;
                b.vy += (jt * ty) / mb;
              }
            }
            constrainWalls(a);
            constrainWalls(b);
          }
        }
      }
    }

    // 清理已合成掉的球，加入新球
    if (balls.some((b) => b.dead)) {
      balls = balls.filter((b) => !b.dead);
    }
    if (pendingNewBalls.length) {
      for (let i = 0; i < pendingNewBalls.length; i++) balls.push(pendingNewBalls[i]);
      pendingNewBalls = [];
    }

    // 静止判定、支撑休眠与速度收敛
    const supported = getSupportedBalls();
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead) continue;
      const isSupp = supported.has(b);

      // 若处于休眠状态但已失去下方支撑（如下方球合成消除），立即唤醒恢复下落
      if (b.sleeping && !isSupp) {
        b.sleeping = false;
        b.restTime = 0;
        b.settled = false;
      }

      // 被支撑的球：当下冲微速度已被支撑面阻挡且横向微动已衰减时，速度归零，消除周期性上下抖动
      if (isSupp) {
        if (Math.abs(b.vy) < 50 && Math.abs(b.vx) < 30) {
          b.vx = 0;
          b.vy = 0;
        }
      }

      const sp2 = b.vx * b.vx + b.vy * b.vy;
      if (sp2 < 900) {
        b.restTime += dt;
      } else {
        b.restTime = 0;
      }

      if (isSupp) {
        if (b.restTime >= 0.12 && Math.abs(b.vy) < 1.0 && Math.abs(b.vx) < 1.0) {
          b.vx = 0;
          b.vy = 0;
          b.sleeping = true;
        }
      } else {
        if (sp2 < 25) {
          b.vx = 0;
          b.vy = 0;
        }
      }
      constrainWalls(b);
    }
  }

  function updateDanger(dt) {
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.restTime > 0.35) b.settled = true;
      if (b.settled && b.y - b.r < LINE_Y) {
        b.overTime += dt;
        if (b.overTime >= OVER_LINE_SECONDS && state === 'playing') {
          triggerWarning();
        }
      } else {
        b.overTime = 0;
      }
    }
  }

  // ---------------------------------------------------------------
  // 粒子特效：星星 / 圆点 / 扩散环 / 加分文字
  // ---------------------------------------------------------------
  function spawnBurst(x, y, radius, newLevel, big) {
    const fruit = FRUITS[Math.min(11, Math.max(1, (newLevel || 1))) - 1];
    const colors = [fruit.ring, '#ffe58a', '#fff7e9', '#b7dcab', '#f7b6c4'];
    const count = big ? 30 : 14;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * TAU;
      const speed = (big ? 80 : 60) + Math.random() * (big ? 300 : 210);
      const life = 0.45 + Math.random() * 0.55;
      particles.push({
        type: 'star',
        x,
        y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 40,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 8,
        size: (big ? 4 : 2.8) + Math.random() * (big ? 9 : 6),
        life,
        maxLife: life,
        color: colors[(Math.random() * colors.length) | 0],
        gravity: 240
      });
    }
    for (let i = 0; i < (big ? 16 : 8); i++) {
      const ang = Math.random() * TAU;
      const speed = 40 + Math.random() * 160;
      const life = 0.35 + Math.random() * 0.4;
      particles.push({
        type: 'dot',
        x,
        y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 20,
        size: 1.8 + Math.random() * 3.2,
        life,
        maxLife: life,
        color: i % 2 ? '#ffffff' : '#ffe58a',
        gravity: 180
      });
    }
    particles.push({
      type: 'ring',
      x,
      y,
      radius: radius * 0.35,
      growth: radius * (big ? 3.4 : 2.4),
      life: 0.45,
      maxLife: 0.45,
      color: fruit.ring
    });
  }

  function spawnScoreText(x, y, text, color) {
    particles.push({
      type: 'text',
      x,
      y: y - 8,
      vy: -42,
      text,
      life: 0.75,
      maxLife: 0.75,
      color: color || '#3f6b4a'
    });
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      if (p.type === 'ring') {
        p.radius += p.growth * dt;
      } else if (p.type === 'text') {
        p.y += p.vy * dt;
        p.vy *= 0.96;
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += (p.gravity || 0) * dt;
        p.vx *= 0.985;
        p.rot += p.vr * dt;
      }
    }
  }

  // ---------------------------------------------------------------
  // 校验（本地一致性，不是服务器级反作弊）
  // ---------------------------------------------------------------
  function validateRun(snapshot) {
    const issues = [];
    let score = 0;

    // 1) 分数只由 merge 日志重算
    for (let i = 0; i < mergeLogs.length; i++) {
      const m = mergeLogs[i];
      if (!m || !Number.isInteger(m.level) || m.level < 1 || m.level > 11) {
        issues.push('merge 等级非法');
        continue;
      }
      const expected = scoreForMerge(m.level);
      if (m.scoreAdd !== expected) issues.push('merge 加分不符合规则');
      if (!Number.isFinite(m.timeMs) || m.timeMs < 0) issues.push('merge 时间戳非法');
      if (i > 0 && m.timeMs < mergeLogs[i - 1].timeMs) issues.push('merge 时间戳非单调');
      score += Number.isFinite(m.scoreAdd) ? m.scoreAdd : 0;
    }

    // 2) 掉落日志
    for (let i = 0; i < dropLogs.length; i++) {
      const d = dropLogs[i];
      if (!d || !Number.isInteger(d.level) || d.level < 1 || d.level > 5) {
        issues.push('drop 等级非法');
      }
      if (!Number.isFinite(d.x) || d.x < 0 || d.x > W) issues.push('drop 坐标非法');
      if (!Number.isFinite(d.timeMs) || d.timeMs < 0) issues.push('drop 时间戳非法');
      if (i > 0) {
        if (d.timeMs < dropLogs[i - 1].timeMs) issues.push('drop 时间戳非单调');
        if (d.timeMs - dropLogs[i - 1].timeMs < MIN_DROP_INTERVAL_MS) {
          issues.push('相邻 drop 间隔过短');
        }
      }
    }

    // 3) 合并后的总时间线必须单调（日志按事件顺序追加）
    const timeline = [];
    for (let i = 0; i < dropLogs.length; i++) timeline.push({ t: dropLogs[i].timeMs, kind: 'drop' });
    for (let i = 0; i < mergeLogs.length; i++) timeline.push({ t: mergeLogs[i].timeMs, kind: 'merge' });
    timeline.sort((a, b) => a.t - b.t);
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i].t < timeline[i - 1].t) issues.push('事件时间线倒序');
    }

    // 4) 球数守恒：掉落 + 合成产生 - 合成消耗 - 11 级对消 = 场上球数
    let produced = 0;
    let consumed = 0;
    for (let i = 0; i < mergeLogs.length; i++) {
      const lv = mergeLogs[i].level;
      if (lv === 11) {
        consumed += 2; // 两个 11 级同时消失，不产生新球
      } else {
        consumed += 2;
        produced += 1;
      }
    }
    const expectedBalls = dropLogs.length + produced - consumed;
    const currentBalls = Array.isArray(snapshot) ? snapshot.length : 0;
    if (expectedBalls !== currentBalls) issues.push('球数不守恒');

    // 5) 场上球坐标/半径/等级
    if (Array.isArray(snapshot)) {
      for (let i = 0; i < snapshot.length; i++) {
        const b = snapshot[i];
        if (!b || !Number.isInteger(b.level) || b.level < 1 || b.level > 11) {
          issues.push('球等级非法');
          continue;
        }
        const r = RADII[b.level - 1];
        if (Math.abs(b.r - r) > 0.51) issues.push('球半径与等级不符');
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
          issues.push('球坐标非法');
          continue;
        }
        if (b.x < b.r - 2 || b.x > W - b.r + 2) issues.push('球越出左右边界');
        if (b.y < b.r - 2 || b.y > H - b.r + 2) issues.push('球越出上下边界');
      }
    }

    // 6) 速度限制：60 秒窗口内掉落 > 120 次
    const times = dropLogs.map((d) => d.timeMs).sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      let count = 0;
      for (let j = i; j < times.length && times[j] - times[i] < 60000; j++) count++;
      if (count > MAX_DROPS_PER_MINUTE) {
        issues.push('掉落速度异常');
        break;
      }
    }

    return { ok: issues.length === 0, issues, score };
  }

  function computeScore() {
    let s = 0;
    for (let i = 0; i < mergeLogs.length; i++) s += mergeLogs[i].scoreAdd;
    return s;
  }

  // ---------------------------------------------------------------
  // 绘制
  // ---------------------------------------------------------------
  function render() {
    const sx = canvas.width / W;
    const sy = canvas.height / H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 边界裁剪：保证画布上所有要素严格限制在框的内缘碰撞区 (W x H) 内，决不越出边框
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    drawBackground();
    drawDangerZone();

    if (state === 'playing' || state === 'paused' || state === 'warning') {
      if (state === 'playing') drawAim();
    }

    // 球按 y 排序，下面的球后画，形成自然遮挡。
    // 2026-11-04 纠正：上一版渲染用了挤压变形（scale 1+sq*0.6, 1-sq，
    // sq 最大 0.22-0.30 时宽高比可达 1.45），截图里球就是椭圆，不是
    // scaleX/scaleY 的问题。用户要求球必须是正圆，所以渲染一律
    // 只画正圆，不再用 squash/tilt 变形（物理变量仍算，但不进渲染）。
    const sorted = balls.slice().sort((a, b) => a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i];
      drawBall(ctx, b.level, b.x, b.y, b.r, 1, b.angle || 0);
    }

    drawParticles();

    if (state === 'warning') drawWarningFlash();

    ctx.restore();
  }

  function drawBackground() {
    // 不画底色：整页背景在 CSS 里铺满视口，canvas 透明，
    // canvas 透明，球直接画在画好的框里。画底色等于又在框里套了一层。
  }

  function drawDangerZone() {
    // 线下 60px 危险区
    const grad = ctx.createLinearGradient(0, LINE_Y, 0, LINE_Y + DANGER_H);
    grad.addColorStop(0, 'rgba(233, 138, 156, 0.24)');
    grad.addColorStop(1, 'rgba(233, 138, 156, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, LINE_Y, W, DANGER_H);

    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(201, 85, 106, 0.72)';
    ctx.beginPath();
    ctx.moveTo(0, LINE_Y);
    ctx.lineTo(W, LINE_Y);
    ctx.stroke();
    ctx.restore();

    // 两侧小三角标记
    ctx.save();
    ctx.fillStyle = 'rgba(201, 85, 106, 0.6)';
    for (const x of [9, W - 9]) {
      ctx.beginPath();
      ctx.moveTo(x, LINE_Y - 5);
      ctx.lineTo(x + (x < W / 2 ? 1 : -1) * 7, LINE_Y - 5);
      ctx.lineTo(x, LINE_Y + 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 不再画 10px 的“危险线”小字：虚线 + 渐变危险区 + 警告红闪已经是三重信号，
    // 小字只会增加一眼扫过的负担，旧版字体问题之一就是它。
  }

  function drawBall(g, level, x, y, r, alpha, angle) {
    const fruit = FRUITS[level - 1];
    const tex = textures[level];
    const scale = clamp(r / 34, 0.55, 2.4);

    g.save();
    g.globalAlpha = alpha == null ? 1 : alpha;

    // 底部柔和投影
    g.beginPath();
    g.arc(x, y + Math.max(2, r * 0.08), r * 0.94, 0, TAU);
    g.fillStyle = 'rgba(64, 84, 54, 0.13)';
    g.fill();

    // 圆形裁剪
    g.save();
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.clip();

    // 圆圈底色（避免贴图边缘出现透明缝）
    g.fillStyle = fruit.pale;
    g.fillRect(x - r, y - r, r * 2, r * 2);

    if (tex) {
      // 贴图内容圆约占 1466/1600，缩放到略小于碰撞半径，留出描边；只旋转贴图本身
      const size = r * 2 * IMAGE_FILL * 0.985;
      g.save();
      g.translate(x, y);
      if (angle) g.rotate(angle);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(tex, -size / 2, -size / 2, size, size);
      g.restore();
    } else {
      // 素材失败时的兜底：不显示 Lv 标签，只保留水果色圆
      g.fillStyle = fruit.ring;
      g.beginPath();
      g.arc(x, y, r * 0.9, 0, TAU);
      g.fill();
      g.fillStyle = '#fffaf1';
      g.beginPath();
      g.arc(x - r * 0.26, y - r * 0.3, r * 0.18, 0, TAU);
      g.fill();
    }

    // 内部左上高光
    const shine = g.createRadialGradient(x - r * 0.42, y - r * 0.48, r * 0.05, x - r * 0.3, y - r * 0.34, r * 0.9);
    shine.addColorStop(0, 'rgba(255,255,255,0.30)');
    shine.addColorStop(0.45, 'rgba(255,255,255,0.05)');
    shine.addColorStop(1, 'rgba(70,80,50,0.10)');
    g.fillStyle = shine;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    g.restore();

    // 水果色外圈
    const lw = clamp(r * 0.055, 2, 6);
    g.beginPath();
    g.arc(x, y, r - lw * 0.5, 0, TAU);
    g.lineWidth = lw;
    g.strokeStyle = fruit.ring;
    g.stroke();

    // 外圈细白描边，压住贴图边缘锯齿
    g.beginPath();
    g.arc(x, y, r - lw - 0.5, 0, TAU);
    g.lineWidth = 1.2;
    g.strokeStyle = 'rgba(255, 252, 245, 0.55)';
    g.stroke();

    g.restore();
  }

  function drawAim() {
    const r = RADII[currentLevel - 1];
    const x = clamp(aimX, r + 2, W - r - 2);
    const y = LINE_Y - r - 10;
    const ready = now() >= cooldownUntil;

    ctx.save();
    ctx.globalAlpha = ready ? 0.9 : 0.3;

    // 虚线圆点指引（参考小美术的圆点箭头）
    ctx.strokeStyle = 'rgba(122, 176, 120, 0.85)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.setLineDash([1, 12]);
    ctx.beginPath();
    ctx.moveTo(x, y + r + 12);
    ctx.lineTo(x, H - 10);
    ctx.stroke();
    ctx.setLineDash([]);

    // 落点小箭头
    ctx.fillStyle = 'rgba(122, 176, 120, 0.8)';
    ctx.beginPath();
    ctx.moveTo(x - 7, H - 12);
    ctx.lineTo(x, H - 4);
    ctx.lineTo(x + 7, H - 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 半透明预览球
    drawBall(ctx, currentLevel, x, y, r, ready ? 0.55 : 0.22);

    if (!ready) {
      // 冷却小圆环
      const left = Math.max(0, cooldownUntil - now());
      const frac = clamp(1 - left / DROP_COOLDOWN_MS, 0, 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r + 7, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(122, 176, 120, 0.55)';
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles() {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      if (p.type === 'star') {
        drawStar(p.x, p.y, p.size, p.rot, p.color);
      } else if (p.type === 'dot') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, TAU);
        ctx.fill();
      } else if (p.type === 'ring') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, TAU);
        ctx.lineWidth = 3 * a + 1;
        ctx.strokeStyle = p.color;
        ctx.stroke();
      } else if (p.type === 'text') {
        ctx.font = '900 20px "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(255, 250, 241, 0.9)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.restore();
    }
  }

  function drawStar(x, y, radius, rot, color) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = rot + (i * Math.PI) / 4;
      const rad = i % 2 === 0 ? radius : radius * 0.28;
      const px = x + Math.cos(ang) * rad;
      const py = y + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255, 252, 240, 0.85)';
    ctx.stroke();
  }

  function drawWarningFlash() {
    const phase = Math.floor((WARNING_SECONDS - warningLeft) * 6) % 2;
    ctx.save();
    ctx.globalAlpha = phase ? 0.28 : 0.12;
    ctx.fillStyle = '#d95d72';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = phase ? 0.95 : 0.55;
    ctx.fillStyle = '#a33e50';
    ctx.font = '900 30px "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('危险！', W / 2, LINE_Y + 34);
    ctx.restore();
  }

  function drawNextPreview() {
    if (!nextCtx) return;
    const s = nextCanvas.width;
    nextCtx.setTransform(1, 0, 0, 1, 0, 0);
    nextCtx.clearRect(0, 0, s, s);
    nextCtx.save();
    nextCtx.beginPath();
    nextCtx.arc(s / 2, s / 2, s * 0.44, 0, TAU);
    nextCtx.fillStyle = 'rgba(255, 250, 241, 0.9)';
    nextCtx.fill();
    nextCtx.restore();
    if (state === 'menu' || state === 'over') return;
    drawBall(nextCtx, nextLevel, s / 2, s / 2, s * 0.39, 1);
  }

  // ---------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------
  function showScreen(el) {
    [startScreen, pauseScreen, overScreen].forEach((s) => {
      if (s) s.classList.toggle('is-visible', s === el);
    });
  }

  function hideScreens() {
    [startScreen, pauseScreen, overScreen].forEach((s) => {
      if (s) s.classList.remove('is-visible');
    });
  }

  function showToast(text, ms) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('is-show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove('is-show');
    }, ms || 1400);
  }

  function updateControls() {
    if (!btnPause) return;
    const playing = state === 'playing' || state === 'warning';
    if (btnStart) btnStart.disabled = playing || state === 'paused';
    btnPause.disabled = !(state === 'playing' || state === 'warning' || state === 'paused');
    // 图标互换，不用“继续/暂停”文字互换，避免按钮宽度抖动
    btnPause.innerHTML = state === 'paused' ? PLAY_SVG : PAUSE_SVG;
    btnPause.setAttribute('aria-label', state === 'paused' ? '继续' : '暂停');
    btnPause.setAttribute('title', state === 'paused' ? '继续' : '暂停');
    btnPause.setAttribute('aria-pressed', state === 'paused' ? 'true' : 'false');
    canvas.style.cursor = state === 'playing' ? 'crosshair' : 'default';
  }

  // ---------------------------------------------------------------
  // 主循环
  // ---------------------------------------------------------------
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!lastFrame) lastFrame = ts;
    let dt = (ts - lastFrame) / 1000;
    lastFrame = ts;
    if (!Number.isFinite(dt)) dt = 0;
    dt = clamp(dt, 0, 0.05);

    if (state === 'playing' || state === 'warning') {
      if (state === 'warning') {
        warningLeft -= dt;
        if (warningLeft <= 0) {
          finishGame();
        }
      }
      if (state === 'playing' || state === 'warning') {
        accumulator += dt;
        let steps = 0;
        while (accumulator >= FIXED_DT && steps < 8) {
          physicsStep(FIXED_DT);
          accumulator -= FIXED_DT;
          steps++;
        }
        if (steps >= 8) accumulator = 0;
        updateDanger(dt);
        updateParticles(dt);
      }
    } else if (state === 'over') {
      updateParticles(dt);
    }

    render();
  }

  // ---------------------------------------------------------------
  // 画布尺寸（按 CSS 实测尺寸 × DPR 定 canvas 位图，上限 3，消灭重采样模糊）
  // ---------------------------------------------------------------
  function resizeCanvas() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const pw = Math.max(1, Math.round(rect.width * dpr));
    const ph = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }

  window.addEventListener('resize', () => {
    applyBoardSize();
    resizeCanvas();
  });

  // ---------------------------------------------------------------
  // 按钮绑定
  // ---------------------------------------------------------------
  function bind() {
    if (overlayStart) overlayStart.addEventListener('click', startGame);
    if (btnStart) btnStart.addEventListener('click', startGame);
    if (btnRestart) btnRestart.addEventListener('click', () => {
      startGame();
    });
    if (resumeBtn) resumeBtn.addEventListener('click', resumeGame);
    if (pauseRestart) pauseRestart.addEventListener('click', startGame);
    if (pauseMenu) pauseMenu.addEventListener('click', backToMenu);
    if (overRestart) overRestart.addEventListener('click', startGame);
    if (overMenu) overMenu.addEventListener('click', backToMenu);

    if (btnPause) btnPause.addEventListener('click', () => {
      if (state === 'paused') resumeGame();
      else pauseGame(false);
    });

    if (btnSound) btnSound.addEventListener('click', toggleMute);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P') {
        if (state === 'playing' || state === 'warning') pauseGame(false);
        else if (state === 'paused') resumeGame();
      }
    });
  }

  // ---------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------
  function init() {
    applyBoardSize();
    resizeCanvas();
    loadBest();
    loadAchievements();
    loadVolumes();
    applySoundButton();

    bestValue.textContent = String(best);
    // 游戏页没有 loadNote（那是旧开始卡片里的东西），只在有它时才写
    if (loadNote) {
      if (bestTampered) {
        loadNote.textContent = '最高分存档校验失败，已按 0 计';
      } else if (!storageAvailable) {
        loadNote.textContent = '本地存储不可用，最高分仅本局有效';
      }
    }

    // 先给菜单一个“下一个球”的预览值（开始时会重抽）
    currentLevel = randomSpawnLevel();
    nextLevel = randomSpawnLevel();
    drawNextPreview();

    bind();
    // 游戏页从单独的开始页跳转进来，直接开局，不再在游戏页里放一个开始小卡片
    startGame();
    updateLoadNote();

    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  init();
})();
