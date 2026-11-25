(function () {
  'use strict';
  const $ = id => document.getElementById(id), C = Core;
  let state = 'INIT', dir = null, store = null, view = 'today', saving = false;
  let editCid = null, editSid = null;
  const expanded = new Set();

  /* ===== 핸들 보관 (이 웹 출처 전용 IndexedDB) ===== */
  const IDB_NAME = 'consult-pwa-v1', IDB_STORE = 'handles', IDB_KEY = 'dataDir';
  function openIDB() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('IndexedDB 미지원'));
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idb(mode, fn) {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, mode), req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error);
    });
  }

  /* ===== 상태/표시 ===== */
  function setState(s, msg) { state = s; updateUI(); if (msg) $('status').textContent = msg; }
  function setMsg(text, type) { const el = $('formMsg'); el.textContent = text || ''; el.className = 'form-msg' + (type ? ' ' + type : ''); }
  const D = () => store ? store.data : C.emptyData();
  function updateUI() {
    const ok = state === 'CONNECTED', perm = state === 'PERMISSION_NEEDED', err = state === 'ERROR';
    $('btnPermission').classList.toggle('hidden', !perm);
    $('btnConnect').classList.toggle('hidden', perm);
    $('btnConnect').textContent = (ok || err) ? '🔄 폴더 변경' : '📁 데이터 폴더 연결';
    $('btnAdd').disabled = !ok || saving;
    $('btnBackup').disabled = !ok;
    $('btnRestore').disabled = !(ok || err);
    const b = $('connBanner');
    b.classList.toggle('hidden', ok);
    b.classList.toggle('error', err);
    if (state === 'NOT_CONNECTED') b.textContent = '상담 자료를 보관할 PC 폴더를 연결하면 안전하게 상담을 기록하고 저장할 수 있습니다.';
    else if (perm) b.textContent = '🔓 폴더 접근 권한이 필요합니다. "권한 승인"을 눌러주세요.';
    else if (err) b.textContent = '⚠ 상담 자료를 불러오지 못했습니다. 기존 상담 파일은 안전하게 보존되어 있습니다. 보관 중인 백업 파일이 있으면 "자료 복원"으로 복구할 수 있습니다.';
    else if (!ok) b.textContent = '초기화 중...';
    $('dot').className = 'dot ' + (ok ? 'ok' : perm ? 'warn' : 'err');
    $('btnSetMonths').disabled = !ok || saving;
    renderDashboard();
  }

  /* ===== 초기화/폴더 ===== */
  const BASIS_LABELS = {
    '정보주체 동의': '정보주체 동의 (보호자 직접 동의)',
    '계약 체결을 위한 조치': '계약 체결 및 이행 (입학·등록 상담)',
    '법령상 의무': '법령상 의무 준수 (법정 의무 보관)',
    '미확인': '미확인 (수집 근거 확인 필요)'
  };
  async function init() {
    $('fDate').value = C.localDate();
    fillSelect($('fStatus'), C.STATUSES); fillSelect($('eStatus'), C.STATUSES);
    fillSelect($('fBasis'), C.BASES.slice(0, 3), BASIS_LABELS); fillSelect($('eBasis'), C.BASES, BASIS_LABELS);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
    if (!window.showDirectoryPicker) return setState('NOT_CONNECTED', '⚠ 이 브라우저는 폴더 연결을 지원하지 않습니다. Edge 또는 Chrome을 사용하세요.');
    let stored = null;
    try { stored = await idb('readonly', s => s.get(IDB_KEY)); } catch (e) { console.warn('IDB 조회 실패:', e.message); }
    if (!stored) return setState('NOT_CONNECTED', '데이터 폴더를 연결하세요. (최초 1회)');
    dir = stored;
    let perm = 'prompt';
    try { perm = await dir.queryPermission({ mode: 'readwrite' }); }
    catch (e) { return setState('NOT_CONNECTED', '저장된 폴더 정보를 확인할 수 없습니다. 폴더를 다시 연결하세요.'); }
    if (perm === 'granted') await openAndLoad();
    else setState('PERMISSION_NEEDED', '이전 폴더 "' + dir.name + '"의 권한이 필요합니다. "권한 승인"을 눌러주세요.');
  }
  function fillSelect(sel, arr, labels) {
    sel.innerHTML = arr.map(v => '<option value="' + esc(v) + '">' + esc((labels && labels[v]) || v) + '</option>').join('');
  }

  async function pickFolder() {
    if (!window.showDirectoryPicker) return;
    try {
      const d = await window.showDirectoryPicker({ id: 'consult-pwa', startIn: 'desktop', mode: 'readwrite' });
      let hasData = false, others = 0;
      for await (const [n, h] of d.entries()) { if (n === 'counseling.json') hasData = true; else if (h.kind === 'file' && n.endsWith('.json')) others++; }
      if (!hasData && others && !confirm('선택한 폴더에 상담 자료가 아닌 다른 파일이 포함되어 있습니다. 상담 자료 전용 폴더 사용을 권장합니다. 그래도 이 폴더를 사용할까요?')) return;
      dir = d; store = null;
      try { await idb('readwrite', s => s.put(d, IDB_KEY)); } catch (e) { console.warn('IDB 저장 실패:', e.message); }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
      await openAndLoad();
    } catch (e) {
      if (e.name !== 'AbortError') $('status').textContent = '폴더 선택 오류: ' + e.message;
    }
  }

  async function openAndLoad() {
    if (!dir) return;
    try {
      if (await dir.queryPermission({ mode: 'readwrite' }) !== 'granted') return setState('PERMISSION_NEEDED', '폴더 접근 권한이 필요합니다. "권한 승인"을 눌러주세요.');
    } catch (e) { return setState('NOT_CONNECTED', '권한 확인 실패: ' + e.message); }
    store = new Store(dir);
    try {
      const r = await store.load(), n = store.data.counselors.length, m = store.data.sessions.length;
      let msg = '✅ 연결됨: ' + dir.name + (r.fresh ? ' (첫 저장 시 파일 생성)' : ' / 상담자 ' + n + '명·상담 ' + m + '건 로드');
      if (r.legacy) msg += ' · 이전 형식을 변환했습니다(첫 저장 시 원본을 backup 폴더에 보존). ' + r.warnings.join(' ');
      setState('CONNECTED', msg);
    } catch (e) {
      setState('ERROR', '⚠ 데이터를 불러오지 못했습니다: ' + e.message + ' — 기존 파일은 그대로 보존됩니다.');
    }
    render(); refreshCandidates();
  }

  /* ===== 저장 공통 ===== */
  async function doCommit(mut, opts, okMsg) {
    if (!store) return false;
    saving = true; updateUI();
    try {
      await store.commit(mut, opts);
      setMsg('✅ ' + okMsg + ' (' + new Date().toLocaleTimeString() + ')', 'ok');
      return true;
    } catch (e) {
      if (e.code === 'CONFLICT') {
        setMsg('❌ 다른 곳에서 파일이 변경되어 저장하지 않았습니다. 입력 내용은 보존됩니다.', 'err');
        if (confirm('데이터 파일이 다른 창/프로그램에서 변경되었습니다. 최신 파일을 다시 불러올까요? (현재 입력창 내용은 유지됩니다)')) await openAndLoad();
      } else if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
        setState('PERMISSION_NEEDED', '⚠ 권한이 만료되었습니다. "권한 승인"을 눌러주세요.');
        setMsg('❌ 권한 만료로 저장하지 않았습니다.', 'err');
      } else setMsg('❌ 저장 실패: ' + e.message + ' — 입력 내용은 보존됩니다.', 'err');
      return false;
    } finally { saving = false; updateUI(); render(); }
  }

  /* ===== 입력 검증/중복 후보 ===== */
  function readPhones(lines) {
    const out = [];
    for (const raw of lines.map(s => s.trim()).filter(Boolean)) {
      const p = C.phoneObj(out.length ? '추가' : '대표', raw);
      if (!C.validPhone(p.norm)) throw new Error('전화번호 형식 오류: ' + raw);
      if (!out.some(x => x.norm === p.norm)) out.push(p);
    }
    if (!out.length) throw new Error('전화번호는 필수입니다.');
    return out;
  }
  function consentOf(given, basis, prev) {
    if (basis === '정보주체 동의' && !given) throw new Error('"정보주체 동의"가 처리 근거이면 동의 체크가 필요합니다.');
    return { given, at: given ? (prev && prev.given ? prev.at : C.localDate()) : '', basis };
  }
  function refreshCandidates() {
    const name = $('fName').value, norms = [$('fPhone').value, $('fPhone2').value].map(C.normPhone).filter(C.validPhone);
    const cands = C.findCandidates(D().counselors, name, norms), sel = $('fExisting'), keep = sel.value;
    $('candBox').classList.toggle('hidden', !cands.length);
    if (!cands.length) { sel.innerHTML = ''; return; }
    const lbl = { strong: '이름·전화 동일', phone: '전화 동일', name: '이름 동일' };
    sel.innerHTML = '<option value="">-- 선택하세요 (필수) --</option><option value="__new">새 상담자로 등록 (형제·자매 등 별도 상담자)</option>' +
      cands.map(x => '<option value="' + esc(x.c.id) + '">기존 상담자에 이력 추가: ' + esc(x.c.name) + ' · ' + esc(x.c.phones.map(p => p.number).join(', ')) +
        ' · ' + esc(x.c.status) + ' · ' + lbl[x.level] + '</option>').join('');
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }

  /* ===== 등록 ===== */
  async function addRecord() {
    try {
      const name = $('fName').value.trim(), note = $('fNote').value.trim(), date = $('fDate').value, fu = $('fFollowUp').value;
      if (!name || !$('fPhone').value.trim() || !note) throw new Error('이름·전화번호·상담내용은 필수입니다.');
      if (!C.isDate(date)) throw new Error('상담 날짜가 올바르지 않습니다.');
      if (fu && (!C.isDate(fu) || fu < date)) throw new Error('후속 연락일은 상담일 이후여야 합니다.');
      const ret = $('fRetention').value || C.addMonths(date, C.retentionMonths(D()));
      if (!C.isDate(ret)) throw new Error('보관 기한이 올바르지 않습니다.');
      const phones = readPhones([$('fPhone').value, $('fPhone2').value]);
      const basis = $('fBasis').value, given = $('fConsent').checked;
      consentOf(given, basis);
      const cands = C.findCandidates(D().counselors, name, phones.map(p => p.norm)), sel = $('fExisting').value;
      if (cands.length && !sel) throw new Error('중복 후보가 있습니다. 기존 상담자 또는 "새 상담자"를 선택하세요.');
      if (sel === '__new' && cands.some(x => x.level === 'strong') && !confirm('이름과 전화번호가 모두 같은 상담자가 이미 있습니다. 정말 별도 상담자로 등록할까요?')) return;
      const status = $('fStatus').value, now = new Date().toISOString();
      const ok = await doCommit(d => {
        let c;
        if (sel && sel !== '__new') {
          c = d.counselors.find(x => x.id === sel);
          if (!c) throw new Error('선택한 상담자를 찾을 수 없습니다.');
          phones.forEach(p => { if (!c.phones.some(x => x.norm === p.norm)) c.phones.push({ ...p, label: '추가' }); });
          c.status = status; c.updatedAt = now;
          if (given && !c.consent.given) c.consent = consentOf(true, basis);
          if (ret > c.retentionUntil) c.retentionUntil = ret;
        } else {
          c = { id: C.makeId('p'), name, phones, status, consent: consentOf(given, basis), retentionUntil: ret, createdAt: now, updatedAt: now };
          d.counselors.push(c);
        }
        d.sessions.push({ id: C.makeId('s'), counselorId: c.id, date, note, followUp: fu, followDone: false, doneAt: '', createdAt: now, updatedAt: now });
        return d;
      }, {}, '상담 저장 완료');
      if (ok) { clearForm(); $('status').textContent = '💾 상담 자료 저장 완료'; }
    } catch (e) { setMsg('❌ ' + e.message, 'err'); }
  }
  function clearForm() {
    ['fName', 'fPhone', 'fPhone2', 'fNote', 'fFollowUp', 'fRetention'].forEach(id => $(id).value = '');
    $('fConsent').checked = false; $('fStatus').value = '신규'; $('fBasis').selectedIndex = 0; $('fDate').value = C.localDate();
    $('fExisting').value = ''; refreshCandidates();
  }

  /* ===== 수정/삭제/상태 ===== */
  function openEditC(id) {
    const c = D().counselors.find(x => x.id === id); if (!c) return;
    editCid = id; $('eMsg').textContent = '';
    $('eName').value = c.name; $('eStatus').value = c.status; $('ePhones').value = c.phones.map(p => p.number).join('\n');
    $('eBasis').value = c.consent.basis; $('eRetention').value = c.retentionUntil; $('eConsent').checked = c.consent.given;
    $('dlgC').showModal();
  }
  async function saveEditC() {
    try {
      const name = $('eName').value.trim(); if (!name) throw new Error('이름은 필수입니다.');
      const phones = readPhones($('ePhones').value.split('\n')), ret = $('eRetention').value;
      if (ret && !C.isDate(ret)) throw new Error('보관 기한이 올바르지 않습니다.');
      const cur = D().counselors.find(x => x.id === editCid), basis = $('eBasis').value;
      const consent = consentOf($('eConsent').checked, basis, cur.consent);
      if (C.findCandidates(D().counselors, name, phones.map(p => p.norm), editCid).some(x => x.level === 'strong') &&
        !confirm('이름과 전화번호가 모두 같은 다른 상담자가 있습니다. 그래도 저장할까요?')) return;
      const status = $('eStatus').value;
      if (await doCommit(d => {
        const c = d.counselors.find(x => x.id === editCid); if (!c) throw new Error('상담자를 찾을 수 없습니다.');
        Object.assign(c, { name, phones, status, consent, retentionUntil: ret, updatedAt: new Date().toISOString() }); return d;
      }, {}, '상담자 정보 수정 완료')) $('dlgC').close();
    } catch (e) { $('eMsg').textContent = e.message; }
  }
  function openEditS(id) {
    const s = D().sessions.find(x => x.id === id); if (!s) return;
    editSid = id; $('sMsg').textContent = '';
    $('sDate').value = s.date; $('sFollow').value = s.followUp; $('sNote').value = s.note; $('sDone').checked = s.followDone;
    $('dlgS').showModal();
  }
  async function saveEditS() {
    try {
      const date = $('sDate').value, fu = $('sFollow').value, note = $('sNote').value.trim();
      if (!C.isDate(date) || !note) throw new Error('상담일과 내용은 필수입니다.');
      if (fu && (!C.isDate(fu) || fu < date)) throw new Error('후속 연락일은 상담일 이후여야 합니다.');
      const done = $('sDone').checked && !!fu;
      if (await doCommit(d => {
        const s = d.sessions.find(x => x.id === editSid); if (!s) throw new Error('상담 기록을 찾을 수 없습니다.');
        const was = s.followDone;
        Object.assign(s, { date, note, followUp: fu, followDone: done, doneAt: done ? (was && s.doneAt) || C.localDate() : '', updatedAt: new Date().toISOString() }); return d;
      }, {}, '상담 기록 수정 완료')) $('dlgS').close();
    } catch (e) { $('sMsg').textContent = e.message; }
  }
  async function deleteSession(id) {
    if (!confirm('이 상담 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
    await doCommit(d => { d.sessions = d.sessions.filter(s => s.id !== id); return d; }, {}, '상담 기록 삭제 완료');
  }
  async function deleteCounselor(id) {
    const c = D().counselors.find(x => x.id === id); if (!c) return;
    const n = D().sessions.filter(s => s.counselorId === id).length;
    if (!confirm('"' + c.name + '" 상담자와 상담 기록 ' + n + '건을 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    await doCommit(d => { C.removeCounselors(d, [id]); d.purgeLog.push({ at: new Date().toISOString(), count: 1, reason: '수동 삭제' }); return d; }, {}, '상담자 삭제 완료');
  }
  async function purgeExpired() {
    const list = C.expired(D(), C.localDate()); if (!list.length) return;
    if (!confirm('보관 기한이 지난 상담자 ' + list.length + '명과 모든 상담 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    await doCommit(d => { const ids = C.expired(d, C.localDate()).map(c => c.id); C.removeCounselors(d, ids); d.purgeLog.push({ at: new Date().toISOString(), count: ids.length, reason: '보관기한 만료' }); return d; }, {}, '보관기한 만료 삭제 완료');
  }
  async function purgeBackups() {
    if (!store) return;
    if (!confirm('보관 폴더 안의 모든 자동 백업 및 임시 보관 파일(.bak)을 완전히 삭제합니다.\n삭제 후에는 이전 백업으로 되돌릴 수 없습니다. (직접 내려받아 보관 중인 백업 파일은 별도로 삭제해야 합니다.) 계속할까요?')) return;
    try { setMsg('✅ 백업 파일 ' + await store.purgeBackups() + '개 삭제 완료', 'ok'); } catch (e) { setMsg('❌ 백업 삭제 실패: ' + e.message, 'err'); }
  }
  const setStatus = (id, status) => doCommit(d => { const c = d.counselors.find(x => x.id === id); if (!c) throw new Error('상담자를 찾을 수 없습니다.'); c.status = status; c.updatedAt = new Date().toISOString(); return d; }, {}, '상태 변경 완료');
  const toggleDone = id => doCommit(d => { const s = d.sessions.find(x => x.id === id); if (!s) throw new Error('상담 기록을 찾을 수 없습니다.'); s.followDone = !s.followDone; s.doneAt = s.followDone ? C.localDate() : ''; s.updatedAt = new Date().toISOString(); return d; }, {}, '연락 상태 변경 완료');
  function addSessionFor(id) {
    const c = D().counselors.find(x => x.id === id); if (!c) return;
    showPage('new');
    $('fName').value = c.name; $('fPhone').value = c.phones[0].number; $('fPhone2').value = c.phones[1] ? c.phones[1].number : '';
    refreshCandidates(); $('fExisting').value = id; $('fNote').focus(); $('fName').scrollIntoView({ block: 'center' });
  }

  async function saveRetention() {
    const n = Number($('setMonths').value);
    if (!C.validMonths(n)) return setMsg('❌ 보관 기간은 1~120개월 정수로 입력하세요.', 'err');
    await doCommit(d => { d.settings = { ...d.settings, retentionMonths: n }; return d; }, {}, '보관 기간 ' + n + '개월 설정 완료 (이후 등록분부터 적용, 기존 상담자의 보관기한은 수정에서 변경)');
  }

  /* ===== 백업/복원 ===== */
  function backup() {
    if (state !== 'CONNECTED') return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(D(), null, 2)], { type: 'application/json' }));
    a.download = 'consult-backup-' + C.stamp() + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setMsg('✅ 자료 백업 파일 다운로드 완료 (개인정보가 포함되어 있으니 안전한 곳에 보관하세요)', 'ok');
  }
  function restore() {
    if (state !== 'CONNECTED' && state !== 'ERROR') return;
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      let r;
      try { r = C.normalizeImport(JSON.parse(await f.text())); } catch (e) { return setMsg('복원 오류: 백업 파일을 읽을 수 없습니다 (파일 형식을 확인하세요) — ' + e.message, 'err'); }
      if (r.errors.length) return setMsg('❌ 복원 불가 (현재 상담 자료는 안전하게 유지됩니다): ' + r.errors.slice(0, 3).join(', ') + (r.errors.length > 3 ? ' 외 ' + (r.errors.length - 3) + '건' : ''), 'err');
      const info = '불러올 백업: 상담자 ' + r.data.counselors.length + '명 · 상담 ' + r.data.sessions.length + '건' + (r.source === 'legacy' ? ' (이전 수첩 자료)' : '') +
        '\n현재 수첩: 상담자 ' + D().counselors.length + '명 · 상담 ' + D().sessions.length + '건' + (r.warnings.length ? '\n\n' + r.warnings.join('\n') : '');
      const merge = confirm(info + '\n\n[확인] 기존 자료와 합치기 (동일 상담자는 최신 내용 유지)\n[취소] 기존 자료를 백업 내용으로 전체 바꾸기');
      if (!merge && !confirm('현재 자료를 백업 파일 내용으로 완전히 바꿉니까?\n(바꾸기 직전의 상담 자료는 보관 폴더에 자동 백업되므로 안심하셔도 됩니다.)')) return;
      if (await doCommit(d => merge ? C.mergeData(d, r.data) : r.data, { tag: 'pre-restore' }, '자료 복원 완료 (' + (merge ? '합치기' : '전체 바꾸기') + ')')) {
        if (state === 'ERROR') await openAndLoad(); else render();
      }
    };
    inp.click();
  }

  /* ===== 렌더 ===== */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function tag(s) { return '<span class="tag ' + ({ '상담 중': '', '보류': 'wait', '등록 완료': 'done', '미등록 종결': 'stop' }[s] || '') + '">' + esc(s) + '</span>'; }
  const phonesHtml = c => c.phones.map(p => esc(p.number)).join('<br>');
  const lastSession = (d, id) => d.sessions.filter(s => s.counselorId === id).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))[0];
  function matches(d, c, q) {
    if (!q) return true;
    const qd = q.replace(/\D/g, '');
    return c.name.toLowerCase().includes(q) || c.phones.some(p => p.number.toLowerCase().includes(q) || (qd && p.norm.includes(qd))) ||
      d.sessions.some(s => s.counselorId === c.id && s.note.toLowerCase().includes(q));
  }
  function btn(act, id, label, cls) { return '<button class="small ' + (cls || 'ghost') + '" data-act="' + act + '" data-id="' + esc(id) + '">' + label + '</button> '; }

  function render() {
    renderDashboard();
    const area = $('listArea');
    if (state === 'ERROR') {
      area.innerHTML = '<div class="error-banner">⚠ 상담 자료를 불러오지 못했습니다.<br>기존 상담 파일은 <strong>안전하게 그대로 보존</strong>되어 있습니다.<br><small>보관 중인 백업 파일이 있으면 "자료 복원"을 사용하거나, 폴더를 다시 선택하세요.</small></div>';
      return;
    }
    if (document.activeElement !== $('setMonths')) $('setMonths').value = C.retentionMonths(D());
    $('btnSetMonths').disabled = state !== 'CONNECTED';
    const d = D(), today = C.localDate(), q = $('search').value.trim().toLowerCase(), b = C.contactBuckets(d, today), exp = C.expired(d, today);
    document.querySelectorAll('#tabs button').forEach(t => {
      const v = t.dataset.view; t.classList.toggle('on', v === view);
      const n = v === 'all' ? d.counselors.length : v === 'expired' ? exp.length : b[v].length;
      t.dataset.n = n; t.textContent = t.textContent.replace(/\s*\(\d+\)$/, '') + ' (' + n + ')';
    });
    if (state !== 'CONNECTED') { area.innerHTML = '<div class="empty">데이터 폴더를 연결하면 기록이 표시됩니다.</div>'; return; }
    if (b[view]) return renderContacts(area, b[view].filter(x => matches(d, x.c, q)), today);
    const list = (view === 'expired' ? exp : d.counselors).filter(c => matches(d, c, q))
      .sort((a, c) => ((lastSession(d, c.id) || {}).date || '').localeCompare((lastSession(d, a.id) || {}).date || ''));
    let html = '';
    if (view === 'expired') {
      html += '<div class="row" style="margin-bottom:10px;align-items:center;"><span class="muted">보관 기한이 지난 상담자입니다. 삭제하면 상담 기록도 함께 삭제됩니다.</span>' +
        btn('purgeExp', '', '만료 ' + exp.length + '명 일괄 삭제', 'danger') + btn('purgeBak', '', '백업 폴더 정리', 'ghost') + '</div>';
    }
    if (!list.length) { area.innerHTML = html + '<div class="empty">' + (view === 'expired' ? '보관 기한이 지난 상담자가 없습니다.' : '표시할 상담 기록이 없습니다.') + '</div>'; return; }
    html += '<table><thead><tr><th>이름</th><th>전화번호</th><th>최근 상담</th><th>상태</th><th>다음 연락</th><th>보관기한</th><th>동의 및 수집근거</th><th></th></tr></thead><tbody>';
    for (const c of list) {
      const ss = d.sessions.filter(s => s.counselorId === c.id).sort((a, z) => (z.date + z.createdAt).localeCompare(a.date + a.createdAt));
      const next = ss.filter(s => s.followUp && !s.followDone).map(s => s.followUp).sort()[0];
      html += '<tr><td><strong>' + esc(c.name) + '</strong></td><td>' + phonesHtml(c) + '</td><td>' + esc(ss[0] ? ss[0].date : '-') + '</td>' +
        '<td><select data-act="status" data-id="' + esc(c.id) + '" style="width:auto;">' + C.STATUSES.map(s => '<option' + (s === c.status ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></td>' +
        '<td>' + (next ? esc(next) + (next < today && !C.CLOSED.includes(c.status) ? ' <span class="tag late">지남</span>' : '') : '-') + '</td>' +
        '<td>' + esc(c.retentionUntil || '-') + '</td><td>' + (c.consent.given ? '✅ 동의완료' : '— 미동의') + ' <span class="muted">' + esc(c.consent.basis) + '</span></td>' +
        '<td style="white-space:nowrap;">' + btn('hist', c.id, '이력 (' + ss.length + ')') + btn('addsess', c.id, '상담 추가') + btn('editc', c.id, '수정') + btn('delc', c.id, '삭제', 'danger') + '</td></tr>';
      if (expanded.has(c.id)) {
        html += '<tr class="hist"><td colspan="8"><table><thead><tr><th>상담일</th><th>내용</th><th>후속 연락</th><th></th></tr></thead><tbody>' +
          (ss.map(s => '<tr><td>' + esc(s.date) + '</td><td style="white-space:pre-wrap;">' + esc(s.note) + '</td><td>' +
            (s.followUp ? esc(s.followUp) + (s.followDone ? ' <span class="tag done">완료 ' + esc(s.doneAt) + '</span>' : '') : '-') + '</td><td style="white-space:nowrap;">' +
            (s.followUp ? btn('done', s.id, s.followDone ? '완료 취소' : '연락 완료') : '') + btn('edits', s.id, '수정') + btn('dels', s.id, '삭제', 'danger') + '</td></tr>').join('') ||
            '<tr><td colspan="4" class="muted">상담 기록이 없습니다.</td></tr>') + '</tbody></table></td></tr>';
      }
    }
    area.innerHTML = html + '</tbody></table>';
  }
  function renderContacts(area, items, today) {
    if (!items.length) { area.innerHTML = '<div class="empty">해당하는 연락 일정이 없습니다.</div>'; return; }
    let html = '<table><thead><tr><th>' + (view === 'done' ? '완료일' : '연락일') + '</th><th>이름</th><th>전화번호</th><th>상담 내용</th><th>상태</th><th></th></tr></thead><tbody>';
    for (const { s, c } of items) {
      const late = view === 'overdue' ? ' <span class="tag late">' + C.daysBetween(s.followUp, today) + '일 지남</span>' : '';
      html += '<tr><td>' + esc(view === 'done' ? (s.doneAt || s.followUp) : s.followUp) + late + '</td><td><strong>' + esc(c.name) + '</strong></td><td>' + phonesHtml(c) + '</td>' +
        '<td style="max-width:280px;white-space:pre-wrap;">' + esc(s.note) + '</td><td>' + tag(c.status) + '</td><td style="white-space:nowrap;">' +
        btn('done', s.id, s.followDone ? '완료 취소' : '연락 완료') + btn('addsess', c.id, '상담 추가') + btn('edits', s.id, '수정') + '</td></tr>';
    }
    area.innerHTML = html + '</tbody></table>';
  }

  /* ===== 이벤트 ===== */
  $('btnConnect').onclick = pickFolder;
  $('btnPermission').onclick = async () => {
    if (!dir) return;
    try {
      if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') await openAndLoad();
      else setState('PERMISSION_NEEDED', '권한이 거부되었습니다. "폴더 변경"으로 다시 선택하세요.');
    } catch (e) { $('status').textContent = '권한 요청 실패: ' + e.message; }
  };
  $('btnSetMonths').onclick = saveRetention;
  $('btnBackup').onclick = backup; $('btnRestore').onclick = restore; $('btnAdd').onclick = addRecord;
  ['fName', 'fPhone', 'fPhone2'].forEach(id => $(id).addEventListener('input', refreshCandidates));
  $('search').oninput = render;
  $('tabs').addEventListener('click', e => { const t = e.target.closest('button[data-view]'); if (t) { view = t.dataset.view; render(); } });
  $('eSave').onclick = saveEditC; $('eCancel').onclick = () => $('dlgC').close();
  $('sSave').onclick = saveEditS; $('sCancel').onclick = () => $('dlgS').close();
  const acts = { dels: deleteSession, delc: deleteCounselor, editc: openEditC, edits: openEditS, done: toggleDone, addsess: addSessionFor, purgeExp: purgeExpired, purgeBak: purgeBackups,
    hist: id => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); } };
  $('listArea').addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b && acts[b.dataset.act]) acts[b.dataset.act](b.dataset.id); });
  $('listArea').addEventListener('change', e => { const s = e.target.closest('select[data-act="status"]'); if (s) setStatus(s.dataset.id, s.value); });

  /* 화면 구성: 저장 로직과 독립된 메뉴·현황 표시 */
  let activePage = 'home';
  function renderDashboard() {
    const connected = state === 'CONNECTED';
    const d = D(), b = C.contactBuckets(d, C.localDate());
    const counts = {all:d.counselors.length,today:b.today.length,overdue:b.overdue.length,registered:d.counselors.filter(c=>c.status==='등록 완료').length};
    for (const key of Object.keys(counts)) $('stat-'+key).textContent = connected ? String(counts[key]) : '—';
    $('statsHint').textContent = connected ? '현재 연결된 상담 자료 기준' : '폴더 연결 후 현황을 확인할 수 있습니다.';
    $('todayLabel').textContent = new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
  }
  function showPage(page, filter) {
    if (!$('page-'+page)) return;
    if (activePage !== page) $('search').value = '';
    activePage = page;
    document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('hidden',s.id!=='page-'+page));
    document.querySelectorAll('nav [data-page]').forEach(b=>{ const on=b.dataset.page===page; b.classList.toggle('active',on); if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current'); });
    const mount = {records:'recordsMount',contacts:'contactsMount',privacy:'privacyMount'}[page];
    if (mount) {
      $(mount).appendChild($('listPanel')); $('listPanel').classList.remove('hidden');
      const allowed = page==='records'?['all']:page==='contacts'?['today','overdue','upcoming','done']:['expired'];
      document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('hidden',!allowed.includes(b.dataset.view)));
      view = allowed.includes(filter)?filter:allowed[0]; render();
    } else $('listPanel').classList.add('hidden');
    window.scrollTo({top:0,behavior:'instant'});
  }
  document.addEventListener('click',e=>{const b=e.target.closest('button[data-page]');if(b)showPage(b.dataset.page,b.dataset.filter);});
  renderDashboard(); showPage('home');

  window.addEventListener('load', init);
})();
