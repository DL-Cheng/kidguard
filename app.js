/* 抱抱守護星 Web App
 * MQTT topic（裝置 ID = {id}）：
 *   kidguard/{id}/state   裝置 → 每 2 秒狀態
 *   kidguard/{id}/alert   裝置 → 事件（sos / far / lost / heat / back / clear ...）
 *   kidguard/{id}/status  裝置 → online / offline（保留訊息，offline 為遺囑）
 *   kidguard/{id}/info    裝置 → 韌體版本與目前門檻（保留訊息）
 *   kidguard/{id}/config  網頁 → 裝置門檻（保留訊息）
 *   kidguard/{id}/cmd     網頁 → 指令 locate / silence / clear / night
 *   kidguard/{id}/ack     網頁 ↔ 網頁：誰正在處理警報（多人協作）
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
  const STALE_MS = 15000;

  // ---------- 本機設定 ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hug.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hug.' + k, JSON.stringify(v)); } catch { /* 無痕模式 */ } }
  };
  const S = {
    dev: store.get('dev', ''),
    name: store.get('name', ''),
    broker: store.get('broker', DEFAULT_BROKER),
    user: store.get('user', ''),
    pass: store.get('pass', ''),
    sound: store.get('sound', true),
    vibe: store.get('vibe', true),
    demo: store.get('demo', false)
  };

  // ---------- 執行狀態 ----------
  const R = {
    client: null, cloud: false,
    online: null,          // 裝置是否在線（null = 未知）
    wasOnline: false,
    data: null, lastAt: 0,
    cfg: { rssiTh: -75, lostSec: 8, tempTh: 35, tempHold: 30, buzzer: true },
    offlineAlerted: false,
    handling: null,
    ringing: null,         // 目前手機響鈴的警報類型
    lastMode: 'ok'
  };

  const TYPE = {
    sos:        { title: 'SOS 求救', cls: 'sos',    alarm: true },
    far:        { title: '離距警報', cls: 'far',    alarm: true },
    lost:       { title: '裝置斷線', cls: 'lost',   alarm: true },
    offline:    { title: '裝置離線', cls: 'lost',   alarm: true },
    heat:       { title: '高溫警示', cls: 'heat',   alarm: true },
    back:       { title: '重新連線', cls: 'ok' },
    far_clear:  { title: '回到安全範圍', cls: 'ok' },
    heat_clear: { title: '溫度回落', cls: 'ok' },
    clear:      { title: '警報解除', cls: 'ok' },
    locate:     { title: '啟動找孩子', cls: 'locate' },
    silence:    { title: '現場靜音', cls: '' },
    boot:       { title: '裝置開機', cls: '' },
    ack:        { title: '處理中', cls: '' },
    online:     { title: '裝置上線', cls: 'ok' }
  };

  // ---------- 圖示 ----------
  const ICON = {
    ok: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .6-4.5 4 1.3 6-5.4-3.2-5.4 3.2 1.3-6-4.5-4 6-.6z"/></svg>',
    far: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 3 3M11 15l-1-5"/></svg>',
    sos: '<svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 1 7 7v5l2 3H3l2-3v-5a7 7 0 0 1 7-7z"/><path d="M10 21h4"/></svg>',
    heat: '<svg viewBox="0 0 24 24"><path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/></svg>',
    lost: '<svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><path d="M3 3l18 18"/></svg>',
    locate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    idle: '<svg viewBox="0 0 24 24"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/></svg>'
  };

  // ---------- 小工具 ----------
  const topic = s => `kidguard/${S.dev}/${s}`;
  const fmtTime = t => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });
  let toastTimer;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
  const who = () => S.name || '家長';

  // ---------- 事件紀錄 ----------
  let logs = [];
  const logKey = () => 'log.' + (S.demo ? '_demo' : S.dev);
  function loadLogs() { logs = store.get(logKey(), []); renderLogs(); }
  function addLog(type, msg) {
    logs.unshift({ type, msg: msg || '', at: Date.now() });
    logs = logs.slice(0, 60);
    store.set(logKey(), logs);
    renderLogs();
  }
  function renderLogs() {
    const ul = $('log');
    if (!logs.length) { ul.innerHTML = '<li class="empty">目前沒有事件</li>'; return; }
    ul.innerHTML = logs.map(l => {
      const t = TYPE[l.type] || { title: l.type, cls: '' };
      return `<li><span class="dot ${t.cls}"></span><div>${t.title}<small>${escapeHtml(l.msg)}</small></div><time>${fmtTime(l.at)}</time></li>`;
    }).join('');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- 手機警示：聲音 / 震動 / 通知 ----------
  let actx = null, sirenTimer = null;
  function unlockAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const o = actx.createOscillator(), g = actx.createGain();
      g.gain.value = 0.0001; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.05);
    } catch { /* 不支援 */ }
  }
  function tone(freq, dur, when = 0) {
    if (!actx) return;
    const t0 = actx.currentTime + when;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const PATTERN = {
    sos:     { every: 900,  play: () => { tone(1400, .18); tone(1000, .18, .22); tone(1400, .18, .44); tone(1000, .18, .66); }, vib: [300, 100, 300, 100, 300] },
    far:     { every: 1600, play: () => { tone(880, .35); tone(660, .35, .45); }, vib: [500, 200, 500] },
    lost:    { every: 1600, play: () => { tone(880, .35); tone(660, .35, .45); }, vib: [500, 200, 500] },
    offline: { every: 1600, play: () => { tone(880, .35); tone(660, .35, .45); }, vib: [500, 200, 500] },
    heat:    { every: 3000, play: () => { tone(1200, .12); tone(1200, .12, .2); }, vib: [200, 100, 200] }
  };
  function startRing(type) {
    stopRing();
    const p = PATTERN[type]; if (!p) return;
    R.ringing = type;
    const fire = () => {
      if (S.sound) p.play();
      if (S.vibe && navigator.vibrate) navigator.vibrate(p.vib);
    };
    fire(); sirenTimer = setInterval(fire, p.every);
  }
  function stopRing() {
    clearInterval(sirenTimer); sirenTimer = null; R.ringing = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  async function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opt = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'hugstar-' + S.dev, renotify: true, requireInteraction: true, vibrate: [300, 100, 300] };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification(title, opt); else new Notification(title, opt);
    } catch { /* 部分瀏覽器限制 */ }
  }

  function raise(type, msg) {
    const t = TYPE[type]; if (!t) return;
    addLog(type, msg);
    if (t.alarm) {
      R.handling = null;
      startRing(type);
      notify(`抱抱守護星｜${t.title}`, msg || '');
    } else if (['clear', 'far_clear', 'heat_clear', 'back', 'online'].includes(type)) {
      // 警報結束時停止響鈴（若仍有其他警報會由 render 重新判斷）
      stopRing();
    }
    render();
  }

  // ---------- MQTT ----------
  function connect() {
    if (R.client) { try { R.client.end(true); } catch {} R.client = null; }
    R.cloud = false; R.online = null; R.wasOnline = false; R.data = null; R.lastAt = 0; R.offlineAlerted = false;
    stopRing();
    if (S.demo) { startDemo(); render(); return; }
    stopDemo();
    if (!S.dev) { render(); return; }
    if (typeof mqtt === 'undefined') { toast('MQTT 函式庫載入失敗'); return; }

    const opts = {
      clientId: 'hugweb_' + Math.random().toString(16).slice(2, 10),
      keepalive: 30, reconnectPeriod: 3000, connectTimeout: 10000, clean: true
    };
    if (S.user) { opts.username = S.user; opts.password = S.pass; }
    const c = mqtt.connect(S.broker || DEFAULT_BROKER, opts);
    R.client = c;
    c.on('connect', () => {
      R.cloud = true;
      c.subscribe(topic('#'), { qos: 1 });
      render();
    });
    c.on('reconnect', () => { R.cloud = false; render(); });
    c.on('close', () => { R.cloud = false; render(); });
    c.on('error', e => console.warn('MQTT', e));
    c.on('message', (t, buf, pkt) => onMessage(t.split('/').pop(), buf.toString(), pkt && pkt.retain));
  }

  function publish(sub, obj, retain = false) {
    if (S.demo) { demoCommand(sub, obj); return true; }
    if (!R.client || !R.cloud) { toast('尚未連上雲端'); return false; }
    R.client.publish(topic(sub), JSON.stringify(obj), { qos: 1, retain });
    return true;
  }

  function onMessage(sub, text, retained) {
    let d = null;
    try { d = JSON.parse(text); } catch { /* 純文字 */ }
    switch (sub) {
      case 'state':
        R.data = d; R.lastAt = Date.now();
        if (R.online !== true) setOnline(true, false);
        break;
      case 'status':
        setOnline(text === 'online', retained);
        break;
      case 'alert':
        if (d && d.type) raise(d.type, d.msg);
        break;
      case 'info':
        if (d && d.cfg) { R.cfg = { ...R.cfg, ...d.cfg }; fillCfgForm(); }
        break;
      case 'ack':
        if (d) {
          R.handling = d;
          if (d.cid !== CID) { addLog('ack', `${d.by} 正在處理`); toast(`${d.by} 正在處理`); }
        }
        break;
    }
    render();
  }

  function setOnline(on, retained) {
    const prev = R.online;
    R.online = on;
    if (on) {
      R.wasOnline = true;
      if (R.offlineAlerted) { R.offlineAlerted = false; raise('online', '裝置恢復連線'); }
    } else if (!retained && prev === true && !R.offlineAlerted) {
      R.offlineAlerted = true;
      raise('offline', '裝置失去連線，孩子可能已離開手機熱點範圍，或裝置電源中斷');
    }
  }

  // 心跳逾時：遺囑訊息約 15 秒才會送出，這裡同步檢查
  setInterval(() => {
    if (!S.demo && R.online === true && R.lastAt && Date.now() - R.lastAt > STALE_MS) {
      setOnline(false, false);
    }
    renderAgo();
  }, 1000);

  // ---------- 畫面 ----------
  function currentMode() {
    if (!S.dev && !S.demo) return 'idle';
    if (!R.cloud && !S.demo) return 'idle';
    if (R.online === false) return R.wasOnline ? 'offline' : 'idle';
    if (!R.data) return 'idle';
    return R.data.mode || 'ok';
  }

  function render() {
    const mode = currentMode();
    const d = R.data || {};
    const hero = $('hero');
    hero.dataset.mode = mode;

    const TXT = {
      ok:      ['安全陪伴中', `訊號良好，孩子在安全範圍內`],
      far:     ['離距警報', '訊號低於門檻，孩子可能走遠了，請循聲光尋找'],
      lost:    ['裝置斷線', '裝置與熱點中斷，現場聲光已啟動'],
      offline: ['裝置離線', '可能已離開熱點範圍或電源中斷，請立即確認'],
      sos:     ['SOS 求救', '孩子按下求救按鈕，現場燈光爆閃中'],
      heat:    ['高溫警示', `環境溫度 ${d.t ?? '—'}°C，請盡快移到陰涼處`],
      locate:  ['正在找孩子', '裝置聲光指引中，請循聲尋找'],
      idle:    !S.dev && !S.demo ? ['尚未設定', '請先在下方「設定」輸入裝置 ID']
             : !R.cloud && !S.demo ? ['雲端連線中…', '正在連線 MQTT 伺服器']
             : ['等待裝置', '裝置尚未上線，請開啟手機熱點與裝置電源']
    };
    const [title, sub] = TXT[mode] || TXT.ok;
    $('heroTitle').textContent = title;
    $('heroSub').textContent = sub;
    const iconKey = mode === 'offline' ? 'lost' : (ICON[mode] ? mode : 'idle');
    $('heroIcon').innerHTML = ICON[iconKey];

    const alerting = ['far', 'lost', 'offline', 'sos', 'heat'].includes(mode);
    $('heroActions').hidden = !alerting;
    const h = $('handling');
    if (alerting && R.handling) { h.hidden = false; h.textContent = `${R.handling.by} 正在處理（${fmtTime(R.handling.at)}）`; }
    else h.hidden = true;

    // 狀態轉為正常時停止響鈴；網頁重新整理後若裝置仍在警報中則補響
    if (!alerting && R.ringing) stopRing();
    if (alerting && !R.ringing && R.lastMode !== mode && !R.handling) startRing(mode === 'locate' ? null : mode);
    R.lastMode = mode;

    // 頂部
    $('devLabel').textContent = S.demo ? '裝置：示範模式' : `裝置：${S.dev || '未設定'}`;
    setPill('pillCloud', S.demo ? true : R.cloud);
    setPill('pillDev', R.online === null ? null : R.online);

    // 訊號
    const rssi = d.rssi;
    const th = R.cfg.rssiTh;
    const live = R.online && typeof rssi === 'number';
    $('rssi').textContent = live ? rssi : '—';
    const lvl = live ? Math.max(0, Math.min(5, Math.round((rssi + 95) / 9))) : 0;
    const bars = $('bars');
    [...bars.children].forEach((b, i) => b.classList.toggle('on', i < lvl));
    bars.classList.toggle('weak', live && rssi < th + 5);
    $('rssiFill').style.width = live ? pct(rssi) + '%' : '0%';
    $('rssiFill').style.background = live && rssi < th ? 'var(--far)' : '';
    $('rssiTh').style.left = pct(th) + '%';
    $('thCap').textContent = `門檻 ${th} dBm`;
    const dl = $('distLabel');
    dl.className = '';
    if (!live) dl.textContent = '—';
    else if (rssi >= th + 15) { dl.textContent = '很近'; dl.className = 'near'; }
    else if (rssi >= th + 5) { dl.textContent = '附近'; dl.className = 'near'; }
    else if (rssi >= th) { dl.textContent = '接近邊界'; dl.className = 'mid'; }
    else { dl.textContent = '超出範圍'; dl.className = 'far'; }

    // 溫濕度
    $('temp').textContent = live && d.t != null ? Number(d.t).toFixed(1) : '—';
    const ts = $('tempSub');
    ts.textContent = `門檻 ${R.cfg.tempTh}°C`;
    ts.classList.toggle('hot', live && d.t >= R.cfg.tempTh);
    $('humi').textContent = live && d.h != null ? d.h : '—';

    // 電池
    const bat = live && d.bat != null ? d.bat : null;
    $('bat').textContent = bat ?? '—';
    $('batFill').style.width = (bat ?? 0) + '%';
    $('batFill').classList.toggle('low', bat != null && bat < 20);

    // 夜燈
    const night = !!d.night;
    $('btnNight').setAttribute('aria-pressed', night);
    $('nightState').textContent = night ? '開啟中' : '關閉';

    const canCtl = S.demo || (R.cloud && R.online);
    ['btnLocate', 'btnNight', 'btnSilence', 'btnClear'].forEach(id => $(id).disabled = !canCtl);

    $('demoBar').hidden = !S.demo;
    renderAgo();
  }
  const pct = r => Math.max(0, Math.min(100, (r + 95) / 55 * 100));
  function setPill(id, v) {
    const el = $(id); el.classList.toggle('on', v === true); el.classList.toggle('off', v === false);
  }
  function renderAgo() {
    if (!R.lastAt) { $('ago').textContent = '—'; $('agoUnit').textContent = ''; $('upSub').textContent = '—'; return; }
    const s = Math.round((Date.now() - R.lastAt) / 1000);
    if (s < 60) { $('ago').textContent = s; $('agoUnit').textContent = '秒前'; }
    else { $('ago').textContent = Math.round(s / 60); $('agoUnit').textContent = '分前'; }
    const up = R.data && R.data.up;
    $('upSub').textContent = up != null ? `裝置已運作 ${Math.floor(up / 60)} 分` : '';
  }

  // ---------- 設定表單 ----------
  function fillCfgForm() {
    const c = R.cfg;
    $('inRssi').value = c.rssiTh; $('inLost').value = c.lostSec;
    $('inTemp').value = c.tempTh; $('inHold').value = c.tempHold;
    $('inBuzzer').checked = !!c.buzzer;
    updateRangeLabels();
  }
  function updateRangeLabels() {
    $('vRssi').textContent = $('inRssi').value + ' dBm';
    $('vLost').textContent = $('inLost').value + ' 秒';
    $('vTemp').textContent = $('inTemp').value + '°C';
    $('vHold').textContent = $('inHold').value + ' 秒';
  }
  function fillForm() {
    $('inDev').value = S.dev; $('inName').value = S.name;
    $('inBroker').value = S.broker === DEFAULT_BROKER ? '' : S.broker;
    $('inUser').value = S.user; $('inPass').value = S.pass;
    $('inSound').checked = S.sound; $('inVibe').checked = S.vibe; $('inDemo').checked = S.demo;
    fillCfgForm();
  }

  // ---------- 按鈕 ----------
  const CID = Math.random().toString(36).slice(2, 8);
  function ack() {
    stopRing();
    const info = { by: who(), at: Date.now(), cid: CID, mode: currentMode() };
    R.handling = info;
    if (!S.demo && R.client && R.cloud) R.client.publish(topic('ack'), JSON.stringify(info), { qos: 1 });
    addLog('ack', `${who()} 正在處理`);
    render();
  }
  function clearAlarm() {
    stopRing();
    publish('cmd', { cmd: 'clear', by: who() });
    R.offlineAlerted = false;
    R.handling = null;
    toast('已送出解除警報');
  }

  $('btnStart').onclick = async () => {
    unlockAudio();
    $('gate').hidden = true;
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
    if (!S.dev && !S.demo) $('settings').open = true;
  };
  $('btnAck').onclick = ack;
  $('btnClear').onclick = clearAlarm;
  $('btnClear2').onclick = clearAlarm;
  $('btnLocate').onclick = () => { if (publish('cmd', { cmd: 'locate', by: who() })) toast('裝置聲光指引 30 秒'); };
  $('btnSilence').onclick = () => { stopRing(); if (publish('cmd', { cmd: 'silence', by: who() })) toast('已靜音裝置蜂鳴器'); };
  $('btnNight').onclick = () => {
    const on = !(R.data && R.data.night);
    if (publish('cmd', { cmd: 'night', on, by: who() })) {
      if (R.data) R.data.night = on;
      render();
    }
  };
  $('btnLogClear').onclick = () => { logs = []; store.set(logKey(), logs); renderLogs(); };

  ['inRssi', 'inLost', 'inTemp', 'inHold'].forEach(id => $(id).addEventListener('input', updateRangeLabels));
  $('btnSendCfg').onclick = () => {
    const cfg = {
      rssiTh: +$('inRssi').value, lostSec: +$('inLost').value,
      tempTh: +$('inTemp').value, tempHold: +$('inHold').value,
      buzzer: $('inBuzzer').checked
    };
    if (publish('config', cfg, true)) { R.cfg = { ...R.cfg, ...cfg }; render(); toast('門檻已傳送到裝置'); }
  };

  $('btnConnect').onclick = () => {
    const dev = $('inDev').value.trim().replace(/[^\w-]/g, '');
    S.dev = dev; S.name = $('inName').value.trim();
    S.broker = $('inBroker').value.trim() || DEFAULT_BROKER;
    S.user = $('inUser').value.trim(); S.pass = $('inPass').value;
    ['dev', 'name', 'broker', 'user', 'pass'].forEach(k => store.set(k, S[k]));
    $('inDev').value = dev;
    loadLogs(); connect();
    toast(dev ? `連線到 ${dev}` : '請輸入裝置 ID');
  };
  $('inSound').onchange = e => { S.sound = e.target.checked; store.set('sound', S.sound); };
  $('inVibe').onchange = e => { S.vibe = e.target.checked; store.set('vibe', S.vibe); };
  $('inDemo').onchange = e => { S.demo = e.target.checked; store.set('demo', S.demo); loadLogs(); connect(); };
  $('btnNotify').onclick = async () => {
    if (!('Notification' in window)) { toast('此瀏覽器不支援通知，請加入主畫面後再試'); return; }
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? '已開啟系統通知' : '通知權限未開啟');
  };
  $('btnTest').onclick = () => {
    unlockAudio();
    startRing('sos'); notify('抱抱守護星｜測試', '這是測試警示');
    setTimeout(stopRing, 3000);
  };

  // ---------- 示範模式 ----------
  let demoTimer = null;
  const demo = { rssi: -58, t: 29.5, h: 62, bat: 86, mode: 'ok', night: false, up: 600 };
  function startDemo() {
    stopDemo();
    R.online = true; R.wasOnline = true;
    const tick = () => {
      if (demo.mode === 'lost') { R.lastAt = R.lastAt || Date.now(); render(); return; }
      const target = demo.mode === 'far' ? -82 : -60;
      demo.rssi += (target - demo.rssi) * 0.3 + (Math.random() - .5) * 3;
      const tTarget = demo.mode === 'heat' ? 37.5 : 29.5;
      demo.t += (tTarget - demo.t) * 0.3 + (Math.random() - .5) * .2;
      demo.up += 2;
      R.data = {
        mode: demo.mode, rssi: Math.round(demo.rssi), t: Math.round(demo.t * 10) / 10, h: demo.h,
        bat: demo.bat, night: demo.night, up: demo.up,
        sos: demo.mode === 'sos', far: demo.mode === 'far', heat: demo.mode === 'heat'
      };
      R.lastAt = Date.now();
      render();
    };
    tick(); demoTimer = setInterval(tick, 2000);
  }
  function stopDemo() { clearInterval(demoTimer); demoTimer = null; }
  function demoSet(mode) {
    const prev = demo.mode;
    demo.mode = mode;
    if (mode === 'lost') { R.online = false; raise('offline', '（示範）裝置失去連線'); return; }
    R.online = true;
    if (prev === 'lost') raise('online', '（示範）裝置恢復連線');
    const MSG = { far: '訊號低於門檻，孩子可能走遠了', sos: '孩子按下求救按鈕', heat: '環境溫度 37.5°C 超過門檻' };
    if (MSG[mode]) raise(mode, '（示範）' + MSG[mode]);
    else if (prev !== 'ok') raise('clear', '（示範）恢復正常');
    startDemo();
  }
  function demoCommand(sub, obj) {
    if (sub === 'config') return;
    if (obj.cmd === 'clear') demoSet('ok');
    if (obj.cmd === 'locate') { demo.mode = 'locate'; addLog('locate', obj.by); startDemo(); setTimeout(() => { if (demo.mode === 'locate') { demo.mode = 'ok'; startDemo(); } }, 30000); }
    if (obj.cmd === 'night') demo.night = obj.on;
    if (obj.cmd === 'silence') addLog('silence', obj.by);
  }
  document.querySelectorAll('[data-demo]').forEach(b => b.onclick = () => { unlockAudio(); demoSet(b.dataset.demo); });

  // ---------- 啟動 ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  fillForm();
  loadLogs();
  connect();
  render();
})();
