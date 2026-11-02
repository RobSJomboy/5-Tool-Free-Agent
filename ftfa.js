'use strict';
// ════════════════════════════════════════════════════════════════════════
//  5-Tool Free Agent — shared engine for control.html + display.html
//  · live data: MLB StatsAPI free-agent feed + stats, Baseball Savant leaderboards
//  · the five-ellipse Venn (all 31 tool combinations exist as regions)
//  · stage renderer (chips, region highlight, Savant ghosts, spotlight card)
//  · relay transport (Jomboy Cloudflare relay + BroadcastChannel)
//  No dataset ships with the app — both pages fetch the same tables at load,
//  so the wire only carries ids and positions.
// ════════════════════════════════════════════════════════════════════════
const FT = (() => {
  const API = 'https://statsapi.mlb.com/api/v1';
  const SAV = 'https://baseballsavant.mlb.com';
  const HUB_DEFAULT = 'https://jomboy-relay.jomboymedia.workers.dev';

  // ── the five tools, clockwise from the top ellipse ──
  const TOOLS = [
    { key: 'hit',   name: 'HIT',   color: '#c98a00', blurb: 'Contact & bat-to-ball' },
    { key: 'power', name: 'POWER', color: '#c8102e', blurb: 'Damage on contact' },
    { key: 'speed', name: 'SPEED', color: '#1d7f45', blurb: 'Sprint speed' },
    { key: 'arm',   name: 'ARM',   color: '#1f5fbf', blurb: 'Throwing strength' },
    { key: 'glove', name: 'GLOVE', color: '#6b3fa0', blurb: 'Range & defense' },
  ];
  // The hosts can rename the tools on air ("BAT-TO-BALL", "WHEELS", …). Keys and
  // colours never change; only the label does. Angle brackets are stripped because
  // names end up in innerHTML on both pages.
  const TOOL_DEFAULT = Object.fromEntries(TOOLS.map(t => [t.key, t.name]));
  function setToolNames(map) {
    for (const t of TOOLS) {
      const n = String((map && map[t.key]) || '').replace(/[<>&"]/g, '').trim().toUpperCase().slice(0, 18);
      t.name = n || TOOL_DEFAULT[t.key];
    }
  }
  const COUNT_NAME = ['JUST A GUY', 'ONE-TOOL', 'TWO-TOOL', 'THREE-TOOL', 'FOUR-TOOL', 'FIVE-TOOL'];

  // ── Venn geometry ──
  // Five congruent ellipses, centres on a ring at 72° steps, each tilted the same
  // amount off its spoke. Parameters were searched so every one of the 31
  // combinations is a real region, maximising the smallest one. Units: the
  // diagram spans about ±0.88.
  const VENN = { R: 0.188, A: 0.691, B: 0.358, PH: 163.3 };
  const ELL = TOOLS.map((_, k) => {
    const a = (-90 + 72 * k) * Math.PI / 180;
    return { cx: VENN.R * Math.cos(a), cy: VENN.R * Math.sin(a), t: a + VENN.PH * Math.PI / 180 };
  });
  // Pole of inaccessibility of each region (the point deepest inside it) and
  // that depth, precomputed with a distance transform. Keyed by tool bitmask.
  const POLES = {"1":[-0.1417,-0.65,0.2012],"2":[0.5833,-0.3417,0.2],"3":[0.25,-0.4417,0.0402],"4":[0.5,0.45,0.2052],"5":[0.2417,0.3833,0.0589],"6":[0.5083,0.0917,0.0354],"7":[0.3083,0.2417,0.0402],"8":[-0.2583,0.6167,0.2],"9":[0.0417,-0.4583,0.0583],"10":[-0.2917,0.35,0.0583],"11":[0.1667,-0.4083,0.0486],"12":[0.075,0.5083,0.0402],"13":[0.1,0.4333,0.0486],"14":[-0.1083,0.3917,0.0354],"15":[0.0083,0.35,0.0652],"16":[-0.675,-0.0667,0.2],"17":[-0.3333,-0.375,0.0402],"18":[0.4417,-0.1083,0.0583],"19":[0.3333,-0.175,0.0417],"20":[-0.425,-0.1583,0.0583],"21":[-0.3417,-0.2833,0.05],"22":[0.4417,0.0333,0.05],"23":[0.3333,0.1167,0.0667],"24":[-0.4583,0.225,0.0417],"25":[-0.075,-0.375,0.0417],"26":[-0.375,0.2333,0.0471],"27":[0.2083,-0.2833,0.0667],"28":[-0.375,-0.05,0.0417],"29":[-0.2,-0.2917,0.0667],"30":[-0.3333,0.1083,0.0652],"31":[0,0,0.2912]};
  const maskAt = (u, v) => {
    let m = 0;
    ELL.forEach((e, k) => {
      const dx = u - e.cx, dy = v - e.cy;
      const a = dx * Math.cos(e.t) + dy * Math.sin(e.t), b = -dx * Math.sin(e.t) + dy * Math.cos(e.t);
      if ((a / VENN.A) ** 2 + (b / VENN.B) ** 2 <= 1) m |= 1 << k;
    });
    return m;
  };
  const bits = m => TOOLS.filter((_, k) => m & (1 << k));
  const countOf = m => bits(m).length;
  const regionName = m => m === 0 ? 'NO PLUS TOOLS' : m === 31 ? 'ALL FIVE' : bits(m).map(t => t.name).join(' · ');

  // On-air layout (1920×1080 stage). The show frame puts the two host cameras over
  // the left and right of the video window, so everything lives in a "safe" rect
  // between them. Defaults were measured off a Talkin' Baseball frame grab:
  // video window x165–1750 y41–901, Trev's box x10–392, Jake's x1528–1910 (y≈230–805).
  const SAFE_DEFAULT = { l: 400, t: 48, r: 1520, b: 895 };
  const CAMS = { top: 230, bottom: 805, video: { l: 165, t: 41, r: 1750, b: 901 } };
  const LAY = { CX: 960, CY: 472, U: 469, W: 1920, H: 1080, safe: Object.assign({}, SAFE_DEFAULT) };
  function setSafe(s) {
    const S = LAY.safe = Object.assign({}, SAFE_DEFAULT, s || {});
    LAY.CX = (S.l + S.r) / 2; LAY.CY = (S.t + S.b) / 2;
    // diagram spans ±0.88 units; keep a little air for the tool labels
    LAY.U = Math.min((S.r - S.l) / 2, (S.b - S.t) / 2) / 0.9;
  }
  setSafe();
  const toPx = (u, v) => [LAY.CX + u * LAY.U, LAY.CY + v * LAY.U];
  const toUV = (x, y) => [(x - LAY.CX) / LAY.U, (y - LAY.CY) / LAY.U];

  // ── teams ──
  const TEAMS = {
    108:['LAA','#BA0021'],109:['ARI','#A71930'],110:['BAL','#DF4601'],111:['BOS','#BD3039'],112:['CHC','#0E3386'],
    113:['CIN','#C6011F'],114:['CLE','#0C2340'],115:['COL','#33006F'],116:['DET','#0C2340'],117:['HOU','#002D62'],
    118:['KC','#004687'],119:['LAD','#005A9C'],120:['WSH','#AB0003'],121:['NYM','#002D72'],133:['ATH','#003831'],
    134:['PIT','#27251F'],135:['SD','#2F241D'],136:['SEA','#0C2C56'],137:['SF','#27251F'],138:['STL','#C41E3A'],
    139:['TB','#092C5C'],140:['TEX','#003278'],141:['TOR','#134A8E'],142:['MIN','#002B5C'],143:['PHI','#E81828'],
    144:['ATL','#13274F'],145:['CWS','#27251F'],146:['MIA','#00A3E0'],147:['NYY','#0C2340'],158:['MIL','#12284B'],
  };
  const team = id => TEAMS[id] ? { id, abbr: TEAMS[id][0], color: TEAMS[id][1] } : { id: 0, abbr: 'FA', color: '#2a3b4c' };
  const logo = id => `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg`;
  const headshot = (id, w = 426) => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_${w},q_auto:best/v1/people/${id}/headshot/silo/current`;

  // ── fetch helpers ──
  const getJSON = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(r.status); return r.json(); };
  async function csv(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(r.status);
    const text = (await r.text()).replace(/^﻿/, '');
    // quoted fields can hold commas — Savant's first header is literally "last_name, first_name"
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }
  const num = v => v === '' || v == null || isNaN(+v) ? null : +v;
  const byId = (rows, key = 'player_id') => { const m = {}; for (const r of rows) if (r[key]) m[+r[key]] = r; return m; };

  // ── Savant tables for one season ──
  async function savantYear(y) {
    const q = [
      `/leaderboard/percentile-rankings?type=batter&year=${y}&min=1&csv=true`,
      `/leaderboard/custom?year=${y}&type=batter&min=1&selections=xba,xslg,xwoba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,k_percent,bb_percent,whiff_percent,avg_swing_speed&csv=true`,
      `/leaderboard/sprint_speed?year=${y}&position=&team=&min=0&csv=true`,
      `/leaderboard/arm-strength?type=player&year=${y}&minThrows=1&csv=true`,
      `/leaderboard/outs_above_average?type=Fielder&startYear=${y}&endYear=${y}&min=1&csv=true`,
      `/leaderboard/poptime?year=${y}&team=&min2b=1&min3b=0&csv=true`,
      `/leaderboard/catcher-framing?year=${y}&team=&min=1&type=catcher&csv=true`,
    ];
    const [pct, cus, spd, arm, oaa, pop, frm] = await Promise.all(q.map(u => csv(SAV + u).catch(() => [])));
    // catchers don't get arm/OAA percentiles on the card — rank them among catchers instead
    const popQ = pop.filter(r => num(r.pop_2b_sba_count) >= 3 && num(r.pop_2b_sba) != null);
    const popPct = {};
    for (const r of popQ) {
      const t = num(r.pop_2b_sba);
      popPct[+r.entity_id] = Math.round(100 * popQ.filter(o => num(o.pop_2b_sba) > t).length / Math.max(1, popQ.length - 1));
    }
    const frmPct = {};
    for (const r of frm) {
      const t = num(r.rv_tot);
      if (t == null) continue;
      frmPct[+r.id] = Math.round(100 * frm.filter(o => num(o.rv_tot) < t).length / Math.max(1, frm.length - 1));
    }
    return { y, pct: byId(pct), cus: byId(cus), spd: byId(spd), arm: byId(arm), oaa: byId(oaa),
      pop: byId(pop, 'entity_id'), popPct, frm: byId(frm, 'id'), frmPct };
  }

  // ── tool scoring ──
  // A tool = the mean of its Savant percentiles, converted to the scouting 20-80
  // scale (50 = average, every 10 = one standard deviation). "Plus" = 55+ by default.
  const fmt3 = v => v == null ? null : (+v).toFixed(3).replace(/^0/, '');
  const COMP = {
    hit:   [['xba', 'xBA', s => fmt3(num(s.cus?.xba))], ['k_percent', 'K%', s => s.cus?.k_percent && `${s.cus.k_percent}%`],
            ['whiff_percent', 'Whiff%', s => s.cus?.whiff_percent && `${s.cus.whiff_percent}%`], ['squared_up_rate', 'Squared-Up%']],
    power: [['xslg', 'xSLG', s => fmt3(num(s.cus?.xslg))], ['brl_percent', 'Barrel%', s => s.cus?.barrel_batted_rate && `${s.cus.barrel_batted_rate}%`],
            ['exit_velocity', 'Avg EV', s => s.cus?.exit_velocity_avg && `${s.cus.exit_velocity_avg} mph`], ['bat_speed', 'Bat Speed', s => s.cus?.avg_swing_speed && `${s.cus.avg_swing_speed} mph`]],
    speed: [['sprint_speed', 'Sprint Speed', s => s.spd?.sprint_speed && `${s.spd.sprint_speed} ft/s`]],
    arm:   [['arm_strength', 'Arm Strength', s => s.arm?.arm_overall && `${(+s.arm.arm_overall).toFixed(1)} mph`]],
    glove: [['oaa', 'Outs Above Avg', s => s.oaa?.outs_above_average != null && s.oaa.outs_above_average !== '' ? signed(+s.oaa.outs_above_average) + ' OAA' : null]],
  };
  const signed = n => (n > 0 ? '+' : '') + (Math.round(n * 10) / 10);
  function invNorm(p) { // Acklam's rational approximation
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const gradeOf = pct => pct == null ? null : Math.max(20, Math.min(80, Math.round((50 + 10 * invNorm(Math.min(.995, Math.max(.005, pct / 100)))) / 5) * 5));

  function scoreTools(sv, id, isC) {
    const src = { pct: sv.pct[id], cus: sv.cus[id], spd: sv.spd[id], arm: sv.arm[id], oaa: sv.oaa[id] };
    const out = {};
    for (const t of TOOLS) {
      let parts = COMP[t.key].map(([k, label, val]) => ({ label, pct: num(src.pct?.[k]), val: val ? val(src) || null : null }));
      if (isC && t.key === 'arm' && sv.popPct[id] != null) {
        const r = sv.pop[id];
        parts = [{ label: 'Pop Time (C)', pct: sv.popPct[id], val: `${(+r.pop_2b_sba).toFixed(2)}s` }];
      }
      if (isC && t.key === 'glove' && sv.frmPct[id] != null) {
        parts = [{ label: 'Framing (C)', pct: sv.frmPct[id], val: `${signed(+sv.frm[id].rv_tot)} runs` }];
      }
      const have = parts.filter(p => p.pct != null);
      const pct = have.length ? Math.round(have.reduce((s, p) => s + p.pct, 0) / have.length) : null;
      out[t.key] = { pct, grade: gradeOf(pct), parts };
    }
    return out;
  }
  const toolCoverage = tools => TOOLS.filter(t => tools[t.key].pct != null).length;
  const savantMask = (p, T) => p && p.tools ? TOOLS.reduce((m, t, k) => (p.tools[t.key].grade ?? 0) >= T ? m | (1 << k) : m, 0) : 0;

  // ── data load ──
  const DB = { year: 2026, players: {}, faIds: [], sav: {}, ready: null };
  const pickSplit = s => s && s.splits && (s.splits.find(x => !x.team) || s.splits[0]);
  function statLine(st) {
    if (!st) return null;
    return { g: st.gamesPlayed, pa: st.plateAppearances, avg: st.avg, obp: st.obp, slg: st.slg, ops: st.ops,
      hr: st.homeRuns, sb: st.stolenBases, h: st.hits, rbi: st.rbi };
  }
  async function fetchPeople(ids, meta = {}) {
    const y = DB.year, out = [];
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const d = await getJSON(`${API}/people?personIds=${chunk.join(',')}&hydrate=currentTeam,stats(group=[hitting],type=[season,career,sabermetrics],season=${y})`).catch(() => ({ people: [] }));
      out.push(...(d.people || []));
    }
    for (const p of out) {
      const stats = {};
      for (const s of p.stats || []) stats[s.type.displayName] = pickSplit(s)?.stat;
      const pos = p.primaryPosition?.abbreviation || '';
      const m = meta[p.id] || {};
      const rec = {
        id: p.id, name: p.fullName.replace(/ Sr\.$/, ''), first: p.useName || p.firstName, last: p.useLastName || p.lastName,
        pos, age: p.currentAge, bats: p.batSide?.code, throws: p.pitchHand?.code,
        team: team(m.teamId || p.currentTeam?.id), fa: !!m.fa, declared: m.declared || null,
        season: statLine(stats.season), career: statLine(stats.career),
        war: stats.sabermetrics?.war != null ? Math.round(stats.sabermetrics.war * 10) / 10 : null,
        wrc: stats.sabermetrics?.wRcPlus != null ? Math.round(stats.sabermetrics.wRcPlus) : null,
      };
      // Savant: this season first, last season if he barely played
      const now = DB.sav[y], prev = DB.sav[y - 1];
      let tools = now ? scoreTools(now, p.id, pos === 'C') : null, savYear = y;
      if (prev && (!tools || toolCoverage(tools) < 3)) {
        const t2 = scoreTools(prev, p.id, pos === 'C');
        if (toolCoverage(t2) > (tools ? toolCoverage(tools) : 0)) { tools = t2; savYear = y - 1; }
      }
      rec.tools = tools; rec.savYear = savYear;
      DB.players[p.id] = rec;
    }
    return out.map(p => DB.players[p.id]);
  }
  function load(year = 2026, onStatus = () => {}) {
    DB.year = year;
    DB.ready = (async () => {
      onStatus('Loading Baseball Savant…');
      const [a, b] = await Promise.all([savantYear(year), savantYear(year - 1)]);
      DB.sav[year] = a; DB.sav[year - 1] = b;
      onStatus('Loading free agents…');
      const fa = await getJSON(`${API}/people/freeAgents?season=${year}`).catch(() => ({ freeAgents: [] }));
      const meta = {};
      for (const f of fa.freeAgents || []) {
        if (f.position?.type === 'Pitcher' || /minor/i.test(f.notes || '')) continue;
        meta[f.player.id] = { fa: true, teamId: f.originalTeam?.id, declared: f.dateDeclared };
      }
      DB.faIds = Object.keys(meta).map(Number);
      onStatus(`Loading stats for ${DB.faIds.length} free agents…`);
      await fetchPeople(DB.faIds, meta);
      onStatus('');
      return DB;
    })();
    return DB.ready;
  }
  // Players outside the free-agent feed (opt-outs, trade targets) — fetched on demand.
  const pending = {};
  async function ensure(ids) {
    const miss = ids.filter(id => !DB.players[id] && !pending[id]);
    if (!miss.length) return;
    const job = fetchPeople(miss);
    miss.forEach(id => pending[id] = job);
    await job;
    miss.forEach(id => delete pending[id]);
  }
  async function search(q) {
    const d = await getJSON(`${API}/people/search?names=${encodeURIComponent(q)}&sportIds=1&active=true`).catch(() => ({ people: [] }));
    return (d.people || []).filter(p => p.primaryPosition?.type !== 'Pitcher').slice(0, 12)
      .map(p => ({ id: p.id, name: p.fullName, pos: p.primaryPosition?.abbreviation }));
  }

  // ── Savant percentile colours (blue = poor, grey = average, red = great) ──
  function pctColor(p) {
    const lo = [50, 98, 175], mid = [190, 190, 190], hi = [214, 41, 57];
    const t = Math.max(0, Math.min(100, p)) / 100;
    const [A, B, f] = t < .5 ? [lo, mid, t / .5] : [mid, hi, (t - .5) / .5];
    return `rgb(${A.map((c, i) => Math.round(c + (B[i] - c) * f)).join(',')})`;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ════════════════════════════════════════════════════════════════════
  //  STAGE — 1920×1080, used as the OBS output and as the control's preview
  // ════════════════════════════════════════════════════════════════════
  function vennSVG() {
    const { U } = LAY, [cx, cy] = toPx(0, 0);
    let defs = '', fills = '', strokes = '', labels = '';
    ELL.forEach((e, k) => {
      const [x, y] = toPx(e.cx, e.cy), deg = e.t * 180 / Math.PI, t = TOOLS[k];
      const shape = `cx="${x}" cy="${y}" rx="${VENN.A * U}" ry="${VENN.B * U}" transform="rotate(${deg} ${x} ${y})"`;
      defs += `<clipPath id="ck${k}"><ellipse ${shape}/></clipPath><ellipse id="el${k}" ${shape}/>`;
      fills += `<ellipse class="vfill" ${shape} fill="${t.color}"/>`;
      strokes += `<ellipse class="vstroke" ${shape} stroke="${t.color}"/>`;
      // tool label sits out at the tip of the ellipse's own (single-tool) region
      const [pu, pv] = POLES[1 << k], r = Math.hypot(pu, pv), [lx, ly] = toPx(pu / r * 0.8, pv / r * 0.8);
      labels += `<g class="vlabel" transform="translate(${lx} ${ly})"><text fill="${t.color}" style="font-size:${Math.round(U * .115 * Math.min(1, 7 / Math.max(6, t.name.length)))}px">${t.name}</text></g>`;
    });
    return `<svg class="venn" viewBox="0 0 ${LAY.W} ${LAY.H}" width="${LAY.W}" height="${LAY.H}">
      <defs>${defs}
      </defs>
      <g class="vfills">${fills}</g>
      <g class="core">${regionShape(31, '#e9b949')}</g>
      <g class="hl"></g>
      <g class="vstrokes">${strokes}</g>
      <g class="vlabels">${labels}
        <g class="core-label" transform="translate(${cx} ${cy - POLES[31][2] * U * 0.66})"><rect x="-58" y="-17" width="116" height="34"/><text>5-TOOL</text></g>
      </g>
    </svg>`;
  }
  // SVG for one exact region: clipped to every ellipse it's in, masked out of the rest.
  let maskSeq = 0;
  function regionShape(m, fill) {
    const id = 'rm' + (maskSeq++);
    const excl = TOOLS.map((_, k) => m & (1 << k) ? '' : `<use href="#el${k}" fill="#000"/>`).join('');
    let inner = `<rect x="0" y="0" width="${LAY.W}" height="${LAY.H}" fill="${fill}"/>`;
    TOOLS.forEach((_, k) => { if (m & (1 << k)) inner = `<g clip-path="url(#ck${k})">${inner}</g>`; });
    return `<mask id="${id}"><rect x="0" y="0" width="${LAY.W}" height="${LAY.H}" fill="#fff"/>${excl}</mask><g mask="url(#${id})">${inner}</g>`;
  }

  function createStage(host) {
    const el = document.createElement('div');
    el.className = 'stage';
    el.innerHTML = `
      <div class="backdrop"></div>
      <div class="board">
        <div class="plate"><div class="title">5-TOOL<br>FREE AGENT</div><div class="sub"></div></div>
        <div class="vwrap">${vennSVG()}</div>
        <div class="guyzone"><b>JUST A GUY</b><span>outside the circles</span></div>
        <svg class="links" viewBox="0 0 ${LAY.W} ${LAY.H}" width="${LAY.W}" height="${LAY.H}">
          <defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>
          <g class="lk"></g>
        </svg>
        <div class="ghosts"></div>
        <div class="chips"></div>
        <div class="fx"></div>
      </div>
      <div class="over">
        <div class="shed"></div>
        <div class="card"></div>
      </div>`;
    host.appendChild(el);
    const q = s => el.querySelector(s);
    const chipEls = {}, ghostEls = {};
    let lastFx = 0, lastSpot = null, lastShedKey = '', hlMask = -1, lastSafe = '';
    function layout(safe, names) {
      setToolNames(names);
      const key = JSON.stringify([safe || {}, TOOLS.map(t => t.name)]);
      if (key === lastSafe) return;
      lastSafe = key;
      setSafe(safe);
      const s = LAY.safe;
      q('.vwrap').innerHTML = vennSVG();
      hlMask = -1;
      Object.assign(q('.plate').style, { left: s.l + 'px', top: s.t + 'px' });
      Object.assign(q('.guyzone').style, { left: s.l + 'px', top: (s.b - 170) + 'px' });
      // the card and the shed sit over the Venn, centred in the safe area
      const o = q('.over'), k = Math.min(1, (s.r - s.l - 24) / 1080, (s.b - s.t - 24) / 640);
      Object.assign(o.style, { left: (s.l + s.r) / 2 + 'px', top: (s.t + s.b) / 2 + 'px', transform: `translate(-50%,-50%) scale(${k})` });
    }

    function chipHTML(p) {
      return `<div class="ph" style="--tc:${p.team.color}"><img src="${headshot(p.id, 180)}" alt="" draggable="false"></div>
        <div class="nm">${esc(p.last || p.name)}</div><div class="badge"></div>`;
    }

    function highlight(m) {
      if (m === hlMask) return;
      hlMask = m;
      q('.hl').classList.remove('flash');
      q('.hl').innerHTML = m < 0 ? '' : regionShape(m, 'rgba(19,41,75,.2)');
    }
    function flashRegion(m) {
      const g = q('.hl');
      g.innerHTML = regionShape(m, 'rgba(19,41,75,.32)');
      g.classList.remove('flash'); void g.getBoundingClientRect(); g.classList.add('flash');
      hlMask = -2;
    }

    function stamp(text, x, y, cls) {
      const s = document.createElement('div');
      s.className = 'stamp ' + (cls || '');
      s.style.left = x + 'px'; s.style.top = y + 'px';
      s.textContent = text;
      q('.fx').appendChild(s);
      setTimeout(() => s.remove(), 3200);
    }
    function confetti(x, y) {
      const colors = TOOLS.map(t => t.color).concat('#13294b', '#e9b949');
      for (let i = 0; i < 90; i++) {
        const c = document.createElement('i');
        c.className = 'conf';
        const a = Math.random() * Math.PI * 2, d = 160 + Math.random() * 420;
        c.style.left = x + 'px'; c.style.top = y + 'px';
        c.style.background = colors[i % colors.length];
        c.style.setProperty('--dx', Math.cos(a) * d + 'px');
        c.style.setProperty('--dy', Math.sin(a) * d - 120 + 'px');
        c.style.setProperty('--r', (Math.random() * 900 - 450) + 'deg');
        c.style.animationDelay = Math.random() * 120 + 'ms';
        q('.fx').appendChild(c);
        setTimeout(() => c.remove(), 2200);
      }
    }

    function render(S) {
      layout(S.safe, S.toolNames);
      el.classList.toggle('clear', S.bg === 'clear');
      el.classList.toggle('off', !S.show);
      el.style.setProperty('--chip', S.chipScale || 1);
      q('.plate .sub').textContent = S.subtitle || `${DB.year}–${(DB.year + 1) % 100} OFFSEASON`;
      const T = S.T || 55, board = S.board || [], on = {};

      // chips
      for (const [id, u, v, by] of board) {
        const p = DB.players[id];
        if (!p) continue;
        on[id] = 1;
        let c = chipEls[id];
        const [x, y] = toPx(u, v);
        if (!c) {
          c = chipEls[id] = document.createElement('div');
          c.className = 'chip enter';
          c.dataset.id = id;
          c.innerHTML = chipHTML(p);
          c.style.left = x + 'px'; c.style.top = y + 'px';
          q('.chips').appendChild(c);
          setTimeout(() => c.classList.remove('enter'), 900);
        }
        c.style.left = x + 'px'; c.style.top = y + 'px';
        c.classList.toggle('byA', by === 'a'); c.classList.toggle('byB', by === 'b');
        c.classList.toggle('five', maskAt(u, v) === 31);
        c.classList.toggle('spot', S.spot === id && S.spotOn);
        c.classList.toggle('sel', S.sel === id);
        const checked = (S.checks || []).includes(id), agree = checked && savantMask(p, T) === maskAt(u, v);
        c.classList.toggle('agree', agree);
        c.querySelector('.badge').textContent = agree ? '✓' : '';
      }
      for (const id of Object.keys(chipEls)) if (!on[id]) {
        const c = chipEls[id]; delete chipEls[id];
        c.classList.add('leave'); setTimeout(() => c.remove(), 400);
      }

      // Savant ghosts: where the data would have put him
      const ghosts = [], seen = {};
      for (const id of S.checks || []) {
        const b = board.find(r => r[0] === id), p = DB.players[id];
        if (!b || !p || !p.tools) continue;
        const sm = savantMask(p, T);
        if (sm === maskAt(b[1], b[2])) continue;
        const n = seen[sm] = (seen[sm] || 0) + 1, [pu, pv, pr] = POLES[sm] || [0.62, 0.62, .2];
        // fan out repeat ghosts around the region's deepest point
        const ang = n * 2.4, rad = n === 1 ? 0 : Math.min(pr * .8, .05 * Math.sqrt(n));
        const to = sm === 0 ? [LAY.safe.l + 250 + ((n - 1) % 3) * 100, LAY.safe.b - 60 - Math.floor((n - 1) / 3) * 110]
          : toPx(pu + Math.cos(ang) * rad, pv + Math.sin(ang) * rad);
        ghosts.push({ id, p, sm, from: toPx(b[1], b[2]), to });
      }
      const gOn = {};
      for (const g of ghosts) {
        gOn[g.id] = 1;
        let e = ghostEls[g.id];
        if (!e) {
          e = ghostEls[g.id] = document.createElement('div');
          e.className = 'ghost';
          e.innerHTML = `<div class="ph"><img src="${headshot(g.id, 180)}" alt=""></div><div class="nm">SAVANT</div>`;
          q('.ghosts').appendChild(e);
        }
        e.style.left = g.to[0] + 'px'; e.style.top = g.to[1] + 'px';
      }
      for (const id of Object.keys(ghostEls)) if (!gOn[id]) { ghostEls[id].remove(); delete ghostEls[id]; }
      q('.lk').innerHTML = ghosts.map(g => {
        const [x1, y1] = g.from, [x2, y2] = g.to, L = Math.hypot(x2 - x1, y2 - y1) || 1, r = 50 * (S.chipScale || 1);
        if (L < r * 2) return '';
        const ax = x1 + (x2 - x1) * r / L, ay = y1 + (y2 - y1) * r / L, bx = x2 - (x2 - x1) * r / L, by = y2 - (y2 - y1) * r / L;
        return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" marker-end="url(#arr)"/>`;
      }).join('');

      // side panel: spotlight card, or the running tally
      const spotP = S.spotOn && S.spot && DB.players[S.spot];
      el.classList.toggle('carding', !!spotP);
      el.classList.toggle('shedding', !spotP && !!S.shedOn);
      if (spotP) {
        const key = JSON.stringify([S.spot, board.find(r => r[0] === S.spot), (S.checks || []).includes(S.spot), T, S.names]);
        if (key !== lastSpot) {
          const fresh = !lastSpot || JSON.parse(lastSpot)[0] !== S.spot;
          lastSpot = key;
          const cd = q('.card');
          cd.innerHTML = cardHTML(spotP, S);
          if (fresh) { cd.classList.remove('in'); void cd.offsetWidth; cd.classList.add('in'); }
        }
      } else lastSpot = null;
      const shedKey = JSON.stringify([board.map(b => [b[0], maskAt(b[1], b[2]), b[3], !!DB.players[b[0]]]), S.names]);
      if (shedKey !== lastShedKey) { lastShedKey = shedKey; q('.shed').innerHTML = shedHTML(board, S); }

      // one-shot effects
      if (S.fx && S.fx.n > lastFx) {
        const fresh = lastFx !== 0;
        lastFx = S.fx.n;
        if (fresh) {
          const b = board.find(r => r[0] === S.fx.id), [x, y] = b ? toPx(b[1], b[2]) : toPx(0, 0);
          if (S.fx.type === 'five') { confetti(x, y); stamp('FIVE-TOOL!', LAY.CX, LAY.CY - 40, 'red'); flashRegion(31); }
          else if (S.fx.type === 'guy') stamp('JUST A GUY', x, y - 30, 'grey');
          else if (S.fx.type === 'agree') stamp('SAVANT AGREES', x, y - 70, 'green');
          else if (S.fx.type === 'overrule') stamp('OVERRULED', x, y - 70, 'red');
          else if (S.fx.type === 'land' && b) flashRegion(maskAt(b[1], b[2]));
        }
      }
    }

    function shedHTML(board, S) {
      const groups = [[], [], [], [], [], []];
      for (const [id, u, v, by] of board) { const p = DB.players[id]; if (p) groups[countOf(maskAt(u, v))].push({ p, by }); }
      let h = `<div class="shed-h"><b>THE TOOL SHED</b><span>${board.length} FREE AGENT${board.length === 1 ? '' : 'S'} SORTED</span></div><div class="shed-body">`;
      for (let n = 5; n >= 0; n--) {
        if (!groups[n].length) continue;
        h += `<div class="tier t${n}"><div class="tier-h">${COUNT_NAME[n]}</div><div class="tier-list">` +
          groups[n].map(({ p, by }) => `<span class="pill ${by ? 'by' + by.toUpperCase() : ''}"><img src="${headshot(p.id, 90)}" alt="">${esc(p.last)}</span>`).join('') + `</div></div>`;
      }
      if (!board.length) h += `<div class="shed-empty">Nobody's on the board yet</div>`;
      return h + '</div>';
    }

    // expose for the control page
    return { el, render, highlight, chipEls, stage: el, board: q('.board') };
  }

  function cardHTML(p, S) {
    const T = S.T || 55, b = (S.board || []).find(r => r[0] === p.id);
    const hm = b ? maskAt(b[1], b[2]) : null, checked = (S.checks || []).includes(p.id), sm = savantMask(p, T);
    const tools = p.tools;
    const rows = TOOLS.map((t, k) => {
      const tl = tools && tools[t.key], pct = tl?.pct, g = tl?.grade;
      const inHost = hm != null && (hm & (1 << k)), inSav = sm & (1 << k);
      const detail = tl ? tl.parts.filter(x => x.pct != null || x.val).map(x => `${x.label} <b>${x.val ?? x.pct + 'th'}</b>`).join(' · ') : '';
      return `<div class="tool ${inHost ? 'host' : ''} ${checked ? (inSav ? 'sav' : 'nosav') : ''}" style="--c:${t.color}">
        <div class="tname"${t.name.length > 7 ? ` style="font-size:${Math.max(17, Math.round(28 * 7 / t.name.length))}px"` : ''}><i></i>${t.name}</div>
        <div class="grade">${g ?? '—'}</div>
        <div class="bar">${pct == null ? '<div class="na">NO SAVANT DATA</div>' :
          `<div class="track"><div class="fill" style="width:${pct}%;background:${pctColor(pct)}"></div><div class="bub" style="left:${pct}%;background:${pctColor(pct)}">${pct}</div></div>`}
          <div class="det">${detail}</div></div>
      </div>`;
    }).join('');
    const s = p.season, c = p.career, y = DB.year;
    const line = (lab, st, war) => st ? `<tr><th>${lab}</th><td>${st.g ?? '—'}</td><td>${st.avg}</td><td>${st.obp}</td><td>${st.slg}</td><td>${st.hr}</td><td>${st.sb}</td><td>${war ?? '—'}</td></tr>`
      : `<tr><th>${lab}</th><td colspan="7" class="dim">did not play</td></tr>`;
    let verdict = '';
    if (b) {
      verdict = `<div class="verdict"><div class="vh"><span>HOSTS SAY</span><b>${COUNT_NAME[countOf(hm)]}</b></div>`;
      if (checked) {
        const agree = sm === hm;
        verdict += `<div class="vs ${agree ? 'agree' : 'disagree'}"><span>SAVANT SAYS</span><b>${COUNT_NAME[countOf(sm)]}</b><em>${agree ? 'AGREES' : 'OVERRULED'}</em></div>`;
      }
      verdict += '</div>';
    }
    return `
      <div class="c-left" style="--tc:${p.team.color}">
        <div class="c-photo"><img src="${headshot(p.id, 426)}" alt=""></div>
        <div class="c-tag">${p.fa ? 'FREE AGENT' : 'ON THE MARKET'}${p.team.id ? `<span><img src="${logo(p.team.id)}" alt="">LAST: ${p.team.abbr}</span>` : ''}</div>
      </div>
      <div class="c-right">
        <div class="c-head">
          <div class="c-id"><div class="c-name">${esc(p.first)} <b>${esc(p.last)}</b></div>
            <div class="c-meta">${p.pos} <i>|</i> AGE ${p.age ?? '—'} <i>|</i> B/T ${p.bats || '?'}/${p.throws || '?'}</div></div>
          ${verdict}
        </div>
        <div class="tools-h"><span>TOOL</span><span>GRADE</span><span>BASEBALL SAVANT PERCENTILE · ${p.savYear}${p.savYear !== y ? ' (LIMITED ' + y + ' SAMPLE)' : ''}</span></div>
        <div class="tools">${rows}</div>
        <table class="stats"><thead><tr><th></th><th>G</th><th>AVG</th><th>OBP</th><th>SLG</th><th>HR</th><th>SB</th><th>WAR</th></tr></thead>
          <tbody>${line(String(y), s, p.war)}${line('CAREER', c, null)}</tbody></table>
      </div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  //  TRANSPORT
  // ════════════════════════════════════════════════════════════════════
  function hubOf(params) { return (params.get('hub') || HUB_DEFAULT).replace(/\/$/, ''); }
  function publisher(hub, getRoom, onStatus) {
    let bc = null, bcRoom = null, inflight = 0;
    return async payload => {
      const room = getRoom();
      if (bcRoom !== room) { try { bc && bc.close(); bc = new BroadcastChannel('ftfa-' + room); bcRoom = room; } catch { bc = null; } }
      try { bc && bc.postMessage(payload); } catch {}
      const my = ++inflight;
      onStatus('sending…', '');
      try {
        const r = await fetch(`${hub}/r/${encodeURIComponent(room)}`, { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => ({}));
        if (my !== inflight) return;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        onStatus(`sent · ${j.sent ?? 0} screen${j.sent === 1 ? '' : 's'} connected`, 'ok');
      } catch {
        if (my === inflight) onStatus('relay unreachable — OBS will not update', 'bad');
      }
    };
  }
  function subscribe(hub, room, apply) {
    try { new BroadcastChannel('ftfa-' + room).onmessage = e => apply(e.data); } catch {}
    const url = `${hub}/r/${encodeURIComponent(room)}`;
    let backoff = 2000;
    const open = () => {
      try {
        const ws = new WebSocket(url.replace(/^http/, 'ws'));
        ws.onopen = () => { backoff = 2000; };
        ws.onmessage = ev => { try { apply(JSON.parse(ev.data)); } catch {} };
        ws.onclose = () => { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); };
      } catch { setTimeout(open, backoff); }
    };
    open();
    // slow safety net for networks that eat the WebSocket upgrade; seq makes repeats harmless
    const poll = async () => {
      try {
        const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        const t = await r.text();
        if (t && t !== 'null') apply(JSON.parse(t));
      } catch {}
    };
    poll();
    setInterval(poll, 30000);
  }

  return { TOOLS, TOOL_DEFAULT, setToolNames, COUNT_NAME, LAY, SAFE_DEFAULT, CAMS, POLES, DB, maskAt, bits, countOf, regionName, toPx, toUV, savantMask, headshot, logo,
    load, ensure, search, createStage, cardHTML, pctColor, esc, hubOf, publisher, subscribe };
})();
