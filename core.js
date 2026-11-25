/* 상담 수첩 핵심 로직 (화면·저장소와 무관한 순수 함수) */
(function (root) {
  'use strict';
  const SCHEMA = 2;
  const APP = 'consult-pwa';
  const STATUSES = ['신규', '상담 중', '보류', '등록 완료', '미등록 종결'];
  const CLOSED = ['등록 완료', '미등록 종결'];
  const BASES = ['정보주체 동의', '계약 체결을 위한 조치', '법령상 의무', '미확인'];
  const LEGACY_STATUS = { '신규': '신규', '상담중': '상담 중', '상담 중': '상담 중', '보류': '보류', '등록': '등록 완료', '등록 완료': '등록 완료', '미등록 종결': '미등록 종결' };

  /* ---------- 날짜 (모두 로컬 기준) ---------- */
  const p2 = n => String(n).padStart(2, '0');
  function localDate(d) { d = d || new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function stamp(d) { d = d || new Date(); return localDate(d).replace(/-/g, '') + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()); }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number), t = new Date(y, m - 1, d);
    return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
  }
  function addYears(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    let t = new Date(y + n, m - 1, d);
    if (t.getMonth() !== m - 1) t = new Date(y + n, m, 0); // 2/29 → 2/28
    return localDate(t);
  }
  function addMonths(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    let t = new Date(y, m - 1 + n, d);
    if (t.getDate() !== d) t = new Date(y, m + n, 0); // 말일 보정
    return localDate(t);
  }
  const DEFAULT_RETENTION_MONTHS = 12;
  const validMonths = n => Number.isInteger(n) && n >= 1 && n <= 120;
  function retentionMonths(d) { return d && d.settings && validMonths(d.settings.retentionMonths) ? d.settings.retentionMonths : DEFAULT_RETENTION_MONTHS; }
  function daysBetween(from, to) { // to - from (일)
    const a = from.split('-').map(Number), b = to.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 864e5);
  }

  /* ---------- 전화번호 ---------- */
  function normPhone(s) {
    let d = String(s == null ? '' : s).replace(/\D/g, '');
    if (d.startsWith('0082')) d = '0' + d.slice(4);
    else if (d.startsWith('82') && d.length >= 11) d = '0' + d.slice(2);
    return d;
  }
  function validPhone(n) { return /^\d{8,15}$/.test(n); }
  function fmtPhone(s) {
    const n = normPhone(s);
    if (/^01\d{8,9}$/.test(n)) return n.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    if (/^02\d{7,8}$/.test(n)) return n.replace(/^(02)(\d{3,4})(\d{4})$/, '$1-$2-$3');
    if (/^0\d{9,10}$/.test(n)) return n.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    return String(s).trim();
  }
  function phoneObj(label, raw) { const norm = normPhone(raw); return { label, number: fmtPhone(raw), norm }; }

  /* ---------- 기본 ---------- */
  const clone = o => JSON.parse(JSON.stringify(o));
  function makeId(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function hash(str) { let x = 5381; for (const ch of str) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return x.toString(36); }
  function emptyData() { return { app: APP, schema: SCHEMA, rev: 0, savedAt: '', settings: { retentionMonths: DEFAULT_RETENTION_MONTHS }, counselors: [], sessions: [], purgeLog: [] }; }
  const ts = i => i.updatedAt || i.createdAt || '';

  /* ---------- 구조 검증 ---------- */
  function validateData(d) {
    const e = [];
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { errors: ['최상위가 객체가 아닙니다'] };
    if (d.app !== APP) e.push('app 값이 ' + APP + ' 가 아닙니다');
    if (d.schema !== SCHEMA) e.push('지원하지 않는 schema: ' + d.schema);
    if (!Array.isArray(d.counselors)) e.push('counselors 배열이 없습니다');
    if (!Array.isArray(d.sessions)) e.push('sessions 배열이 없습니다');
    if (e.length) return { errors: e };
    if (!d.settings || !validMonths(d.settings.retentionMonths)) e.push('보관 기간 설정 오류 (1~120개월)');
    const ids = new Set();
    d.counselors.forEach((c, i) => {
      const t = '상담자[' + i + ']';
      if (!c || typeof c !== 'object') return e.push(t + ' 형식 오류');
      if (typeof c.id !== 'string' || !c.id) e.push(t + ' id 없음');
      else if (ids.has(c.id)) e.push(t + ' id 중복: ' + c.id); else ids.add(c.id);
      if (typeof c.name !== 'string' || !c.name.trim()) e.push(t + ' 이름 없음');
      if (!Array.isArray(c.phones) || !c.phones.length) e.push(t + ' 전화번호 없음');
      else c.phones.forEach(p => { if (!p || typeof p.number !== 'string' || p.norm !== normPhone(p.number) || !validPhone(p.norm)) e.push(t + ' 전화번호 오류'); });
      if (!STATUSES.includes(c.status)) e.push(t + ' 상태 오류: ' + c.status);
      if (!c.consent || typeof c.consent.given !== 'boolean' || !BASES.includes(c.consent.basis)) e.push(t + ' 동의/처리근거 오류');
      if (c.retentionUntil !== '' && !isDate(c.retentionUntil)) e.push(t + ' 보관기한 오류');
    });
    const sids = new Set();
    d.sessions.forEach((s, i) => {
      const t = '상담[' + i + ']';
      if (!s || typeof s !== 'object') return e.push(t + ' 형식 오류');
      if (typeof s.id !== 'string' || !s.id) e.push(t + ' id 없음');
      else if (sids.has(s.id)) e.push(t + ' id 중복: ' + s.id); else sids.add(s.id);
      if (!ids.has(s.counselorId)) e.push(t + ' 상담자 연결 끊김');
      if (!isDate(s.date)) e.push(t + ' 상담일 오류');
      if (typeof s.note !== 'string') e.push(t + ' 내용 형식 오류');
      if (s.followUp !== '' && !isDate(s.followUp)) e.push(t + ' 후속일 오류');
      if (typeof s.followDone !== 'boolean') e.push(t + ' 연락완료 값 오류');
    });
    return { errors: e };
  }

  /* ---------- 구버전(배열) 마이그레이션 ---------- */
  function migrateLegacy(arr) {
    const d = emptyData(), warnings = [], errors = [], now = new Date().toISOString(), today = localDate();
    const groups = new Map(), usedS = new Set();
    let skipped = 0, fixedDate = 0;
    arr.forEach((r, i) => {
      if (!r || typeof r !== 'object' || !String(r.name || '').trim()) { skipped++; return; }
      const raws = (Array.isArray(r.phones) && r.phones.length ? r.phones : [r.phone]).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
      const norms = raws.map(normPhone);
      if (!raws.length || !validPhone(norms[0])) { skipped++; return; }
      const name = String(r.name).trim();
      const key = norms[0] + '|' + name.replace(/\s/g, '');
      let g = groups.get(key);
      if (!g) { g = { id: 'p_' + hash(key), name, phones: [], recs: [] }; groups.set(key, g); }
      raws.forEach((raw, k) => { if (validPhone(norms[k]) && !g.phones.some(p => p.norm === norms[k])) g.phones.push(phoneObj(g.phones.length ? '추가' : '대표', raw)); });
      let date = r.date;
      if (!isDate(date)) { fixedDate++; date = r.createdAt && !isNaN(new Date(r.createdAt)) ? localDate(new Date(r.createdAt)) : today; }
      let sid = typeof r.id === 'string' && r.id ? r.id : 'c_legacy_' + i;
      while (usedS.has(sid)) sid += '_' + i;
      usedS.add(sid);
      const status = LEGACY_STATUS[r.status] || '신규';
      if (!LEGACY_STATUS[r.status]) warnings.push('알 수 없는 상태 "' + r.status + '" → 신규');
      const createdAt = typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : now;
      g.recs.push({ r, status, createdAt, s: { id: sid, counselorId: g.id, date, note: String(r.note == null ? '' : r.note), followUp: isDate(r.followUp) ? r.followUp : '', followDone: false, doneAt: '', createdAt, updatedAt: createdAt } });
    });
    for (const g of groups.values()) {
      g.recs.sort((a, b) => (a.s.date + a.createdAt).localeCompare(b.s.date + b.createdAt));
      const last = g.recs[g.recs.length - 1], cons = g.recs.find(x => x.r.consent === true);
      d.counselors.push({
        id: g.id, name: g.name, phones: g.phones, status: last.status,
        consent: { given: !!cons, at: cons ? cons.s.date : '', basis: '미확인' }, // 처리 근거는 확인되지 않았으므로 미확인으로 둔다
        retentionUntil: addMonths(last.s.date, DEFAULT_RETENTION_MONTHS), createdAt: g.recs[0].createdAt, updatedAt: now
      });
      g.recs.forEach(x => d.sessions.push(x.s));
    }
    if (skipped) warnings.push('이름·전화번호가 없어 변환하지 못한 항목 ' + skipped + '건 (원본은 백업에 보존)');
    if (fixedDate) warnings.push('상담일이 잘못되어 보정한 항목 ' + fixedDate + '건');
    warnings.push('처리 근거는 확인되지 않아 모두 "미확인"으로 남겼습니다(동의 체크 여부만 유지). 보관기한은 마지막 상담일 + 기본 보관 기간(' + DEFAULT_RETENTION_MONTHS + '개월)입니다. 확인 후 수정하세요.');
    errors.push(...validateData(d).errors);
    return { data: d, errors, warnings, source: 'legacy' };
  }

  function normalizeImport(parsed) {
    if (Array.isArray(parsed)) return migrateLegacy(parsed);
    if (parsed && typeof parsed === 'object') {
      if (!Array.isArray(parsed.purgeLog)) parsed.purgeLog = [];
      if (typeof parsed.rev !== 'number') parsed.rev = 0;
      if (parsed.settings === undefined) parsed.settings = { retentionMonths: DEFAULT_RETENTION_MONTHS };
      return { data: parsed, errors: validateData(parsed).errors, warnings: [], source: 'v2' };
    }
    return { data: null, errors: ['JSON 형식이 올바르지 않습니다'], warnings: [], source: '' };
  }

  /* ---------- 중복 후보 ---------- */
  const squash = s => String(s || '').replace(/\s/g, '').toLowerCase();
  function findCandidates(counselors, name, norms, excludeId) {
    const out = [], n = squash(name);
    for (const c of counselors) {
      if (c.id === excludeId) continue;
      const samePhone = c.phones.some(p => norms.includes(p.norm)), sameName = !!n && squash(c.name) === n;
      if (samePhone || sameName) out.push({ c, level: samePhone && sameName ? 'strong' : samePhone ? 'phone' : 'name' });
    }
    const rank = { strong: 0, phone: 1, name: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /* ---------- 연락 관리 ---------- */
  function contactBuckets(d, today) {
    const cm = new Map(d.counselors.map(c => [c.id, c]));
    const o = { today: [], overdue: [], upcoming: [], done: [] };
    for (const s of d.sessions) {
      if (!s.followUp) continue;
      const c = cm.get(s.counselorId); if (!c) continue;
      const it = { s, c };
      if (s.followDone) { o.done.push(it); continue; }
      if (CLOSED.includes(c.status)) continue; // 등록 완료·미등록 종결 상담자는 미처리 목록에서 제외
      (s.followUp < today ? o.overdue : s.followUp === today ? o.today : o.upcoming).push(it);
    }
    const asc = (a, b) => a.s.followUp.localeCompare(b.s.followUp);
    o.today.sort(asc); o.overdue.sort(asc); o.upcoming.sort(asc);
    o.done.sort((a, b) => (b.s.doneAt || b.s.followUp).localeCompare(a.s.doneAt || a.s.followUp));
    return o;
  }

  /* ---------- 병합 / 삭제 ---------- */
  function mergeList(x, y) {
    const m = new Map(x.map(i => [i.id, i]));
    for (const i of y) { const o = m.get(i.id); if (!o || ts(i) > ts(o)) m.set(i.id, i); }
    return [...m.values()];
  }
  function mergeData(a, b) {
    const r = clone(a);
    r.counselors = mergeList(a.counselors, b.counselors);
    r.sessions = mergeList(a.sessions, b.sessions);
    r.purgeLog = (a.purgeLog || []).concat(b.purgeLog || []);
    return r;
  }
  function expired(d, today) { return d.counselors.filter(c => c.retentionUntil && c.retentionUntil < today); }
  function removeCounselors(d, ids) {
    const set = new Set(ids), n = d.sessions.filter(s => set.has(s.counselorId)).length;
    d.counselors = d.counselors.filter(c => !set.has(c.id));
    d.sessions = d.sessions.filter(s => !set.has(s.counselorId));
    return n;
  }

  const api = { SCHEMA, APP, STATUSES, CLOSED, BASES, localDate, stamp, isDate, addYears, addMonths, retentionMonths, validMonths, DEFAULT_RETENTION_MONTHS, daysBetween, normPhone, validPhone, fmtPhone, phoneObj, clone, makeId, emptyData, validateData, migrateLegacy, normalizeImport, findCandidates, contactBuckets, mergeData, expired, removeCounselors };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
