/* 红果短剧 · 网页版 —— 前端逻辑
 *
 * 设计要点：
 *  1. 纯静态、零构建、零依赖，直接双击 index.html 即可打开；
 *  2. 同源部署时自动使用当前域名；file:// 打开时回落到 http://127.0.0.1:8000；
 *  3. 密钥自动获取并缓存到 localStorage，<video> 用 ?api_key= 传密钥；
 *  4. 所有列表渲染走统一的 card 模板，封面统一走 /img 代理。
 */

(() => {
  'use strict';

  // ---------- 基础配置 ----------
  const IS_FILE = location.protocol === 'file:';
  const DEFAULT_API = 'http://127.0.0.1:8000';
  // 同源部署优先用当前 origin；file:// 打开则回落到本地服务
  let API_BASE = IS_FILE
    ? (localStorage.getItem('hg_api') || DEFAULT_API)
    : location.origin;

  let API_KEY = localStorage.getItem('hg_key') || '';
  const IMG_HOSTS = ['fqnovelpic.com', 'byteimg.com', 'qznovelvod.com', 'douyinpic.com', 'pstatp.com'];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  const statusEl = $('status');
  const apiInfo = $('apiInfo');
  const toastEl = $('toast');

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  function setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 播放历史 / 收藏 ----------
   * 都存在 localStorage：
   *   hg_history  播放历史，数组，最近的在前，每项 {sid,title,cover,ep,epIndex,at}
   *   hg_fav      收藏，数组，{sid,title,cover,ep,at}
   *
   * 只记「播到第几集」，不记播放时间（按需求）。不记 vid：
   * 集数以 series_id 重新向 /episodes 拉取即可，条目不会因上游变动而失效。
   * 两个数组都做了写入容错：localStorage 满 / 被禁用时降级为内存态，
   * 不影响播放主流程。
   */
  const LIB = {
    H_KEY: 'hg_history',
    F_KEY: 'hg_fav',
    MAX: 200, // 超出后丢弃最旧的，避免 localStorage 无限增长
    _mem: { history: [], fav: [] },

    read(kind) {
      const k = kind === 'fav' ? this.F_KEY : this.H_KEY;
      try {
        const raw = localStorage.getItem(k);
        const arr = raw ? JSON.parse(raw) : [];
        // 这里也做一次截断，而不只依赖 write()：
        // 旧版本遗留、手工改写或异常写入都可能让数组超长，
        // 而 renderLib 会把每条都渲染成 DOM，超长会明显卡顿。
        if (Array.isArray(arr)) return arr.filter((x) => x && x.sid).slice(0, this.MAX);
      } catch { /* 解析失败则回退内存 */ }
      return this._mem[kind].slice();
    },

    write(kind, list) {
      const k = kind === 'fav' ? this.F_KEY : this.H_KEY;
      const arr = list.slice(0, this.MAX);
      this._mem[kind] = arr;
      try { localStorage.setItem(k, JSON.stringify(arr)); } catch { /* 降级为内存态 */ }
      return arr;
    },

    isFav(sid) { return this.read('fav').some((x) => x.sid === sid); },

    /** 切换收藏，返回切换后的状态 */
    toggleFav(item) {
      const sid = String(item.sid || '');
      if (!sid) return false;
      const list = this.read('fav');
      const i = list.findIndex((x) => x.sid === sid);
      if (i >= 0) {
        list.splice(i, 1);
        this.write('fav', list);
        return false;
      }
      list.unshift({
        sid, title: item.title || '未命名', cover: item.cover || '',
        ep: Number(item.ep) || 0, total: Number(item.total) || 0, at: Date.now(),
      });
      this.write('fav', list);
      return true;
    },

    removeFav(sid) {
      this.write('fav', this.read('fav').filter((x) => x.sid !== sid));
    },

    /**
     * 续播某剧时同步收藏条目里的集数。
     * 不这样做的话：收藏时记的是第 12 集，之后从历史续播到第 30 集，
     * 收藏列表仍写「已看至第 12 集」，再点继续播放会往回跳。
     */
    syncFavEp(sid, ep) {
      const list = this.read('fav');
      const hit = list.find((x) => x.sid === sid);
      if (!hit) return false;
      hit.ep = Number(ep) || hit.ep;
      this.write('fav', list);
      return true;
    },

    clear(kind) { this.write(kind, []); },

    /**
     * 记录一次播放。同一部剧只保留一条，重复观看时把集数与时间戳更新后置顶。
     * @param {boolean} atStart 是否是「进入时自动播放的第一集」
     *        继续播放（从历史恢复）不更新时间戳，避免刷新列表就把旧记录顶上去。
     */
    touchHistory(item, atStart) {
      const sid = String(item.sid || '');
      if (!sid) return;
      const list = this.read('history').filter((x) => x.sid !== sid);
      list.unshift({
        sid, title: item.title || '未命名', cover: item.cover || '',
        ep: Number(item.ep) || 0, total: Number(item.total) || 0,
        at: atStart ? Date.now() : (Number(item.at) || Date.now()),
        _t: Date.now(),
      });
      this.write('history', list);
    },
  };

  /** 封面 URL 交给后端 /img 代理（处理 HEIC 转换与域名白名单）。 */
  function coverUrl(u) {
    if (!u) return '';
    if (u.startsWith('data:')) return u;
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (!IMG_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return '';
      return `${API_BASE}/img?url=${encodeURIComponent(u)}`;
    } catch { return ''; }
  }

  async function api(path, opts = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API_BASE}${path}${API_KEY ? `${sep}api_key=${encodeURIComponent(API_KEY)}` : ''}`;
    const res = await fetch(url, {
      headers: API_KEY ? { 'x-api-key': API_KEY } : {},
      ...opts,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!res.ok) {
      const detail = (data && (data.detail || data.message)) || `HTTP ${res.status}`;
      const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    // 业务接口认了这个密钥 → 之前的 401 属于已恢复的情形，熔断计数归零。
    // （放在 !res.ok 之后：只有真正拿到数据才算恢复）
    key401Count = 0;
    return data;
  }

  // ---------- 密钥 ----------
  /*
   * 密钥自动获取（带重试）。
   *
   * 背景：首次启动时后端可能还在启动（尤其是要拉起 Java 签名服务时），
   * 原本这里只试一次，失败就直接把「填写密钥」弹层丢给用户 ——
   * 用户既不知道服务在不在跑，也没有重试入口，只能手动复制粘贴。
   *
   * 现在的行为：
   *   - 每次尝试都更新弹层里的状态文案（获取中 / 第 N 次重试 / 失败原因）；
   *   - 指数退避自动重试（1s、2s、4s…上限 10s），最多 KEY_RETRY_MAX 次；
   *   - 用户随时可以点「重新获取」立刻重试（会重置退避）；
   *   - 一旦拿到密钥，自动关闭弹层并继续加载首页；
   *   - 弹层被用户手动关掉后仍会继续后台重试，拿到后不再打扰。
   */
  const KEY_RETRY_MAX = 12;
  const KEY_RETRY_BASE = 1000;
  const KEY_RETRY_CAP = 10000;
  /*
   * 401 自愈的熔断。
   *
   * 正常情况下 401 只有一次（服务端重启换了密钥），重新取一次就能恢复。
   * 但如果 /api-key 返回的密钥业务接口仍然不认（比如反向代理剥掉了 api_key 参数、
   * 或前后端指向了不同实例），就会陷入
   *   401 → 重新取密钥 → adoptKey → loadTab → 401 → …
   * 的死循环：卡片反复开关、接口反复打，用户完全没法操作。
   *
   * 三条规则缺一不可：
   *   1) key401Pending 期间产生的 401 不计数 —— loadTab 一次会并发打多个接口，
   *      它们几乎同时 401，不去重的话一次故障就能把计数瞬间打满。
   *   2) KEY_401_MIN_GAP：两次自愈之间至少隔这么久。不设的话「取密钥成功但
   *      业务接口仍 401」会在几百毫秒内跑满 5 次 —— 而真实后端重启后签名服务
   *      预热要好几秒，那属于正常启动过程，不该被判成死循环。
   *   3) KEY_401_WINDOW：计数只在时间窗内累积，跨窗的零星 401 属于不同故障。
   */
  const KEY_401_MAX = 5;         // 窗口内累计 401 达到该次数才熔断
  const KEY_401_WINDOW = 30000;  // 计数窗口（毫秒）
  const KEY_401_MIN_GAP = 2000;  // 两次自愈之间的最小间隔（毫秒）
  let key401Count = 0;           // 窗口内累计 401 次数
  let key401At = 0;              // 最近一次计入的 401 时间戳
  let key401TriedAt = 0;         // 最近一次真正发起自愈的时间戳
  let key401Pending = false;     // 是否已在自愈流程中
  let key401Timer = null;        // 间隔不足时的延迟重试定时器
  let keyRetryTimer = null;      // 取密钥的退避定时器
  let keyRetryCount = 0;         // 取密钥已重试次数
  let keyFetching = false;       // 是否正在请求（防重入）

  /** 设置弹层里的状态行。state: loading | warn | error | ok */
  function setKeyState(state, text) {
    const box = $('keyState');
    box.hidden = false;
    box.dataset.state = state;
    $('keyStateText').textContent = text;
  }

  function stopKeyRetry() {
    if (keyRetryTimer) { clearTimeout(keyRetryTimer); keyRetryTimer = null; }
  }

  /**
   * 把密钥写入内存与 localStorage，并同步所有相关 UI。
   * @param {string} k 新密钥
   * @param {boolean} fromRenewal 是否为 401 自愈触发的重新获取。
   *   自愈成功时不能把 key401Count 清零 —— 只有真正被业务接口接受
   *   （即 loadTab 跑通）才算恢复，否则熔断计数会被反复重置而永不触发。
   */
  function adoptKey(k, fromRenewal = false) {
    API_KEY = k;
    localStorage.setItem('hg_key', k);
    keyRetryCount = 0;
    stopKeyRetry();
    $('keyInput').value = k;
    // 已有密钥后「获取中」状态行与重试按钮都不再适用，
    // 不清掉的话下次打开卡片会看到一条自相矛盾的提示。
    $('keyState').hidden = true;
    $('keyRetry').hidden = true;
    // 拿到密钥就自动关卡片：用户什么都不用做
    $('keyModal').hidden = true;
    if (fromRenewal) {
      // 自愈路径不弹「已获取」提示：401 场景下用户已经知道出事了，
      // 真正需要告知的是「恢复成功」，那由 loadTab 后的状态行说明。
      setStatus('已换新密钥，正在重新加载…', '');
    } else {
      toast('已获取本地链路密钥');
    }
    // 首次启动时首页还停在「未连接后端」占位（或 401 之后的错误页），恢复加载
    const needReload = view.querySelector('.empty') || !state.items.length;
    if (needReload) loadTab(state.tab);
  }

  /**
   * 确保有可用密钥。
   * @param {boolean} interactive 失败时是否弹出密钥卡片
   * @param {boolean} manual       用户主动点了「重新获取」：立刻重试并重置退避
   * @param {boolean} fromRenewal  是否由 401 自愈触发
   * @returns {Promise<string>} 拿到的密钥；拿不到返回 ''
   */
  async function ensureKey(interactive = false, manual = false, fromRenewal = false) {
    if (API_KEY) return API_KEY;
    if (manual) { keyRetryCount = 0; stopKeyRetry(); }
    if (keyFetching) return API_KEY;
    keyFetching = true;
    try {
      const r = await fetch(`${API_BASE}/api-key`);
      if (r.ok) {
        const j = await r.json();
        if (j.api_key) { adoptKey(j.api_key, fromRenewal); return j.api_key; }
        throw new Error('接口未返回 api_key');
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      const why = (e && e.message) || '无法连接后端';
      keyRetryCount++;
      const last = keyRetryCount >= KEY_RETRY_MAX;
      if (interactive) {
        $('keyInput').value = '';
        $('keyRetry').hidden = false;
        if (last) {
          setKeyState('error', `获取失败：${why}。已重试 ${keyRetryCount} 次，请确认后端已启动后点「重新获取」`);
        } else {
          setKeyState('warn', `获取中：${why}，正在第 ${keyRetryCount} 次重试…`);
        }
      }
      // 后退避重试；弹层关掉后也继续，直到拿到或用尽次数
      if (!last) {
        stopKeyRetry();
        const wait = Math.min(KEY_RETRY_BASE * (2 ** (keyRetryCount - 1)), KEY_RETRY_CAP);
        keyRetryTimer = setTimeout(() => { ensureKey(interactive, false, fromRenewal); }, wait);
      }
      return '';
    } finally {
      keyFetching = false;
    }
  }

  // ---------- 渲染 ----------
  function cardTemplate(item) {
    const img = coverUrl(item.cover);
    const poster = img
      ? `<img loading="lazy" src="${esc(img)}" alt="${esc(item.title)}"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'无封面'}))">`
      : `<div class="ph">无封面</div>`;
    const badge = (item.tags && item.tags[0])
      ? `<span class="badge">${esc(item.tags[0])}</span>` : '';
    const eps = item.episode_cnt ? `<span class="eps">${item.episode_cnt}集</span>` : '';
    const tags = (item.tags || []).slice(1, 3).join(' · ');
    // 看过就标出进度：点开会自动续播到这一集（见 resolveStart），
    // 提前告知，免得用户以为又是从头开始。
    const seen = seenBadge(item.series_id);
    return `<article class="card" data-sid="${esc(item.series_id)}" data-vid="${esc(item.vid || '')}">
      <div class="poster">${poster}${badge}${eps}${seen}</div>
      <h3 class="title">${esc(item.title || '未命名')}</h3>
      <div class="tags">${esc(tags || (item.abstract ? String(item.abstract).slice(0, 20) : ''))}</div>
    </article>`;
  }

  /** 卡片上的「看到第 N 集」角标；没看过或看到第 1 集则不标（从头播即默认行为） */
  function seenBadge(sid) {
    if (!sid) return '';
    const rec = LIB.read('history').find((x) => x.sid === String(sid));
    const ep = Number(rec && rec.ep) || 0;
    if (ep <= 1) return '';
    return `<span class="seen" title="点击继续播放第 ${ep} 集">看到第 ${ep} 集</span>`;
  }

  function renderGrid(items) {
    if (!items || !items.length) {
      view.innerHTML = '<div class="empty"><span class="big">🍿</span>没有内容</div>';
      return;
    }
    view.innerHTML = `<div class="grid">${items.map(cardTemplate).join('')}</div>`;
    bindCards();
  }

  function bindCards() {
    view.querySelectorAll('.card').forEach((el) => {
      el.addEventListener('click', () => {
        const title = el.querySelector('.title')?.textContent || '';
        const sid = el.dataset.sid;
        // 统一以 series_id 打开：搜索/最新榜单的卡片虽然带 vid，
        // 但那是「某一集」的 vid，直接播会没有剧集条，故一律走剧集列表。
        // 仅当上游没给 series_id 时才退化为单集播放。
        if (sid) openSeries(sid, title);
        else openPlayer({ vid: el.dataset.vid }, title);
      });
    });
  }

  // ---------- 页面状态 ----------
  const state = { tab: 'home', offset: 0, busy: false, items: [] };

  async function loadTab(tab) {
    state.tab = tab;
    state.offset = 0;
    state.items = [];
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    view.innerHTML = '<div class="loading">加载中…</div>';
    setStatus('请求中…');
    try {
      if (tab === 'home') await loadRank('recommend', '推荐榜');
      else if (tab === 'rank') await renderRankPanel();
      else if (tab === 'latest') await loadLatest('short_play', true);
      else if (tab === 'browse') await renderBrowsePanel();
    } catch (e) {
      handleError(e);
    }
  }

  async function loadRank(board, title) {
    const j = await api(`/rank?board=${encodeURIComponent(board)}&limit=30`);
    state.items = j.items || [];
    view.innerHTML = `<div class="section-head"><h2>${esc(title || j.name || '榜单')}</h2>
      <span class="muted">${state.items.length} 部</span></div>
      <div class="grid">${state.items.map(cardTemplate).join('')}</div>`;
    bindCards();
    setStatus(`${title || '榜单'} · ${state.items.length} 部`, 'ok');
  }

  async function renderRankPanel() {
    const boards = [['recommend', '推荐榜'], ['hot', '热播榜'], ['new', '新剧榜']];
    const j = await api('/rank?board=recommend&limit=30');
    state.items = j.items || [];
    view.innerHTML = `<div class="section-head">
        <h2>榜单</h2>
        <div class="chips" id="rankChips">
          ${boards.map(([b, n], i) => `<button class="chip${i === 0 ? ' on' : ''}" data-b="${b}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="grid">${state.items.map(cardTemplate).join('')}</div>`;
    $('rankChips').addEventListener('click', async (e) => {
      const b = e.target.dataset.b;
      if (!b) return;
      $('rankChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.target));
      view.innerHTML = '<div class="loading">加载中…</div>';
      await loadRank(b, e.target.textContent);
    });
    bindCards();
    setStatus('榜单已加载', 'ok');
  }

  async function loadLatest(genre, onlyToday) {
    const j = await api(`/latest?genre=${genre}&only_today=${onlyToday}&limit=60`);
    state.items = j.items || [];
    const genres = [['short_play', '短剧'], ['comic_series', '漫剧'], ['ai_series', 'AI短剧']];
    view.innerHTML = `<div class="section-head">
        <h2>最新上架</h2>
        <div class="chips" id="genreChips">
          ${genres.map(([g, n]) => `<button class="chip${g === genre ? ' on' : ''}" data-g="${g}">${n}</button>`).join('')}
          <button class="chip${onlyToday ? ' on' : ''}" id="todayChip">仅今日</button>
        </div>
      </div>
      <div class="grid">${state.items.map(cardTemplate).join('')}</div>`;
    $('genreChips').addEventListener('click', async (e) => {
      const g = e.target.dataset.g;
      if (g) { view.innerHTML = '<div class="loading">加载中…</div>'; await loadLatest(g, onlyToday); return; }
      if (e.target.id === 'todayChip') {
        view.innerHTML = '<div class="loading">加载中…</div>';
        await loadLatest(genre, !onlyToday);
      }
    });
    bindCards();
    setStatus(`${j.name || ''} ${j.mode || ''} · ${state.items.length} 部`, 'ok');
  }

  async function renderBrowsePanel() {
    const genres = [['short_play', '短剧'], ['comic_series', '漫剧'], ['ai_series', 'AI短剧']];
    view.innerHTML = `<div class="section-head"><h2>筛选浏览</h2></div>
      <div class="chips" id="browseGenres">
        ${genres.map(([g, n], i) => `<button class="chip${i === 0 ? ' on' : ''}" data-g="${g}">${n}</button>`).join('')}
      </div>
      <div id="filterBox" class="chips" style="margin:12px 0"></div>
      <div class="section-head">
        <h2 id="browseTitle">请选择筛选条件</h2>
        <button class="btn" id="browseGo">浏览</button>
      </div>
      <div id="browseResult" class="grid"></div>`;

    const sel = { genre: 'short_play', theme: new Set(), days: new Set(), sort: 'online_time' };
    let filterRows = [];

    async function loadFilters(genre) {
      sel.genre = genre;
      filterRows = [];
      $('filterBox').innerHTML = '<span class="muted">筛选加载中…</span>';
      try {
        const j = await api(`/filters?genre=${genre}`);
        filterRows = j.rows || [];
      } catch { /* 无筛选则仅按默认浏览 */ }
      renderFilterChips();
    }

    function renderFilterChips() {
      const parts = [];
      for (const row of filterRows) {
        if (row.type === 'theme') {
          parts.push(`<div class="chips" data-row="theme">
            ${row.items.slice(0, 14).map((it) => `<button class="chip" data-v="${esc(it.name)}">${esc(it.name)}</button>`).join('')}
          </div>`);
        }
      }
      parts.push(`<div class="chips">
        ${[7, 14, 30, 90].map((d) => `<button class="chip" data-row="days" data-v="${d}">${d}天内</button>`).join('')}
      </div>`);
      parts.push(`<div class="chips">
        ${[['online_time', '最新'], ['hot_score', '最热']].map(([v, n]) =>
          `<button class="chip${v === 'online_time' ? ' on' : ''}" data-row="sort" data-v="${v}">${n}</button>`).join('')}
      </div>`);
      $('filterBox').innerHTML = parts.join('');
    }

    $('filterBox').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const row = chip.dataset.row;
      if (row === 'sort') {
        $('filterBox').querySelectorAll('[data-row="sort"]').forEach((c) => c.classList.toggle('on', c === chip));
        sel.sort = chip.dataset.v;
        return;
      }
      if (row === 'days') {
        const on = chip.classList.toggle('on');
        on ? sel.days.add(chip.dataset.v) : sel.days.delete(chip.dataset.v);
        return;
      }
      if (row === 'theme') {
        const on = chip.classList.toggle('on');
        on ? sel.theme.add(chip.dataset.v) : sel.theme.delete(chip.dataset.v);
      }
    });

    $('browseGo').addEventListener('click', doBrowse);
    $('browseGenres').addEventListener('click', (e) => {
      const g = e.target.dataset.g;
      if (!g) return;
      $('browseGenres').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.target));
      sel.theme.clear(); sel.days.clear();
      loadFilters(g);
    });

    async function doBrowse() {
      const box = $('browseResult');
      box.innerHTML = '<div class="loading">加载中…</div>';
      setStatus('浏览请求中…');
      const p = new URLSearchParams({ genre: sel.genre, sort: sel.sort, limit: '60' });
      if (sel.theme.size) p.set('theme', [...sel.theme].join(','));
      if (sel.days.size) p.set('days', [...sel.days][0]);
      try {
        const j = await api(`/browse?${p}`);
        box.innerHTML = (j.items || []).map(cardTemplate).join('') || '<div class="empty">无结果</div>';
        bindCards();
        setStatus(`浏览 · ${(j.items || []).length} 部`, 'ok');
      } catch (e) { box.innerHTML = ''; handleError(e); }
    }

    await loadFilters('short_play');
    setStatus('筛选就绪', 'ok');
  }

  // ---------- 播放器 ----------
  const playerEl = $('player');
  const videoEl = $('video');

  // 当前播放上下文：剧集列表 + 正在播的下标，供自动连播使用
  const ctx = {
    seriesId: '', title: '', abstract: '', episodes: [], index: -1,
    cover: '', total: 0, // cover/total 供历史与收藏列表展示
    // 「本次打开该剧后的首次起播」标记，供 recordHistory 判断是否刷新历史时间戳。
    // 由 openSeries 置 true，playAt 消费后置回 false。
    freshOpen: false,
    autoNext: localStorage.getItem('hg_autonext') !== '0',
  };

  function markEp(i) {
    ctx.index = i;
    $('pEpGrid').querySelectorAll('.epx').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.pos) === i);
    });
  }

  /** 预热下一集：后台解密落盘，播完切集即可秒开。失败静默，不影响当前播放。 */
  function prewarmNext() {
    const nxt = ctx.episodes[ctx.index + 1];
    if (!nxt || !nxt.vid) return;
    fetch(`${API_BASE}/prewarm?vid=${encodeURIComponent(nxt.vid)}`
      + `${API_KEY ? `&api_key=${encodeURIComponent(API_KEY)}` : ''}`)
      .catch(() => { /* 预热失败无所谓，播放时照常下载 */ });
  }

  /**
   * 更新播放器头部信息（仅集数进度）。
   * 这里刻意不承载简介 —— 之前简介是常驻文字，而 playAt 里的二次刷新会把它
   * 清掉，于是标题行在首帧与后续帧之间来回抖动。简介改由「简介」按钮的
   * 悬浮气泡承载，标题行高度恒定。
   */
  /**
   * 更新集数按钮的文字。
   * index 为 -1 表示「集数已知但尚未选中任何一集」（openSeries 刚拿到列表、
   * playAt 还没跑完的窗口期）。此时若照常算 index+1 会显示成「第 0 集」，
   * 属于明显的错误文案，改为显示总集数。
   */
  function updatePMeta() {
    const total = ctx.episodes.length;
    const btn = $('pEpBtn');
    if (!total) { btn.hidden = true; return; }
    btn.hidden = false;
    const label = ctx.index < 0
      ? `共 ${total} 集`
      : `第 ${ctx.episodes[ctx.index].index || ctx.index + 1} 集`;
    $('pEpLabel').textContent = label;
    // 集数过多时（如 100+ 集）进度信息放进 title，避免按钮文字过长挤掉连播开关
    btn.title = total > 1 ? `${label}（共 ${total} 集，点击选择）` : label;
    const cnt = $('pEpCount');
    if (cnt) cnt.textContent = `共 ${total} 集，选择要播放的一集`;
  }

  /**
   * 设置作品简介。text 为空时隐藏「简介」按钮（不占位，标题行不抖动）。
   */
  function setAbstract(text) {
    const btn = $('pInfoBtn');
    const pop = $('pInfoPop');
    const t = String(text || '').trim();
    ctx.abstract = t;
    if (!t) { btn.hidden = true; pop.hidden = true; return; }
    // 气泡里按纯文本渲染，避免简介中的尖括号破坏 DOM
    pop.textContent = t;
    btn.hidden = false;
  }

  /** 打开/关闭简介气泡。open=true 显示，false 隐藏。 */
  function toggleInfo(open) {
    $('pInfoPop').hidden = !open;
  }

  /** 关闭选集卡片（由下方交互块赋值实现，这里先声明以便各处直接调用）。 */
  let closeEpCard = () => {};

  /**
   * 打开一部剧的播放器。
   * @param {string} seriesId
   * @param {string} title 卡片上的剧名（接口失败时兜底用）
   * @param {object} opts
   *   - startAt 起始集序号（0 起）。历史/收藏「继续播放」传它。
   *   - resume  是否为「从历史/收藏列表恢复」。为 true 时强制用 startAt，
   *              不再套用「接着上次播」逻辑（避免与列表记录互相覆盖）。
   */
  async function openSeries(seriesId, title, opts = {}) {
    setStatus('获取剧集…');
    try {
      const j = await api(`/episodes?series_id=${encodeURIComponent(seriesId)}`);
      const meta = j.meta || {};
      const eps = j.episodes || [];
      if (!eps.length) { toast('该剧暂无剧集'); return; }
      // 重建上下文：换剧时清掉上一部的连播状态
      ctx.seriesId = String(seriesId);
      ctx.title = meta.title || title || '播放';
      ctx.episodes = eps;
      ctx.index = -1;
      // 封面与总集数：供历史/收藏列表展示（不存 vid，避免上游变动后失效）
      ctx.cover = meta.cover || (findCardCover(seriesId) || '');
      ctx.total = eps.length;
      $('pTitle').textContent = ctx.title;
      buildEpGrid(eps);
      playerEl.hidden = false;
      // 简介交给悬浮气泡；集数按钮只显示当前集数（每集刷新，不再消失）
      setAbstract(meta.abstract || '');
      syncFavBtn();
      updatePMeta();
      // 标记本次打开：playAt 首次起播时会消费它（用于刷新历史时间戳并置顶）
      ctx.freshOpen = true;
      const start = resolveStart(eps, opts);
      playAt(start);
    } catch (e) { handleError(e); }
  }

  /**
   * 决定打开某剧时从哪一集开始播。
   *
   * 优先级：
   *   1) 调用方显式指定（历史/收藏的「继续播放」传 opts.startAt）；
   *   2) 该剧在历史里且记录了集数 → 接着上次看到的地方播（从推荐/搜索点开时的预期行为）；
   *   3) 都没有 → 第 1 集。
   *
   * 集号是上游给的真实集号（可能不从 1 开始），这里按「集号」而非下标换算：
   * 优先在剧集列表里找 index 等于记录集号的那一集，找不到再退回「集号-1」。
   * 记录集号超出当前总集数（剧下架/集数缩减）时回落到第 1 集。
   */
  function resolveStart(eps, opts) {
    const n = eps.length;
    const inRange = (i) => Number.isInteger(i) && i >= 0 && i < n;
    // 1) 显式指定
    if (inRange(opts.startAt)) return opts.startAt;
    // 2) 接着历史里记录的集数
    const rec = LIB.read('history').find((x) => x.sid === ctx.seriesId);
    const ep = Number(rec && rec.ep) || 0;
    if (ep > 0) {
      // 上游集号未必从 1 开始，先按 index 精确匹配
      const byIndex = eps.findIndex((e) => Number(e.index) === ep);
      if (byIndex >= 0) return byIndex;
      if (inRange(ep - 1)) return ep - 1;
    }
    // 3) 兜底
    return 0;
  }

  /** 从首页卡片里取封面（历史/收藏需要封面时复用已渲染的 DOM） */
  function findCardCover(sid) {
    const el = view.querySelector(`.card[data-sid="${CSS.escape(String(sid))}"] .poster img`);
    return el ? el.getAttribute('src') : '';
  }

  /**
   * 构建选集卡片里的网格：一行五个集数按钮。
   * 集数很多时（100+）由 CSS 控制卡片内滚动，不撑破播放器弹层。
   */
  function buildEpGrid(eps) {
    $('pEpGrid').innerHTML = eps.map((e, i) =>
      `<button class="epx" data-pos="${i}" data-vid="${esc(e.vid)}"
         title="${esc(e.title || `第${e.index}集`)}">${e.index || i + 1}</button>`).join('');
    $('pEpGrid').querySelectorAll('.epx').forEach((b) => {
      b.addEventListener('click', () => {
        const pos = Number(b.dataset.pos);
        closeEpCard();
        playAt(pos);
      });
    });
  }

  function openPlayer({ vid }, title) {
    ctx.seriesId = ''; ctx.title = title || '播放';
    ctx.episodes = []; ctx.index = -1;
    ctx.cover = ''; ctx.total = 0;
    $('pTitle').textContent = ctx.title;
    setAbstract(''); // 单集播放无简介，按钮隐藏
    $('pEpGrid').innerHTML = '';
    closeEpCard();
    syncFavBtn(); // 单集无 series_id → 收藏按钮隐藏
    updatePMeta(); // 无剧集 → 集数按钮自动隐藏
    playerEl.hidden = false;
    play(vid);
  }

  /**
   * 播放剧集中的第 pos 集。
   * 统一入口：手动点集按钮与自动连播都走这里，保证索引状态一致。
   */
  async function playAt(pos) {
    const e = ctx.episodes[pos];
    if (!e || !e.vid) { toast('该集暂不可播放'); return; }
    markEp(pos);
    // 播放过的剧集自动进历史。放在 play() 之前：即使后续解码失败、
    // 用户立刻关掉，也算「播过」；集数取 e.index（上游真实集号），
    // 回落到 pos+1，保证历史里能对上「继续播放」的集。
    recordHistory(pos, e);
    // 不传集名：状态栏不再显示集数，集数由左侧集数按钮承载
    await play(e.vid);
    updatePMeta();
    prewarmNext();
  }

  /** 把当前播放位置写进历史 */
  function recordHistory(pos, epObj) {
    if (!ctx.seriesId) return;
    const ep = (epObj && (epObj.index || pos + 1)) || pos + 1;
    // 是否算「一次新的观看」：本次打开该剧后的首次起播。
    //
    // 不能用 pos === 0 判断 —— 从推荐/搜索点开一部看过的剧，现在会直接
    // 续播到上次那一集（pos 可能是 11），那样就永远被判成「不是新观看」，
    // 记录不会置顶，用户看不出自己刚点开过什么。用「打开会话内首次」判定：
    // 续播也算新观看（置顶），而后续的连播/手动切集只更新集数不动顺序。
    const fresh = ctx.freshOpen;
    ctx.freshOpen = false;
    LIB.touchHistory({
      sid: ctx.seriesId,
      title: ctx.title,
      cover: ctx.cover,
      ep,
      total: ctx.total,
    }, fresh);
    // 已收藏的剧同步更新收藏条目里的集数，避免收藏列表的进度长期停在收藏那一刻
    LIB.syncFavEp(ctx.seriesId, ep);
  }

  /*
   * 解码能力兜底提示。
   *
   * 源流是 HEVC(H.265)，默认直出不转码。若浏览器/系统缺 HEVC 解码器，
   * <video> 会表现为：readyState 到了 4、时间轴在走，但画面全黑，
   * 且 videoWidth/videoHeight 都是 0 —— 静默失败，用户完全看不懂。
   *
   * 时序坑：loadedmetadata 触发时 videoWidth 可能还是 0（解码器尚未确认），
   * 且 play() 的 await 会在其后把状态文案覆盖掉。因此改为在
   * loadeddata（rs>=2，解码已判定）之后再延迟一拍检查，
   * 并用 codecBlocked 锁住提示，避免被后续播放状态冲掉。
   */
  const HEVC_HINT = '画面无法显示：当前浏览器/系统缺少 HEVC(H.265) 解码支持。'
    + '请改用最新版 Chrome / Edge；若仍不行，可在启动前设 HG_TRANSCODE=1 '
    + '让服务端转码为 H.264（速度较慢但兼容性最好）。';
  let codecChecked = false;
  let codecBlocked = false; // 已确认无法解码：置位后不再被播放状态覆盖
  function checkCodec() {
    if (codecChecked) return;
    if (videoEl.videoWidth > 0) { codecChecked = true; return; } // 解码正常
    // 能否播 H.264：用来区分「完全不支持视频」与「仅 HEVC 不支持」
    if (!videoEl.canPlayType('video/mp4; codecs="avc1.42E01E"')) return;
    codecChecked = true;
    codecBlocked = true;
    $('pStatus').textContent = HEVC_HINT;
    setStatus('解码不兼容：缺少 HEVC 支持', 'err');
    toast('画面无法显示：缺少 HEVC 解码器', 4000);
  }

  async function play(vid) {
    if (!vid) return;
    // codecBlocked 表示已确认本机无法解码（缺 HEVC），
    // 此时不要用播放状态覆盖掉那条唯一有价值的提示
    if (!codecBlocked) $('pStatus').textContent = '解密并缓冲中，首次播放需下载整集…';
    // <video> 无法带自定义头，密钥走查询参数
    const url = `${API_BASE}/stream?vid=${encodeURIComponent(vid)}&api_key=${encodeURIComponent(API_KEY)}`;
    videoEl.src = url;
    try {
      await videoEl.play();
      // 这里刻意不写集数：集数已由左侧「集数按钮」承载，
      // 状态栏只放播放相关的状态（缓冲中 / 已加载 / 播放结束 / 下一集）。
      if (!codecBlocked) $('pStatus').textContent = '';
    } catch {
      if (!codecBlocked) $('pStatus').textContent = '已加载，点击播放按钮开始';
    }
  }

  videoEl.addEventListener('loadeddata', () => { setTimeout(checkCodec, 400); });
  // 元数据就绪时 videoWidth 可能尚未确定，先挂个延后检查兜底
  videoEl.addEventListener('loadedmetadata', () => { setTimeout(checkCodec, 1200); });
  videoEl.addEventListener('error', () => { codecChecked = false; setTimeout(checkCodec, 300); });

  // 播完自动播下一集
  // 注：连播逻辑本身不受解码状态影响（用户手动切集仍要能走），
  // 只是状态文案在解码被阻断时让位给那条唯一有价值的提示。
  const setPStatus = (t) => { if (!codecBlocked) $('pStatus').textContent = t; };
  videoEl.addEventListener('ended', () => {
    if (!ctx.autoNext) { setPStatus('播放结束（连播已关闭）'); return; }
    if (!ctx.episodes.length) { setPStatus('播放结束'); return; } // 单集，无下一集
    const next = ctx.index + 1;
    if (next >= ctx.episodes.length) {
      setPStatus('已播完最后一集');
      toast('已播完最后一集');
      return;
    }
    setPStatus('即将播放下一集…');
    toast(`即将播放第 ${ctx.episodes[next].index} 集`, 1600);
    playAt(next);
  });

  // 连播开关
  const autoNextBtn = $('autoNextBtn');
  function syncAutoNext() {
    autoNextBtn.classList.toggle('on', ctx.autoNext);
    autoNextBtn.textContent = ctx.autoNext ? '连播 开' : '连播 关';
  }
  autoNextBtn.addEventListener('click', () => {
    ctx.autoNext = !ctx.autoNext;
    localStorage.setItem('hg_autonext', ctx.autoNext ? '1' : '0');
    syncAutoNext();
    toast(ctx.autoNext ? '已开启自动连播' : '已关闭自动连播');
  });
  syncAutoNext();

  // ---------- 简介悬浮气泡 ----------
  // 说明：简介默认完全隐藏，只在 hover「简介」按钮时浮出。
  // 这样常驻文案不会因为 playAt 的二次刷新而消失，标题行高度始终稳定。
  {
    const infoBtn = $('pInfoBtn');
    const infoPop = $('pInfoPop');
    let hideTimer = null;

    // 气泡是 position:fixed，需按按钮实时定位（fixed 脱离 overflow 裁剪）
    function place() {
      if (infoBtn.hidden || infoPop.hidden) return;
      const b = infoBtn.getBoundingClientRect();
      const gap = 6;
      const w = infoPop.offsetWidth;
      const h = infoPop.offsetHeight;
      // 水平：以按钮为准，超出视口则夹紧
      let left = b.left;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (left < 8) left = 8;
      // 优先放在按钮下方；空间不足则放上方
      let top = b.bottom + gap;
      if (top + h > window.innerHeight - 8) {
        top = Math.max(8, b.top - h - gap);
      }
      infoPop.style.left = `${Math.round(left)}px`;
      infoPop.style.top = `${Math.round(top)}px`;
    }

    const show = () => {
      clearTimeout(hideTimer);
      if (infoBtn.hidden) return;
      infoPop.hidden = false;
      place();
    };
    const hide = (delay) => {
      clearTimeout(hideTimer);
      // 延迟关闭，便于鼠标从按钮移到气泡上阅读
      hideTimer = setTimeout(() => { infoPop.hidden = true; }, delay || 0);
    };

    // 桌面端 hover 即可；触屏无 hover，故用 click 切换
    infoBtn.addEventListener('mouseenter', show);
    infoBtn.addEventListener('mouseleave', () => hide(180));
    infoBtn.addEventListener('focus', show);
    infoBtn.addEventListener('blur', () => hide(180));
    // 气泡本身也要能悬停阅读，移出后才关闭
    infoPop.addEventListener('mouseenter', show);
    infoPop.addEventListener('mouseleave', () => hide(0));
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (infoPop.hidden) show(); else infoPop.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (!infoPop.hidden
        && !infoPop.contains(e.target) && !infoBtn.contains(e.target)) {
        infoPop.hidden = true;
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') infoPop.hidden = true;
    });
    // 窗口尺寸变化时重新定位，避免气泡跑偏
    // 视口尺寸变化后按钮位置会移动，已展开的气泡需重新贴合。
    // 注意 resize 本身会让鼠标离开按钮、触发 mouseleave 而关闭气泡，
    // 所以这里只处理「窗口变化但指针仍悬停」的场景（如拖拽边框、缩放未触发 mouseleave）。
    window.addEventListener('resize', () => { if (!infoPop.hidden) place(); });
  }

  /**
   * 选集卡片：点击「集数按钮」展开，一行五个集数按钮。
   * 定位用 position:fixed（.modal-card 有 overflow:auto，绝对定位会被裁剪），
   * 优先向上展开 —— 按钮在播放器最下方，向上展开才不会顶出视口。
   */
  {
    const epBtn = $('pEpBtn');
    const epCard = $('pEpCard');

    function placeEpCard() {
      if (epCard.hidden) return;
      const b = epBtn.getBoundingClientRect();
      const gap = 8;
      const w = epCard.offsetWidth;
      const h = epCard.offsetHeight;
      // 水平：与按钮左对齐，超出右边界则夹紧
      let left = b.left;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (left < 8) left = 8;
      // 垂直：默认向上（按钮在底部）；上方也放不下才向下
      let top = b.top - h - gap;
      if (top < 8) top = Math.min(window.innerHeight - h - 8, b.bottom + gap);
      if (top < 8) top = 8;
      epCard.style.left = `${Math.round(left)}px`;
      epCard.style.top = `${Math.round(top)}px`;
    }

    function openEpCard() {
      if (epBtn.hidden || !ctx.episodes.length) return;
      epCard.hidden = false;
      placeEpCard();
    }
    // 供 openSeries / openPlayer / pClose 等处调用
    closeEpCard = () => { epCard.hidden = true; };

    epBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (epCard.hidden) openEpCard(); else epCard.hidden = true;
    });
    $('pEpClose').addEventListener('click', (e) => { e.stopPropagation(); epCard.hidden = true; });
    // 点卡片外部关闭
    document.addEventListener('click', (e) => {
      if (!epCard.hidden
        && !epCard.contains(e.target) && !epBtn.contains(e.target)) epCard.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') epCard.hidden = true;
    });
    window.addEventListener('resize', () => { if (!epCard.hidden) placeEpCard(); });
  }

  /* ---------- 收藏按钮（播放器内） ---------- */
  /**
   * 同步播放器标题行里的收藏按钮：显示/隐藏 + 已收藏态。
   * 单集播放（无 series_id）时隐藏 —— 没有可收藏的主体。
   */
  function syncFavBtn() {
    const btn = $('pFavBtn');
    if (!ctx.seriesId) { btn.hidden = true; return; }
    btn.hidden = false;
    paintFavBtn(LIB.isFav(ctx.seriesId));
  }

  /** 按钮文案/配色：已收藏用实心星与品牌色 */
  function paintFavBtn(on) {
    const btn = $('pFavBtn');
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    btn.title = on ? '已收藏，点击取消' : '收藏这部短剧';
  }

  $('pFavBtn').addEventListener('click', () => {
    if (!ctx.seriesId) return;
    const ep = ctx.episodes[ctx.index];
    const on = LIB.toggleFav({
      sid: ctx.seriesId, title: ctx.title, cover: ctx.cover,
      ep: (ep && ep.index) || 1, total: ctx.total,
    });
    paintFavBtn(on);
    toast(on ? '已加入收藏' : '已取消收藏', 1600);
  });

  /* ---------- 历史 / 收藏 列表 ---------- */
  const libModal = $('libModal');
  let libKind = 'history'; // 当前展示的列表：history | fav

  /**
   * 打开历史/收藏弹层。
   * 列表项展示剧名、集数进度与总集数，「继续播放」从上次那一集接着播。
   */
  function openLib(kind) {
    libKind = kind === 'fav' ? 'fav' : 'history';
    $('libTitle').textContent = libKind === 'fav' ? '我的收藏' : '播放历史';
    $('libHint').textContent = libKind === 'fav'
      ? '收藏的短剧保存在本机浏览器（localStorage），不会上传。'
      : '播放过的短剧会自动记在这里（不含播放时间），点「继续播放」接着看。';
    renderLib();
    libModal.hidden = false;
  }

  function renderLib() {
    const list = LIB.read(libKind);
    const box = $('libList');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><span class="big">${
        libKind === 'fav' ? '☆' : '🕘'}</span>${
        libKind === 'fav' ? '还没有收藏任何短剧' : '还没有播放记录'}</div>`;
      return;
    }
    box.innerHTML = list.map((it) => {
      const img = it.cover ? coverUrl(it.cover) : '';
      const poster = img
        ? `<div class="poster"><img loading="lazy" src="${esc(img)}" alt=""
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'无封面'}))"></div>`
        : '<div class="poster"><div class="ph">无封面</div></div>';
      const ep = Number(it.ep) || 0;
      const total = Number(it.total) || 0;
      // 收藏条目额外显示「已看至第几集」——收藏时会记下当时播到哪一集，
      // 这个信息对「回头找这部剧」很有用，不该被丢掉。
      const prog = libKind === 'fav'
        ? [total ? `共 ${total} 集` : '',
          (ep && total > 1) ? `已看至第 <b>${ep}</b> 集` : ''].filter(Boolean).join(' · ')
          || '点击播放'
        : (ep ? `看到第 <b>${ep}</b> 集${total ? ` / 共 ${total} 集` : ''}` : '尚未播放');
      const extra = libKind === 'fav'
        ? `<button class="mini-btn lib-unfav" data-sid="${esc(it.sid)}" title="取消收藏">取消</button>`
        : `<button class="mini-btn lib-del" data-sid="${esc(it.sid)}" title="删除这条记录">删除</button>`;
      return `<article class="lib-item" data-sid="${esc(it.sid)}" data-ep="${ep}">
        ${poster}
        <div class="lib-meta">
          <h4 class="lib-name">${esc(it.title || '未命名')}</h4>
          <p class="lib-prog">${prog}</p>
        </div>
        <div class="lib-ops">
          <button class="mini-btn primary lib-play" data-sid="${esc(it.sid)}" data-ep="${ep}">继续播放</button>
          ${extra}
        </div>
      </article>`;
    }).join('');
  }

  /** 「继续播放」：以记录的集号续播；集号越界（剧集变动）时回落到第 1 集 */
  async function resumePlay(sid, ep) {
    libModal.hidden = true;
    // 历史里存的是 1 起的集号，playAt 用 0 起的下标
    let idx = (Number(ep) || 1) - 1;
    try {
      setStatus('获取剧集…');
      const j = await api(`/episodes?series_id=${encodeURIComponent(sid)}`);
      const eps = j.episodes || [];
      if (!eps.length) { toast('该剧暂无剧集'); return; }
      if (idx < 0 || idx >= eps.length) idx = 0;
    } catch (e) {
      handleError(e);
      return;
    }
    const item = LIB.read(libKind).find((x) => x.sid === sid);
    openSeries(sid, item ? item.title : '', { startAt: idx, resume: true });
  }

  $('histBtn').addEventListener('click', () => openLib('history'));
  $('favBtn').addEventListener('click', () => openLib('fav'));
  $('libClose').addEventListener('click', () => { libModal.hidden = true; });
  libModal.addEventListener('click', (e) => {
    if (e.target === libModal) libModal.hidden = true;
    const playBtn = e.target.closest('.lib-play');
    if (playBtn) {
      resumePlay(playBtn.dataset.sid, playBtn.dataset.ep);
      return;
    }
    const unfav = e.target.closest('.lib-unfav');
    if (unfav) {
      LIB.removeFav(unfav.dataset.sid);
      renderLib();
      // 播放器开着的话同步按钮态
      if (ctx.seriesId === unfav.dataset.sid) paintFavBtn(false);
      toast('已取消收藏', 1600);
      return;
    }
    const del = e.target.closest('.lib-del');
    if (del) {
      LIB.write('history', LIB.read('history').filter((x) => x.sid !== del.dataset.sid));
      renderLib();
    }
  });
  $('libClear').addEventListener('click', () => {
    if (!LIB.read(libKind).length) { toast('列表已是空的'); return; }
    LIB.clear(libKind);
    renderLib();
    if (libKind === 'fav' && ctx.seriesId) paintFavBtn(false);
    toast('已清空' + (libKind === 'fav' ? '收藏' : '历史'), 1600);
  });
  // Esc 关闭：历史/收藏弹层与选集卡片、简介气泡会同时响应，
  // 这里只收起自己，避免误关播放器。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !libModal.hidden) libModal.hidden = true;
  });

  // ---------- 网页全屏 ----------
  // 只把播放器卡片铺满浏览器视口，不调用 requestFullscreen()。
  // 原因：原生全屏会隐藏标签栏、且系统 Esc 直接退出全屏（我们的 Esc 还要
  // 用来关闭选集卡片与简介气泡），行为不可控；铺满视口已能满足「看全画面」需求。
  const pFullBtn = $('pFull');
  // 关闭播放器时必须复位，否则下次打开会「莫名其妙」仍是全屏
  let veFull = false;
  function setVeFull(on) {
    veFull = !!on;
    playerEl.classList.toggle('ve-full', veFull);
    pFullBtn.setAttribute('aria-pressed', veFull ? 'true' : 'false');
    pFullBtn.title = veFull ? '退出网页全屏' : '网页全屏';
  }
  pFullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setVeFull(!veFull);
  });

  $('pClose').addEventListener('click', () => {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    playerEl.hidden = true;
    setVeFull(false); // 复位全屏，避免下次打开时残留
    ctx.episodes = [];
    ctx.index = -1;
    $('pEpGrid').innerHTML = '';
    $('pStatus').textContent = '';
    setAbstract('');
    toggleInfo(false);
    closeEpCard();
    // 清掉主体后同步收藏按钮：没有可收藏的剧时按钮应隐藏，
    // 否则上一次播放残留的 ★/☆ 状态会留在空播放器上。
    ctx.seriesId = '';
    ctx.cover = '';
    ctx.total = 0;
    ctx.freshOpen = false;
    syncFavBtn();
    updatePMeta(); // 无剧集 → 集数按钮隐藏
    // 重置解码检测，下次打开会重新判定（换设备/换源可能结论不同）
    codecChecked = false;
    codecBlocked = false;
  });
  // 播放器的关闭入口只有右上角的 ✕ 按钮。
  // 早期版本这里监听了遮罩层点击（e.target === playerEl）转发到 pClose，
  // 导致点视频、点集数区、点遮罩空白处都会直接关闭播放器，
  // 正在看进度或操作选集时极易误触，因此刻意去掉，只保留显式关闭按钮。
  playerEl.addEventListener('click', (e) => {
    // 遮罩（.modal 背景）上的点击不再关闭播放器，吞掉冒泡避免误触。
    // 仅当点击落在遮罩本身（而非 .modal-card 内部）时拦截。
    if (e.target === playerEl) e.stopPropagation();
  });

  // ---------- 搜索 ----------
  // 只在「回车」或「点搜索按钮」时触发，不再随输入自动搜索。
  // 早期版本带 420ms 防抖自动触发，打字过程中就反复请求上游，
  // 既浪费配额又让结果列表来回闪。
  const searchEl = $('search');
  const searchBtn = $('searchBtn');

  function submitSearch() {
    const q = searchEl.value.trim();
    if (!q) { toast('请输入剧名'); searchEl.focus(); return; }
    doSearch(q);
  }

  searchBtn.addEventListener('click', submitSearch);
  searchEl.addEventListener('keydown', (e) => {
    // e.isComposing 为 true 表示正在用输入法选词，此时回车是"确认候选词"，不能触发搜索
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submitSearch();
    }
  });

  async function doSearch(q) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    view.innerHTML = '<div class="loading">搜索中…</div>';
    setStatus(`搜索「${q}」…`);
    try {
      const j = await api(`/search?q=${encodeURIComponent(q)}&limit=30`);
      const items = j.results || [];
      view.innerHTML = `<div class="section-head"><h2>搜索「${esc(q)}」</h2>
        <span class="muted">${items.length} 个结果</span></div>
        ${items.length ? `<div class="grid">${items.map(cardTemplate).join('')}</div>`
          : '<div class="empty"><span class="big">🔍</span>没有找到相关剧集</div>'}`;
      bindCards();
      setStatus(`搜索完成 · ${items.length} 个结果`, 'ok');
    } catch (e) { handleError(e); }
  }

  // ---------- 错误处理 ----------
  function handleError(e) {
    if (e && e.status === 401) return handle401();
    const msg = e && e.message ? e.message : String(e);
    setStatus('出错：' + msg, 'err');
    view.innerHTML = `<div class="empty"><span class="big">⚠️</span>
      <div>${esc(msg)}</div>
      <div class="muted" style="margin-top:8px">请确认后端已启动：<code>npm start</code></div></div>`;
    toast('请求失败：' + msg);
  }

  /**
   * 401：密钥缺失或失效。
   *
   * 多数情况是后端重启换了密钥，重新取一次就能自愈，用户全程无感。
   * 但如果换完仍然 401（反向代理剥掉了参数、前后端指向不同实例等），
   * 自愈会退化成 401 → 取密钥 → adoptKey → loadTab → 401 的死循环：
   * 卡片反复开关、接口反复打，用户完全没法操作。所以这里有熔断 + 最小间隔。
   */
  function handle401() {
    // 自愈已在进行中时不重复发起：loadTab/renderGrid 等会并发打多个接口，
    // 它们几乎同时 401，不去重的话一次故障就把计数打满，直接误熔断。
    if (key401Pending) return;

    // 服务重启后密钥会变：清掉旧值并进入「获取中 + 自动重试」状态，
    // 而不是让用户对着一张空卡片手动粘贴。
    API_KEY = '';
    localStorage.removeItem('hg_key');
    $('keyInput').value = '';

    if (key401Count >= KEY_401_MAX) {
      // 熔断：自动重试救不回来，停下来交给用户。
      // 复位计数，让用户手动点一次「重新获取」后仍能再自动自愈一轮。
      key401Count = 0;
      stopKey401Retry();
      setStatus('密钥校验未通过，已停止自动重试', 'err');
      $('keyRetry').hidden = false;
      $('keyModal').hidden = false;
      setKeyState('error', `连续 ${KEY_401_MAX} 次获取密钥后接口仍返回 401，已停止自动重试。请确认浏览器访问的正是运行中的后端；`
        + '若经过反向代理，请检查它是否透传 api_key 参数。也可点「重新获取」再试一次，或手动粘贴密钥。');
      toast('密钥校验未通过，已停止自动重试');
      return;
    }

    setStatus('密钥失效，正在重新获取…', 'err');
    $('keyRetry').hidden = false;
    $('keyModal').hidden = false;
    setKeyState('loading', '密钥已失效，正在重新获取…');
    toast('密钥无效或已失效，正在重新获取');

    // 距上次自愈不足 MIN_GAP 就先等一会儿再试。
    // 不设最小间隔的话，「取到密钥但接口仍 401」会在几百毫秒内跑满 5 次：
    // 那时候后端可能只是还在预热（签名服务要几秒），却已被判成死循环。
    // 计数也只在真正发起时递增 —— 同一波并发 401 造成的延迟重试不算新的一次。
    const gap = Date.now() - key401TriedAt;
    const fire = () => {
      key401TriedAt = Date.now();
      key401Pending = true;
      ensureKey(true, false, true).finally(() => { key401Pending = false; });
    };
    if (gap >= KEY_401_MIN_GAP) {
      key401Count++;
      fire();
      return;
    }
    if (!key401Timer) {
      setKeyState('loading', `密钥已失效，${Math.ceil((KEY_401_MIN_GAP - gap) / 1000)} 秒后重试…`);
      key401Timer = setTimeout(() => {
        key401Timer = null;
        key401Count++;
        fire();
      }, KEY_401_MIN_GAP - gap);
    }
  }

  /** 取消 401 自愈的延迟重试（手动接管、熔断时用） */
  function stopKey401Retry() {
    if (key401Timer) { clearTimeout(key401Timer); key401Timer = null; }
  }

  // ---------- 主题 / 密钥 / 标签页 ----------
  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', cur);
    localStorage.setItem('hg_theme', cur);
  });
  document.documentElement.setAttribute('data-theme', localStorage.getItem('hg_theme') || 'dark');

  $('keyBtn').addEventListener('click', async () => {
    $('keyMsg').textContent = `API 地址：${API_BASE}`;
    $('keyModal').hidden = false;
    if (API_KEY) {
      $('keyInput').value = API_KEY;
      $('keyState').hidden = true;
      $('keyRetry').hidden = true;
      return;
    }
    // 没有本地密钥：立刻显示「获取中」并开始拉取，失败会自动重试
    $('keyInput').value = '';
    $('keyRetry').hidden = false;
    setKeyState('loading', '获取中…');
    await ensureKey(true, true);
  });
  $('keyRetry').addEventListener('click', async () => {
    $('keyRetry').disabled = true;
    setKeyState('loading', '获取中…');
    // 手动重试也给一次完整的自愈机会：熔断后用户点这里是明确表示「再试一次」，
    // 此时把 401 计数与延迟重试都清掉，让这次点击立即生效。
    key401Count = 0;
    stopKey401Retry();
    await ensureKey(true, true);
    $('keyRetry').disabled = false;
  });
  $('kClose').addEventListener('click', () => { $('keyModal').hidden = true; });
  $('keyModal').addEventListener('click', (e) => { if (e.target === $('keyModal')) $('kClose').click(); });
  $('keyCopy').addEventListener('click', () => {
    if (!$('keyInput').value) { toast('尚未获取到密钥'); return; }
    navigator.clipboard?.writeText($('keyInput').value);
    toast('已复制');
  });
  $('keySave').addEventListener('click', () => {
    const v = $('keyManual').value.trim();
    if (!v) return;
    API_KEY = v;
    localStorage.setItem('hg_key', v);
    keyRetryCount = 0;
    key401Count = 0;
    stopKeyRetry();   // 手动接管后停掉自动重试，避免几秒后被自动获取的结果覆盖
    stopKey401Retry();
    $('keyModal').hidden = true;
    toast('密钥已保存');
    loadTab(state.tab);
  });

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) loadTab(b.dataset.tab);
  });

  // ---------- 启动 ----------
  (async function boot() {
    if (IS_FILE) {
      apiInfo.textContent = `本地服务：${API_BASE}`;
      apiInfo.title = 'file:// 打开时使用本地后端；如后端不在 8000 端口，请修改 localStorage.hg_api';
    } else {
      apiInfo.textContent = `API：${API_BASE}`;
    }
    // 拿不到密钥时不在这里弹卡（刚打开页面就弹遮罩很吓人），
    // 而是转入后台重试：后端起来后自动拿到并加载首页。
    // interactive=false 时 ensureKey 仍会启动退避重试，只是不改弹层文案。
    await ensureKey();
    try {
      const h = await api('/health');
      const ready = (h.sign_backends || []).filter((b) => b.ready).length;
      setStatus(ready
        ? `服务正常 · 签名后端 ${ready} 个就绪`
        : '服务正常 · 签名后端未就绪（列表类接口仍可用）', ready ? 'ok' : '');
      // 服务端缺 ffmpeg 时无法剥离 CENC 信令，播放器可能拒播，先给一次预警。
      // 注：转码默认关闭（HG_TRANSCODE=1 才开），目标机器支持 HEVC 即可直出。
      if (h.ffmpeg === false) {
        apiInfo.textContent += ' · 未检测到 ffmpeg，视频可能无法播放';
        apiInfo.title = '未找到 ffmpeg：无法剥离 CENC 信令。'
          + '请安装 ffmpeg 并加入 PATH 后重启服务。'
          + '（若画面全黑但时间轴在走，另可设 HG_TRANSCODE=1 转码为 H.264）';
      }
    } catch {
      setStatus('正在等待后端启动…', 'err');
      view.innerHTML = `<div class="empty"><span class="big">🔌</span>
        <div>未连接到后端服务，正在自动重试…</div>
        <div class="muted" style="margin-top:8px">请在项目目录运行 <code>npm start</code>（默认 http://127.0.0.1:8000）<br>
        服务起来后本页会自动继续加载</div></div>`;
      // 后端没起时 /api-key 必然拿不到，这里显式再触发一轮带重试的获取：
      // ensureKey 成功后会 adoptKey → 自动关闭密钥卡片并 loadTab 恢复首页。
      ensureKey(false);
      return;
    }
    loadTab('home');
  })();
})();
