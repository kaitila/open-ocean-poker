/* Slush Poker Market — vanilla JS single-page app. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  let S = null;              // latest server state
  let token = LS.get('oop_token');
  let adminToken = (() => { try { return sessionStorage.getItem('oop_admin'); } catch { return null; } })();
  const ui = { trade: {}, playersTab: 'all', playerQuery: '', marketsTab: 'All', adminQuery: '' };
  const colorMaps = {};

  // ------------------------------------------------------------ utils
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (p) => { const v = p * 100; return v > 0 && v < 1 ? '<1%' : v > 99 && v < 100 ? '>99%' : `${Math.round(v)}%`; };
  const chips = (n) => Math.round(n).toLocaleString('en-US');
  const cents = (p) => `${(p * 100).toFixed(1)}¢`;
  const tz = () => (S && S.event.timezone) || 'Europe/Helsinki';
  const fmtTime = (t, o = {}) => new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', ...o }).format(new Date(t));
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return fmtTime(t, { day: 'numeric', month: 'short' }); };
  const playerById = (id) => S.players.find((p) => p.id === id);
  const marketById = (id) => S.markets.find((m) => m.id === id);
  const tableById = (id) => S.tables.find((t) => t.id === id);
  const isBusted = (pid) => !!S.busted[pid];

  function hash(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
  function initials(name) { return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  function avatar(nameOrPlayer, size = 'md', extra = '') {
    const p = typeof nameOrPlayer === 'object' ? nameOrPlayer : null;
    const name = p ? p.name : nameOrPlayer;
    const h = hash(name);
    const bg = `linear-gradient(135deg, hsl(${h % 360} 62% 56%), hsl(${(h + 50) % 360} 70% 44%))`;
    const busted = p && isBusted(p.id) ? ' busted' : '';
    if (p && p.photo) return `<span class="avatar ${size}${busted} ${extra}" style="background-image:url('${esc(p.photo)}')" role="img" aria-label="${esc(name)}"></span>`;
    return `<span class="avatar ${size}${busted} ${extra}" style="background:${bg}" aria-hidden="true">${esc(initials(name))}</span>`;
  }

  function toast(msg, err) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  async function api(path, body, admin) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    if (admin) opts.headers = { ...(opts.headers || {}), 'x-admin-token': adminToken || '' };
    if (admin && !body) opts.method = 'POST';
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  }

  async function refresh() {
    try {
      S = await api(`/api/state${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      if (token && !S.me) { token = null; LS.set('oop_token', null); }
    } catch (e) { if (!S) { app.innerHTML = `<div class="page"><div class="card empty">Can't reach the market server. Retrying…</div></div>`; } return; }
    renderNav();
    const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (!typing || !refresh.done) render();
    refresh.done = true;
  }

  // ------------------------------------------------------------ event time
  function eventPhase() {
    const now = S.serverTime ? Date.now() : Date.now();
    const st = Date.parse(S.event.startsAt), en = Date.parse(S.event.endsAt);
    const winner = marketById('winner');
    if (winner && winner.status === 'resolved') return { key: 'done', label: 'Winner crowned' };
    if (now < st) {
      const m = Math.round((st - now) / 60000);
      const label = m < 60 ? `Starts in ${m} min` : m < 1440 ? `Starts in ${Math.floor(m / 60)} h ${m % 60} min` : `Starts ${fmtTime(st, { weekday: 'short', day: 'numeric', month: 'short' })}`;
      return { key: 'soon', label };
    }
    if (now < en) return { key: 'live', label: 'Live now' };
    return { key: 'ended', label: 'Event ended' };
  }

  // ------------------------------------------------------------ nav
  function renderNav() {
    $('#nav-time').textContent = `${fmtTime(Date.now())} Helsinki`;
    const u = S.me;
    $('#nav-user').innerHTML = u
      ? `<a class="chip-pill num" href="#/portfolio" title="Your portfolio">${chips(u.balance)}<span class="lbl"> chips</span> ${avatar(u.name, 'sm')}</a>`
      : `<button class="btn small" data-join>Join market</button>`;
    const route = location.hash.split('/')[1] || '';
    const map = { '': 'home', markets: 'markets', m: 'markets', players: 'players', p: 'players', leaderboard: 'leaderboard', portfolio: 'leaderboard' };
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === map[route]));
  }

  // ------------------------------------------------------------ components
  function marketCard(m) {
    const status = m.status === 'resolved' ? `<span class="badge resolved">Resolved</span>` : m.status === 'closed' ? `<span class="badge closed">Paused</span>` : '';
    const sub = `<span>${esc(m.category)}</span><span class="num">${chips(m.volume)} chips traded</span>${m.kind === 'players' ? `<span>${m.outcomes.filter((o) => o.active).length} of ${m.outcomes.length} still in</span>` : ''}`;
    let body;
    if (m.kind === 'binary') {
      const y = m.outcomes.find((o) => o.id === 'yes').price;
      body = `<div class="mini-outcomes"><div style="display:flex;justify-content:space-between;font-size:14px;font-weight:600"><span class="up">Yes ${pct(y)}</span><span class="down">No ${pct(1 - y)}</span></div></div>
        <div class="binary-bar" aria-hidden="true"><div class="y" style="width:${y * 100}%"></div><div class="n" style="flex:1"></div></div>`;
    } else {
      const top = [...m.outcomes].sort((a, b) => b.price - a.price).slice(0, 3);
      body = `<div class="mini-outcomes">${top.map((o) => {
        const p = o.playerId && playerById(o.playerId);
        return `<div class="mini-row">${p ? avatar(p, 'xs') : `<span class="swatch" style="background:var(--accent);opacity:.6;margin-left:5px"></span>`}
          <div class="bar"><i style="width:${o.price * 100}%"></i><span>${esc(o.label)}</span></div><span class="pct num">${pct(o.price)}</span></div>`;
      }).join('')}</div>`;
    }
    return `<a class="card market-card" href="#/m/${esc(m.id)}"><div class="q">${esc(m.question)} ${status}</div><div class="sub">${sub}</div>${body}</a>`;
  }

  function hostLogo(name) { return `<span class="host-logo">${esc(initials(name).slice(0, 2))}</span>`; }

  // ------------------------------------------------------------ pages
  function pageHome() {
    const e = S.event;
    const st = new Date(e.startsAt);
    const ph = eventPhase();
    const month = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), month: 'short' }).format(st);
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), day: 'numeric' }).format(st);
    const dateLong = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), weekday: 'long', day: 'numeric', month: 'long' }).format(st);
    const alive = S.players.filter((p) => !isBusted(p.id)).length;
    const featured = S.markets.filter((m) => m.featured);
    const others = S.markets.filter((m) => !m.featured && m.category === 'Props');
    const lb = S.leaderboard.slice(0, 5);
    const u = S.me;

    return `<div class="event">
      <aside class="event-side">
        <div class="cover">
          <div class="cover-fallback"><div class="suits">♠♥♣♦</div><div class="t">Legendary Slush<br>Poker Tournament</div></div>
          ${e.coverUrl ? `<img src="${esc(e.coverUrl)}" alt="" onerror="this.remove()">` : ''}
        </div>
        <div class="side-section">
          <h4>Hosted By</h4>
          ${e.hosts.map((h) => `<div class="host-row">${hostLogo(h.name)}<span>${esc(h.name)}</span><span class="links">${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">Website</a>` : ''}</span></div>`).join('')}
        </div>
        <div class="side-section">
          <h4>${S.players.length} Players</h4>
          <div class="going-avatars">${S.players.slice(0, 8).map((p) => avatar(p, 'sm')).join('')}</div>
          <a class="small muted" href="#/players">${esc(S.players.slice(0, 2).map((p) => p.name).join(', '))}${S.players.length > 2 ? ` and ${S.players.length - 2} others` : ''}</a>
        </div>
        <div class="side-section">
          <h4>Top Forecasters</h4>
          ${lb.length ? lb.map((r, i) => `<div class="host-row small"><span class="faint num" style="width:14px">${i + 1}</span>${avatar(r.name, 'xs')}<span>${esc(r.name)}</span><span class="links num">${chips(r.netWorth)}</span></div>`).join('') : `<div class="small faint">Nobody yet. Be the first.</div>`}
          <a class="small muted" href="#/leaderboard">Full leaderboard →</a>
        </div>
      </aside>

      <section class="event-main">
        <div>
          <div class="event-tag">${ph.key === 'live' ? '<span class="live-dot"></span>' : ''}${esc(ph.label)} · Prediction Market</div>
          <h1 class="event-title">${esc(e.name)}</h1>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="meta-row"><div class="meta-icon cal-icon"><div class="m">${esc(month)}</div><div class="d">${esc(day)}</div></div>
            <div><div class="l1">${esc(dateLong)}</div><div class="l2">${fmtTime(e.startsAt)} – ${fmtTime(e.endsAt)} EET</div></div></div>
          <a class="meta-row" href="${esc(e.mapsUrl)}" target="_blank" rel="noopener"><div class="meta-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg></div>
            <div><div class="l1">${esc(e.venue)} ↗</div><div class="l2">${esc(e.address)}</div></div></a>
        </div>

        <div class="card">
          <div class="card-head">Prediction Market</div>
          <div class="card-body">
            ${u ? `<div class="reg-row">${avatar(u.name, 'md')}<div><div style="font-weight:600">You're in, ${esc(u.name.split(' ')[0])}!</div><div class="small muted">Back the players you believe in. Winning shares pay 1 chip each.</div></div></div>
              <div class="stat-grid"><div class="stat"><div class="v num">${chips(u.balance)}</div><div class="k">Chips to play</div></div>
                <div class="stat"><div class="v num">${chips(u.netWorth)}</div><div class="k">Net worth</div></div>
                <div class="stat"><div class="v num">#${Math.max(1, S.leaderboard.findIndex((r) => r.id === u.id) + 1)}</div><div class="k">Rank</div></div></div>
              <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><a class="btn" href="#/m/winner">Trade the winner</a><a class="btn secondary" href="#/portfolio">My portfolio</a></div>`
              : `<div class="small muted" style="margin-bottom:12px">Welcome! Grab <b>${chips(e.startingChips)} free play chips</b> and back the players, tables and props you believe in. Just pick a name. No sign-up, no real money.</div>
              <button class="btn block" data-join>Join the market</button>`}
            <div class="stat-grid"><div class="stat"><div class="v num">${alive}/${S.players.length}</div><div class="k">Players left</div></div>
              <div class="stat"><div class="v num">${S.leaderboard.length}</div><div class="k">Forecasters</div></div>
              <div class="stat"><div class="v num">${chips(S.markets.reduce((a, m) => a + m.volume, 0))}</div><div class="k">Chips traded</div></div></div>
          </div>
        </div>

        <div>
          <div class="section-title">About Event</div>
          <div class="about">${e.about.map((p) => `<p>${esc(p)}</p>`).join('')}
            <p class="small"><a class="muted" href="${esc(e.lumaUrl)}" target="_blank" rel="noopener">View the event on Luma ↗</a></p></div>
        </div>

        <div>
          <div class="section-title">Markets</div>
          <div class="market-list">${featured.map(marketCard).join('')}${others.slice(0, 3).map(marketCard).join('')}</div>
          <div style="margin-top:12px"><a class="btn secondary small" href="#/markets">All ${S.markets.length} markets →</a></div>
        </div>

        <div>
          <div class="section-title">Activity</div>
          ${feed(8)}
        </div>
      </section>
    </div>`;
  }

  function feed(n) {
    const t = S.trades.slice(0, n);
    if (!t.length) return `<div class="card empty">No trades yet. Prices are waiting for you.</div>`;
    return `<div class="card">${t.map((x) => {
      const m = marketById(x.marketId); const o = m && m.outcomes.find((o) => o.id === x.outcomeId);
      if (!m || !o) return '';
      return `<div class="feed-row">${avatar(x.user, 'xs')}<div><b>${esc(x.user)}</b> <span class="${x.side === 'buy' ? 'up' : 'down'}">${x.side === 'buy' ? 'bought' : 'sold'}</span> <a href="#/m/${esc(m.id)}"><b>${esc(o.label)}</b></a> <span class="muted">for ${chips(x.chips)} chips</span></div><span class="t">${ago(x.t)}</span></div>`;
    }).join('')}</div>`;
  }

  function pageMarkets() {
    const cats = ['All', ...new Set(S.markets.map((m) => m.category))];
    const list = S.markets.filter((m) => ui.marketsTab === 'All' || m.category === ui.marketsTab);
    return `<div class="page"><div class="page-head"><h1>Markets</h1><p>Pick a market, back an outcome. Prices are probabilities, and each winning share pays 1 chip.</p></div>
      <div class="tabs">${cats.map((c) => `<button class="tab${ui.marketsTab === c ? ' active' : ''}" data-mtab="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="market-list">${list.map(marketCard).join('')}</div></div>`;
  }

  function pageMarket(id, params) {
    const m = marketById(id);
    if (!m) return notFound();
    const t = (ui.trade[m.id] = ui.trade[m.id] || { side: 'buy', amount: 50 });
    if (params.get('o') && ui.appliedHash !== location.hash && m.outcomes.some((o) => o.id === params.get('o'))) { t.outcome = params.get('o'); ui.appliedHash = location.hash; }
    const tradable = m.outcomes.filter((o) => o.active);
    if (!t.outcome || !m.outcomes.some((o) => o.id === t.outcome && o.active)) t.outcome = (tradable.sort((a, b) => b.price - a.price)[0] || {}).id;
    const pos = (S.me && S.me.positions[m.id]) || {};
    const sorted = [...m.outcomes].sort((a, b) => (b.active - a.active) || (b.price - a.price) || a.label.localeCompare(b.label));
    const cmap = chartColors(m);
    const resolvedO = m.resolution && m.outcomes.find((o) => o.id === m.resolution);

    return `<div class="page">
      <a class="back" href="#/markets">← All markets</a>
      <div class="page-head"><div class="event-tag">${esc(m.category)} · <span class="num">${chips(m.volume)} chips traded</span></div><h1>${esc(m.question)}</h1>
        ${m.description ? `<p>${esc(m.description)}</p>` : ''}
        ${resolvedO ? `<p><span class="badge resolved">Resolved: ${esc(resolvedO.label)}</span> <span class="small faint">${esc(m.resolvedReason || '')}</span></p>` : m.status === 'closed' ? `<p><span class="badge closed">Trading paused by the organisers</span></p>` : ''}
      </div>
      <div class="market-layout">
        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="card"><div class="card-head">Chance over time</div>${chart(m, cmap)}</div>
          <div class="card">${sorted.map((o) => {
            const p = o.playerId && playerById(o.playerId);
            const held = pos[o.id] || 0;
            const sw = cmap[o.id] ? `<span class="swatch" style="background:${cmap[o.id]}"></span>` : '';
            const lead = p ? avatar(p, 'md') : `<span class="meta-icon" style="width:40px;height:40px">${o.id === 'yes' ? '✓' : o.id === 'no' ? '✕' : '♠'}</span>`;
            const sub = p ? `${esc(p.title || '')}${p.company ? ` · ${esc(p.company)}` : ''}${p.table ? ` · ${esc((tableById(p.table) || {}).name || p.table)}` : ''}` : '';
            const tag = p && isBusted(p.id) ? ` <span class="badge busted">Busted</span>` : m.resolution === o.id ? ` <span class="badge resolved">Winner</span>` : '';
            return `<div class="outcome-row${o.active || m.resolution === o.id ? '' : ' inactive'}">${lead}
              <div class="name">${p ? `<a href="#/p/${esc(p.id)}">${esc(o.label)}</a>` : esc(o.label)}${tag} ${sw}<div class="s">${sub}</div>${held > 0.001 ? `<div class="held num">You hold ${held.toFixed(1)} shares</div>` : ''}</div>
              <div class="pct num">${pct(o.price)}</div>
              <div class="act">${o.active && m.status === 'open' ? `<button class="btn small ${t.outcome === o.id ? '' : 'secondary'}" data-pick="${esc(o.id)}">${t.outcome === o.id ? 'Selected' : 'Trade'}</button>` : ''}</div></div>`;
          }).join('')}</div>
        </div>
        <div class="sticky">${tradePanel(m, t, pos)}</div>
      </div></div>`;
  }

  function tradePanel(m, t, pos) {
    if (m.status !== 'open') return `<div class="card"><div class="card-head">Trade</div><div class="card-body small muted">${m.status === 'resolved' ? 'This market is settled. Winning shares have been paid out.' : 'Trading is paused right now.'}</div></div>`;
    if (!S.me) return `<div class="card"><div class="card-head">Trade</div><div class="card-body"><div class="small muted" style="margin-bottom:12px">Join with a name to get ${chips(S.event.startingChips)} play chips.</div><button class="btn block" data-join>Join the market</button></div></div>`;
    const o = m.outcomes.find((x) => x.id === t.outcome);
    if (!o) return '';
    const held = pos[o.id] || 0;
    return `<div class="card" id="trade-panel"><div class="card-head">Trade</div><div class="card-body">
      <div class="seg"><button class="${t.side === 'buy' ? 'on' : ''}" data-side="buy">Buy</button><button class="${t.side === 'sell' ? 'on' : ''}" data-side="sell">Sell</button></div>
      <div class="field"><label for="t-outcome">Outcome</label>
        <select class="input" id="t-outcome">${m.outcomes.filter((x) => x.active).sort((a, b) => b.price - a.price).map((x) => `<option value="${esc(x.id)}" ${x.id === o.id ? 'selected' : ''}>${esc(x.label)} · ${pct(x.price)}</option>`).join('')}</select></div>
      <div class="field"><label for="t-amount">${t.side === 'buy' ? 'Chips to spend' : `Shares to sell (you hold ${held.toFixed(1)})`}</label>
        <input class="input num" id="t-amount" type="number" min="0" step="${t.side === 'buy' ? 1 : 0.1}" inputmode="decimal" value="${esc(t.side === 'buy' ? t.amount : (t.shares ?? Math.floor(held * 10) / 10))}">
        <div class="quick">${t.side === 'buy'
          ? [10, 50, 100, 250].map((v) => `<button data-q="${v}">${v}</button>`).join('') + `<button data-q="max">Max</button>`
          : ['25%', '50%', 'All'].map((v) => `<button data-qs="${v}">${v}</button>`).join('')}</div></div>
      <div class="quote" id="quote"></div>
      <button class="btn block ${t.side === 'buy' ? 'yes' : 'no'}" id="t-go" style="margin-top:14px">${t.side === 'buy' ? 'Buy' : 'Sell'} ${esc(o.label)}</button>
      <div class="small faint" style="margin-top:10px">Balance: <span class="num">${chips(S.me.balance)}</span> chips</div>
    </div></div>`;
  }

  function activeIds(m) { return m.outcomes.filter((o) => o.active).map((o) => o.id); }

  function updateQuote() {
    const m = marketById(route().id); if (!m) return;
    const t = ui.trade[m.id]; const q = $('#quote'); const go = $('#t-go'); if (!q || !t) return;
    const v = Number($('#t-amount').value) || 0;
    const o = m.outcomes.find((x) => x.id === t.outcome);
    const act = activeIds(m);
    let html = '', ok = v > 0;
    if (t.side === 'buy') {
      t.amount = v;
      ok = ok && v <= S.me.balance;
      const sh = window.LMSR.sharesForAmount(m.q, act, m.b, o.id, v);
      const newP = window.LMSR.prices({ ...m.q, [o.id]: (m.q[o.id] || 0) + sh }, act, m.b)[o.id];
      html = `<div class="r"><span>Shares</span><b class="num">${sh.toFixed(1)}</b></div>
        <div class="r"><span>Avg price</span><b class="num">${v > 0 ? cents(v / sh) : '–'}</b></div>
        <div class="r"><span>Payout if ${esc(o.label)} wins</span><b class="num up">${chips(sh)} chips</b></div>
        <div class="r"><span>Chance after trade</span><b class="num">${pct(o.price)} → ${pct(newP)}</b></div>
        ${v > S.me.balance ? `<div class="small down">Not enough chips</div>` : ''}`;
    } else {
      t.shares = v;
      const held = ((S.me.positions[m.id] || {})[o.id]) || 0;
      ok = ok && v <= held + 1e-6;
      const back = window.LMSR.amountForShares(m.q, act, m.b, o.id, Math.min(v, held));
      html = `<div class="r"><span>You receive</span><b class="num up">${chips(back)} chips</b></div>
        <div class="r"><span>Avg price</span><b class="num">${v > 0 ? cents(back / Math.min(v, held || v)) : '–'}</b></div>
        ${v > held + 1e-6 ? `<div class="small down">You only hold ${held.toFixed(1)} shares</div>` : ''}`;
    }
    q.innerHTML = html;
    go.disabled = !ok;
  }

  // Line chart of chance over time (top 4 outcomes). Colors stick to entities.
  function chartColors(m) {
    const slots = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
    if (m.kind === 'binary') return { yes: 'var(--series-1)' };
    const map = (colorMaps[m.id] = colorMaps[m.id] || {});
    const top = (m.status === 'resolved' && m.resolution ? [m.outcomes.find((o) => o.id === m.resolution)] : [])
      .concat([...m.outcomes].filter((o) => o.active).sort((a, b) => b.price - a.price)).filter(Boolean)
      .filter((o, i, a) => a.indexOf(o) === i).slice(0, 4).map((o) => o.id);
    for (const k of Object.keys(map)) if (!top.includes(k)) delete map[k];
    for (const id of top) if (!map[id]) map[id] = slots.find((s) => !Object.values(map).includes(s));
    return map;
  }

  function chart(m, cmap) {
    const ids = Object.keys(cmap);
    const hist = [...m.history];
    const nowP = {}; m.outcomes.forEach((o) => { nowP[o.id] = o.price; });
    hist.push({ t: Math.max(Date.now(), (hist[hist.length - 1] || {}).t || 0), p: nowP });
    const W = 600, H = 220, L = 4, R = 40, T = 10, B = 24;
    const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 60000);
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (p) => T + (1 - p) * (H - T - B);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${W - R + 6}" y="${y(g) + 4}">${g * 100}%</text>`).join('');
    const ticks = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text x="${x(t)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${fmtTime(t)}</text>`).join('');
    const lines = ids.map((id) => {
      // step line: price holds until the next trade
      let d = '';
      hist.forEach((h, i) => { const px = x(h.t), py = y(h.p[id] ?? 0); d += i ? `H${px.toFixed(1)}V${py.toFixed(1)}` : `M${px.toFixed(1)},${py.toFixed(1)}`; });
      return `<path d="${d}" fill="none" stroke="${cmap[id]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');
    const tl = hist[hist.length - 1].t;
    const ends = ids.map((id) => `<circle cx="${x(tl)}" cy="${y(nowP[id] || 0)}" r="4" fill="${cmap[id]}" stroke="var(--card-solid)" stroke-width="2"/>`).join('');
    const label = (id) => (m.outcomes.find((o) => o.id === id) || {}).label || id;
    return `<div class="chart-wrap" data-chart="${esc(m.id)}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Chance over time for ${esc(ids.map(label).join(', '))}">
        <g class="axis">${grid}${ticks}</g>${lines}${ends}
        <line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--text-3)" stroke-dasharray="3 3" style="display:none"/>
        <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" class="hit"/>
      </svg><div class="chart-tip"></div></div>
      <div class="chart-legend">${ids.map((id) => `<span><i class="swatch" style="background:${cmap[id]}"></i>${esc(label(id))} <b class="num">${pct(nowP[id] || 0)}</b></span>`).join('')}</div>`;
  }

  function bindChart() {
    $$('[data-chart]').forEach((wrap) => {
      const m = marketById(wrap.dataset.chart); if (!m) return;
      const svg = $('svg', wrap), tip = $('.chart-tip', wrap), xh = $('.xhair', wrap), hit = $('.hit', wrap);
      const cmap = colorMaps[m.id] || chartColors(m); const ids = Object.keys(cmap);
      const hist = [...m.history, { t: Date.now(), p: Object.fromEntries(m.outcomes.map((o) => [o.id, o.price])) }];
      const W = 600, L = 4, R = 40; const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 60000);
      const move = (ev) => {
        const rect = svg.getBoundingClientRect();
        const fx = ((ev.clientX - rect.left) / rect.width) * W;
        const t = t0 + ((fx - L) / (W - L - R)) * (t1 - t0);
        let h = hist[0]; for (const e of hist) { if (e.t <= t) h = e; else break; }
        xh.setAttribute('x1', fx); xh.setAttribute('x2', fx); xh.style.display = '';
        tip.style.display = 'block';
        tip.innerHTML = `<div class="faint" style="margin-bottom:4px">${fmtTime(Math.min(Math.max(t, t0), t1))}</div>` + ids.map((id) => `<div class="r"><span style="display:inline-flex;gap:6px;align-items:center"><i class="swatch" style="background:${cmap[id]}"></i>${esc((m.outcomes.find((o) => o.id === id) || {}).label)}</span><b class="num">${pct(h.p[id] ?? 0)}</b></div>`).join('');
        const px = ev.clientX - wrap.getBoundingClientRect().left;
        tip.style.left = `${Math.min(px + 12, wrap.clientWidth - tip.offsetWidth - 4)}px`;
        tip.style.top = '8px';
      };
      hit.addEventListener('pointermove', move);
      hit.addEventListener('pointerdown', move);
      hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; xh.style.display = 'none'; });
    });
  }

  function pagePlayers() {
    const winner = marketById('winner');
    const odds = (pid) => { const o = winner && winner.outcomes.find((x) => x.playerId === pid); return o ? o.price : null; };
    const q = ui.playerQuery.toLowerCase();
    const match = (p) => !q || [p.name, p.company, p.title].join(' ').toLowerCase().includes(q);
    const card = (p) => {
      const o = odds(p.id);
      return `<a class="card player-card" href="#/p/${esc(p.id)}">${avatar(p, 'lg')}
        <div><div class="n">${esc(p.name)}</div><div class="t">${esc(p.title || '')}${p.company ? `<br>${esc(p.company)}` : ''}</div></div>
        <div class="foot">${isBusted(p.id) ? `<span class="badge busted">Busted #${S.players.length - S.busted[p.id].order + 1}</span>` : `<span class="badge">${esc((tableById(p.table) || {}).name || 'Unseated')}</span>`}
          ${o != null && !isBusted(p.id) ? `<span class="num" style="font-weight:600">${pct(o)}</span>` : ''}</div></a>`;
    };
    let body;
    if (ui.playersTab === 'tables') {
      body = S.tables.map((t) => {
        const ps = S.players.filter((p) => p.table === t.id && match(p)).sort((a, b) => (a.seat || 0) - (b.seat || 0));
        if (!ps.length) return '';
        const left = ps.filter((p) => !isBusted(p.id)).length;
        return `<div class="table-block"><h3>${esc(t.name)} <span class="badge">${left}/${ps.length} left</span> <a class="small muted" style="font-weight:500" href="#/m/table-${esc(t.id)}">Table market →</a></h3><div class="player-grid">${ps.map(card).join('')}</div></div>`;
      }).join('');
    } else {
      const list = S.players.filter(match).sort((a, b) => (isBusted(a.id) - isBusted(b.id)) || ((odds(b.id) || 0) - (odds(a.id) || 0)));
      body = list.length ? `<div class="player-grid">${list.map(card).join('')}</div>` : `<div class="card empty">No players match.</div>`;
    }
    return `<div class="page"><div class="page-head"><h1>Players</h1><p>${S.players.length} players across ${S.tables.length} tables · ${S.players.filter((p) => !isBusted(p.id)).length} still in. The % is their current chance to win, according to the market.</p></div>
      <div class="toolbar"><div class="tabs" style="margin:0"><button class="tab${ui.playersTab === 'all' ? ' active' : ''}" data-ptab="all">By odds</button><button class="tab${ui.playersTab === 'tables' ? ' active' : ''}" data-ptab="tables">By table</button></div>
        <input class="input search" id="player-q" placeholder="Search players or companies" value="${esc(ui.playerQuery)}"></div>
      ${body}</div>`;
  }

  function pagePlayer(id) {
    const p = playerById(id);
    if (!p) return notFound();
    const t = tableById(p.table);
    const ms = S.markets.filter((m) => m.outcomes.some((o) => o.playerId === p.id));
    const tablemates = S.players.filter((x) => x.table === p.table && x.id !== p.id);
    const b = S.busted[p.id];
    return `<div class="page"><a class="back" href="#/players">← All players</a>
      <div class="profile">
        <div class="profile-side">${avatar(p, 'xl')}
          <div class="kv card card-body">
            <div><span>Status</span><span>${b ? `<span class="badge busted">Busted · ${fmtTime(b.at)}</span>` : '<span class="badge alive">Still in</span>'}</span></div>
            <div><span>Table</span><span>${t ? `<a href="#/m/table-${esc(t.id)}">${esc(t.name)}</a>` : '–'}${p.seat ? ` · Seat ${esc(p.seat)}` : ''}</span></div>
            ${p.role ? `<div><span>Role</span><span style="text-transform:capitalize">${esc(p.role)}</span></div>` : ''}
            <div><span>Experience</span><span>${p.firstTimer ? 'First-timer' : 'Returning player'}</span></div>
            ${p.linkedin ? `<div><span>LinkedIn</span><a href="${esc(p.linkedin)}" target="_blank" rel="noopener">Profile ↗</a></div>` : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:24px;min-width:0">
          <div><h1>${esc(p.name)}</h1><div class="muted" style="margin-top:4px">${esc(p.title || '')}${p.company ? ` · ${esc(p.company)}` : ''}</div>
            ${p.bio ? `<p style="margin:14px 0 0">${esc(p.bio)}</p>` : ''}</div>
          <div><div class="section-title">Markets</div><div class="card">${ms.map((m) => {
            const o = m.outcomes.find((x) => x.playerId === p.id);
            return `<div class="outcome-row"><span class="meta-icon">♠</span><div class="name"><a href="#/m/${esc(m.id)}">${esc(m.question)}</a><div class="s">${m.outcomes.length} players</div></div>
              <div class="pct num">${pct(o.price)}</div><div class="act">${o.active && m.status === 'open' ? `<a class="btn small yes" href="#/m/${esc(m.id)}?o=${esc(o.id)}">Back ${esc(p.name.split(' ')[0])}</a>` : ''}</div></div>`;
          }).join('') || '<div class="empty">Not in any markets.</div>'}</div></div>
          ${tablemates.length ? `<div><div class="section-title">Tablemates</div><div class="going-avatars" style="flex-wrap:wrap;gap:8px">${tablemates.map((x) => `<a href="#/p/${esc(x.id)}" title="${esc(x.name)}" style="margin:0">${avatar(x, 'md')}</a>`).join('')}</div></div>` : ''}
        </div></div></div>`;
  }

  function pageLeaderboard() {
    const start = S.event.startingChips;
    const rows = S.leaderboard;
    return `<div class="page"><div class="page-head"><h1>Leaderboard</h1><p>Net worth = chips plus the current market value of open positions. Everyone starts at ${chips(start)}.</p></div>
      <div class="market-layout"><div class="card">${rows.length ? rows.map((r, i) => {
        const d = r.netWorth - start;
        return `<div class="lb-row${S.me && S.me.id === r.id ? ' me' : ''}"><span class="lb-rank num">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span>${avatar(r.name, 'sm')}<span style="font-weight:500">${esc(r.name)}</span>
          <span class="lb-val num">${chips(r.netWorth)} <div class="d ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${chips(d)}</div></span></div>`;
      }).join('') : '<div class="empty">No forecasters yet.</div>'}</div>
      <div><div class="section-title">Latest trades</div>${feed(15)}</div></div></div>`;
  }

  function pagePortfolio() {
    if (!S.me) return `<div class="page"><div class="page-head"><h1>Portfolio</h1><p>Join the market to start trading.</p></div><button class="btn" data-join>Join the market</button>
      <div class="card card-body" style="margin-top:24px;max-width:420px"><div class="small muted" style="margin-bottom:8px">Already joined on another device? Paste your recovery code.</div><div style="display:flex;gap:8px"><input class="input" id="restore" placeholder="Recovery code"><button class="btn secondary" id="restore-go">Restore</button></div></div></div>`;
    const u = S.me;
    const rows = [];
    for (const [mid, pos] of Object.entries(u.positions)) {
      const m = marketById(mid); if (!m) continue;
      for (const [oid, sh] of Object.entries(pos)) {
        if (sh < 0.01) continue;
        const o = m.outcomes.find((x) => x.id === oid); if (!o) continue;
        rows.push({ m, o, sh, value: m.status === 'resolved' ? 0 : sh * o.price });
      }
    }
    rows.sort((a, b) => b.value - a.value);
    const settled = Object.entries(u.settled || {}).map(([mid, s]) => ({ m: marketById(mid), ...s })).filter((x) => x.m);
    return `<div class="page"><div class="page-head" style="display:flex;align-items:center;gap:16px">${avatar(u.name, 'lg')}<div><h1>${esc(u.name)}</h1><p class="num">${chips(u.balance)} chips · net worth ${chips(u.netWorth)}</p></div></div>
      <div class="market-layout"><div style="display:flex;flex-direction:column;gap:24px;min-width:0">
        <div><div class="section-title">Open positions</div><div class="card">${rows.filter((r) => r.m.status !== 'resolved').map((r) => {
          const p = r.o.playerId && playerById(r.o.playerId);
          return `<div class="outcome-row${r.o.active ? '' : ' inactive'}">${p ? avatar(p, 'md') : '<span class="meta-icon">♠</span>'}<div class="name"><a href="#/m/${esc(r.m.id)}?o=${esc(r.o.id)}">${esc(r.o.label)}</a>${p && isBusted(p.id) ? ' <span class="badge busted">Busted</span>' : ''}<div class="s">${esc(r.m.question)}</div><div class="held num">${r.sh.toFixed(1)} shares · pays ${chips(r.sh)} if right</div></div>
            <div class="pct num" style="font-size:15px">${chips(r.value)}<div class="small faint" style="font-weight:400">${pct(r.o.price)}</div></div><div></div></div>`;
        }).join('') || '<div class="empty">No open positions. <a href="#/markets" style="text-decoration:underline">Browse markets</a></div>'}</div></div>
        ${settled.length ? `<div><div class="section-title">Settled</div><div class="card">${settled.map((s) => `<div class="feed-row"><span>${esc(s.m.question)}</span><span class="t ${s.payout > 0 ? 'up' : 'faint'}" style="font-weight:600">${s.payout > 0 ? `+${chips(s.payout)}` : '0'}</span></div>`).join('')}</div></div>` : ''}
      </div>
      <div class="card card-body"><div style="font-weight:600;margin-bottom:4px">Recovery code</div><div class="small muted" style="margin-bottom:10px">Use this to open your account on another device. Keep it to yourself.</div>
        <div style="display:flex;gap:8px"><input class="input num small" readonly value="${esc(u.token)}" id="rc"><button class="btn secondary small" id="rc-copy">Copy</button></div>
        <button class="btn secondary small" style="margin-top:12px" id="logout">Sign out on this device</button></div></div></div>`;
  }

  function pageHow() {
    return `<div class="page prose" style="max-width:680px"><div class="page-head"><h1>How it works</h1><p>A friendly side-game for the poker night. Zero real money.</p></div>
      <h2>Chips</h2><p>Everyone gets ${chips(S.event.startingChips)} play chips when they join. Spend them buying shares in outcomes you think will happen.</p>
      <h2>Prices are probabilities</h2><p>A share pays out 1 chip if its outcome happens and 0 if it doesn't. If a player trades at 12%, a share costs about 0.12 chips. Buying pushes the price up and selling pushes it down. An automated market maker (LMSR) always takes the other side, so you can trade any time.</p>
      <h2>Busting out</h2><p>When the organisers mark a player as busted, their shares drop to zero and the remaining players' chances rise to fill the gap. Table markets resolve automatically when only one starter from that table is left.</p>
      <h2>Winning</h2><p>The leaderboard ranks everyone by net worth: chips in hand plus the market value of open positions. Top forecaster at the end of the night takes the bragging rights.</p>
      <h2>Fair play</h2><p>Players can trade too. Backing yourself is encouraged. Folding on purpose to win a market is not.</p></div>`;
  }

  function pageAdmin() {
    if (!adminToken) return `<div class="page" style="max-width:420px"><div class="page-head"><h1>Organisers</h1><p>Enter the admin token to mark busts and resolve markets.</p></div>
      <div style="display:flex;gap:8px"><input class="input" id="admin-t" type="password" placeholder="Admin token"><button class="btn" id="admin-go">Unlock</button></div></div>`;
    const q = ui.adminQuery.toLowerCase();
    const ps = S.players.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.table).toLowerCase() === q);
    return `<div class="page"><div class="page-head"><h1>Organisers</h1><p>Mark players as busted as they leave the tournament. Player and auto-resolving prop markets settle on their own. Resolve the rest by hand.</p></div>
      <div class="market-layout" style="grid-template-columns:1fr 1fr">
        <div><div class="section-title">Players</div><input class="input" id="admin-q" placeholder="Filter by name or table letter" value="${esc(ui.adminQuery)}" style="margin-bottom:10px">
          <div class="card">${ps.map((p) => `<div class="admin-row">${avatar(p, 'sm')}<div><div style="font-weight:500">${esc(p.name)}</div><div class="small faint">${esc((tableById(p.table) || {}).name || '')}${isBusted(p.id) ? ` · busted ${fmtTime(S.busted[p.id].at)}` : ''}</div></div>
            <button class="btn small ${isBusted(p.id) ? 'secondary' : 'no'}" data-bust="${esc(p.id)}" data-v="${isBusted(p.id) ? 0 : 1}">${isBusted(p.id) ? 'Undo' : 'Bust'}</button></div>`).join('')}</div></div>
        <div><div class="section-title">Markets</div><div class="card">${S.markets.map((m) => `<div class="admin-row" style="grid-template-columns:1fr auto"><div><div style="font-weight:500">${esc(m.question)}</div><div class="small faint">${m.status}${m.resolution ? ` → ${esc((m.outcomes.find((o) => o.id === m.resolution) || {}).label)}` : ''}${m.autoResolve || m.kind === 'players' ? ' · auto' : ''}</div></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${m.status === 'resolved' ? '' : `
              <button class="btn small secondary" data-mact="${m.status === 'open' ? 'close' : 'open'}" data-mid="${esc(m.id)}">${m.status === 'open' ? 'Pause' : 'Reopen'}</button>
              <select class="input small" style="width:auto;padding:5px 28px 5px 8px" data-rsel="${esc(m.id)}"><option value="">Resolve…</option>${m.outcomes.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select>`}</div></div>`).join('')}</div>
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap"><button class="btn secondary small" id="admin-reload">Reload data files</button><button class="btn secondary small" id="admin-grant">Give everyone +500 chips</button><button class="btn secondary small" id="admin-out">Lock</button></div></div>
      </div></div>`;
  }

  function notFound() { return `<div class="page"><div class="card empty">Nothing here. <a href="#/" style="text-decoration:underline">Back to the event</a></div></div>`; }

  // ------------------------------------------------------------ modal
  function openJoin() {
    $('#modal-root').innerHTML = `<div class="modal-back" data-close><div class="modal" role="dialog" aria-modal="true" aria-labelledby="jt">
      <button class="modal-close" data-close aria-label="Close">✕</button>
      <div style="font-size:28px;margin-bottom:8px">♠️♥️♣️♦️</div>
      <h3 id="jt">Join the market</h3><div class="small muted">You'll get ${chips(S.event.startingChips)} play chips. Use the name people know you by. It shows on the leaderboard.</div>
      <form id="join-form"><div class="field"><label for="jn">Your name</label><input class="input" id="jn" maxlength="40" autocomplete="name" placeholder="e.g. Aino from Kelp" required></div>
      <button class="btn block" style="margin-top:16px" type="submit">Get my chips</button></form></div></div>`;
    setTimeout(() => $('#jn').focus(), 30);
    $('#join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/join', { name: $('#jn').value });
        token = r.token; LS.set('oop_token', token);
        closeModal(); toast(`Welcome! ${chips(S.event.startingChips)} chips added.`);
        refresh.done = false; await refresh();
      } catch (err) { toast(err.message, true); }
    });
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  // ------------------------------------------------------------ router
  function route() {
    const [p, qs] = location.hash.replace(/^#/, '').split('?');
    const parts = p.split('/').filter(Boolean);
    return { name: parts[0] || '', id: parts[1] ? decodeURIComponent(parts[1]) : null, params: new URLSearchParams(qs || '') };
  }

  function render() {
    if (!S) return;
    const r = route();
    const pages = { '': pageHome, markets: pageMarkets, m: () => pageMarket(r.id, r.params), players: pagePlayers, p: () => pagePlayer(r.id), leaderboard: pageLeaderboard, portfolio: pagePortfolio, how: pageHow, admin: pageAdmin };
    const fn = pages[r.name] || notFound;
    const y = window.scrollY;
    app.innerHTML = fn();
    window.scrollTo(0, y);
    if (S.event.coverUrl) $('.page-bg-img').style.backgroundImage = `url('${S.event.coverUrl}')`;
    document.title = r.name === 'm' && marketById(r.id) ? `${marketById(r.id).question} · Slush Poker Market` : 'Slush Poker Market';
    bindChart();
    if ($('#quote')) updateQuote();
  }

  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); renderNav(); });

  // ------------------------------------------------------------ events
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('button, [data-close]');
    if (!el) return;
    const d = el.dataset;
    if ('close' in d && e.target === el) return closeModal();
    if ('join' in d) return openJoin();
    if (d.mtab) { ui.marketsTab = d.mtab; return render(); }
    if (d.ptab) { ui.playersTab = d.ptab; return render(); }
    const r = route();
    const m = r.name === 'm' && marketById(r.id);
    if (m && d.pick) { ui.trade[m.id].outcome = d.pick; ui.trade[m.id].shares = undefined; render(); if (window.innerWidth < 820) $('#trade-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (m && d.side) { ui.trade[m.id].side = d.side; ui.trade[m.id].shares = undefined; return render(); }
    if (m && d.q) { $('#t-amount').value = d.q === 'max' ? Math.floor(S.me.balance) : d.q; return updateQuote(); }
    if (m && d.qs) {
      const held = ((S.me.positions[m.id] || {})[ui.trade[m.id].outcome]) || 0;
      $('#t-amount').value = d.qs === 'All' ? held : Math.floor(held * parseInt(d.qs, 10) / 10) / 10;
      return updateQuote();
    }
    if (m && el.id === 't-go') {
      const t = ui.trade[m.id];
      const v = Number($('#t-amount').value);
      // Selling "All" sends the exact holding so no dust is left behind.
      const held = ((S.me.positions[m.id] || {})[t.outcome]) || 0;
      const shares = Math.abs(v - held) < 0.05 ? held : v;
      el.disabled = true;
      try {
        const res = await api('/api/trade', { token, marketId: m.id, outcomeId: t.outcome, side: t.side, amount: v, shares });
        const label = m.outcomes.find((o) => o.id === t.outcome).label;
        toast(t.side === 'buy' ? `Bought ${res.shares.toFixed(1)} shares of ${label}` : `Sold for ${chips(res.chips)} chips`);
        t.shares = undefined;
        refresh.done = false; await refresh();
      } catch (err) { toast(err.message, true); el.disabled = false; }
      return;
    }
    if (el.id === 'rc-copy') { navigator.clipboard?.writeText(S.me.token).then(() => toast('Copied')); return; }
    if (el.id === 'logout') { if (confirm('Sign out? Save your recovery code first if you want to come back.')) { token = null; LS.set('oop_token', null); refresh.done = false; await refresh(); } return; }
    if (el.id === 'restore-go') { token = $('#restore').value.trim(); LS.set('oop_token', token); refresh.done = false; await refresh(); if (!S.me) toast('Code not recognised', true); return; }
    // admin
    if (el.id === 'admin-go') {
      adminToken = $('#admin-t').value;
      try { await api('/api/admin/check', {}, true); try { sessionStorage.setItem('oop_admin', adminToken); } catch { /* */ } render(); } catch (err) { adminToken = null; toast(err.message, true); }
      return;
    }
    if (el.id === 'admin-out') { adminToken = null; try { sessionStorage.removeItem('oop_admin'); } catch { /* */ } return render(); }
    try {
      if (d.bust) { await api('/api/admin/bust', { playerId: d.bust, busted: d.v === '1' }, true); toast(d.v === '1' ? `${playerById(d.bust).name} busted` : 'Undone'); }
      else if (d.mact) { await api('/api/admin/market', { marketId: d.mid, action: d.mact }, true); }
      else if (el.id === 'admin-reload') { const r2 = await api('/api/admin/reload', {}, true); toast(`Reloaded: ${r2.players} players, ${r2.markets} markets`); }
      else if (el.id === 'admin-grant') { if (!confirm('Give every forecaster +500 chips?')) return; await api('/api/admin/grant', { amount: 500 }, true); toast('Chips granted'); }
      else return;
      refresh.done = false; await refresh();
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 't-amount') updateQuote();
    if (e.target.id === 'player-q') { ui.playerQuery = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#player-q'); i.focus(); i.setSelectionRange(pos, pos); }
    if (e.target.id === 'admin-q') { ui.adminQuery = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#admin-q'); i.focus(); i.setSelectionRange(pos, pos); }
  });

  document.addEventListener('change', async (e) => {
    const r = route();
    if (e.target.id === 't-outcome') { ui.trade[r.id].outcome = e.target.value; ui.trade[r.id].shares = undefined; render(); }
    if (e.target.dataset.rsel && e.target.value) {
      const m = marketById(e.target.dataset.rsel); const o = m.outcomes.find((x) => x.id === e.target.value);
      if (!confirm(`Resolve "${m.question}" to "${o.label}"? This pays out and can't be undone.`)) { e.target.value = ''; return; }
      try { await api('/api/admin/market', { marketId: m.id, action: 'resolve', outcomeId: o.id }, true); toast('Resolved'); refresh.done = false; await refresh(); } catch (err) { toast(err.message, true); }
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  refresh();
  setInterval(refresh, 4000);
})();
