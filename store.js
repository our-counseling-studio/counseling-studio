/* 폴더 저장소: 충돌 감지, 백업, 검증 저장 */
(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.Core;
  const FILE = 'counseling.json', BAK = 'counseling.json.bak', BDIR = 'backup', KEEP_AUTO = 30;

  function fail(code, msg) { const e = new Error(msg); e.code = code; return e; }

  class Store {
    constructor(dir) { this.dir = dir; this.raw = null; this.data = C.emptyData(); this.legacy = false; this.chain = Promise.resolve(); }

    async _read(dir, name) {
      try { return await (await (await dir.getFileHandle(name, { create: false })).getFile()).text(); }
      catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
    }
    async _write(dir, name, text) { // 쓰고 → 다시 읽어 일치 확인
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      try { await w.write(text); await w.close(); } catch (e) { try { await w.abort(); } catch (_) { } throw e; }
      if (await this._read(dir, name) !== text) throw new Error(name + ' 저장 검증 실패');
    }

    /* 읽기 전용 로드. 실패해도 파일은 건드리지 않고 raw만 기억한다(복원으로 복구 가능). */
    async load() {
      this.raw = await this._read(this.dir, FILE);
      this.data = C.emptyData(); this.legacy = false;
      if (this.raw === null || !this.raw.trim()) return { fresh: true, warnings: [] };
      let parsed;
      try { parsed = JSON.parse(this.raw); } catch (e) { throw new Error('JSON 파싱 실패 — ' + e.message); }
      const r = C.normalizeImport(parsed);
      if (r.errors.length) throw new Error('데이터 구조 오류 — ' + r.errors.slice(0, 3).join(', '));
      this.data = r.data; this.legacy = r.source === 'legacy';
      return { fresh: false, warnings: r.warnings, legacy: this.legacy };
    }

    commit(mutator, opts) {
      const run = () => this._commit(mutator, opts || {});
      const locked = () => (root.navigator && navigator.locks) ? navigator.locks.request('consult-pwa-save', run) : run();
      const p = this.chain.then(locked);
      this.chain = p.catch(() => { });
      return p;
    }

    async _commit(mutator, opts) {
      const disk = await this._read(this.dir, FILE);
      if (disk !== this.raw) throw fail('CONFLICT', '파일이 다른 곳에서 변경되었습니다');
      const next = mutator(C.clone(this.data)) || null;
      if (!next) throw new Error('변경 내용이 없습니다');
      next.app = C.APP; next.schema = C.SCHEMA; next.rev = (this.data.rev || 0) + 1; next.savedAt = new Date().toISOString();
      const v = C.validateData(next);
      if (v.errors.length) throw new Error('저장 전 검증 실패: ' + v.errors[0]);
      const text = JSON.stringify(next, null, 2);

      if (disk !== null && disk.trim()) { // 덮어쓰기 전 이전 내용을 모두 보존 (하나라도 실패하면 저장 중단)
        const bdir = await this.dir.getDirectoryHandle(BDIR, { create: true }), st = C.stamp();
        if (this.legacy) await this._write(bdir, 'legacy-premigration-' + st + '.json', disk);
        if (opts.tag) await this._write(bdir, opts.tag + '-' + st + '.json', disk);
        const auto = 'auto-' + C.localDate() + '.json';
        if (await this._read(bdir, auto) === null) await this._write(bdir, auto, disk);
        await this._write(this.dir, BAK, disk);
        await this._prune(bdir);
      }
      await this._write(this.dir, FILE, text);
      this.raw = text; this.data = next; this.legacy = false;
      return next;
    }

    async _prune(bdir) {
      const names = [];
      for await (const [n, h] of bdir.entries()) if (h.kind === 'file' && /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(n)) names.push(n);
      names.sort();
      for (const n of names.slice(0, Math.max(0, names.length - KEEP_AUTO))) await bdir.removeEntry(n);
    }

    /* 개인정보 삭제 후 백업 폴더·.bak 정리 (사용자가 명시적으로 요청할 때만) */
    async purgeBackups() {
      let n = 0;
      try { await this.dir.removeEntry(BAK); n++; } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      try {
        const bdir = await this.dir.getDirectoryHandle(BDIR, { create: false }), names = [];
        for await (const [nm, h] of bdir.entries()) if (h.kind === 'file' && /\.json$/.test(nm)) names.push(nm);
        for (const nm of names) { await bdir.removeEntry(nm); n++; }
      } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      return n;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { Store }; else root.Store = Store;
})(typeof self !== 'undefined' ? self : this);
