/* ============================================================================
   Studio Library — a tiny shared asset store for the Meshy Studio suite.
   Loaded by all three tools (Rigger, Animator, Stitcher) AND the shell.
   Because every tool is served from the SAME origin (one local server rooted
   at D:\Claude), they share one IndexedDB — so a rigged model or a baked
   motion written by one tool is instantly visible to the others.

   window.StudioLib API (all async return Promises):
     ready                      -> resolves when the DB is open
     addModel({name,skeleton,glb[,thumb]}) -> id   (glb = ArrayBuffer|Blob)
     listModels()               -> [{id,name,skeleton,size,createdAt,thumb?}]
     getModel(id)               -> {..., glb:Blob}
     deleteModel(id)
     addMotion({name,sig,skeleton,entry,clip,pose[,id]}) -> id
     listMotions()              -> [{id,name,sig,createdAt}]
     getMotion(id)              -> full record (skeleton,entry,clip,pose)
     deleteMotion(id)
     onChange(cb)               -> unsubscribe fn   (fires {store} on any write,
                                    across tabs/iframes via BroadcastChannel)
   ========================================================================== */
(function (global) {
  const DB_NAME = 'StudioLibrary', DB_VER = 1;
  const bc = ('BroadcastChannel' in global) ? new BroadcastChannel('studio-library') : null;
  const listeners = new Set();
  function fire(store) {
    const ev = { store };
    listeners.forEach(cb => { try { cb(ev); } catch (e) { console.warn(e); } });
  }
  if (bc) bc.onmessage = e => { if (e && e.data && e.data.type === 'change') fire(e.data.store); };
  function notify(store) { fire(store); if (bc) bc.postMessage({ type: 'change', store }); }

  let dbP = null;
  function open() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('models'))  db.createObjectStore('models',  { keyPath: 'id' });
        if (!db.objectStoreNames.contains('motions')) db.createObjectStore('motions', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbP;
  }
  function tx(store, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode), os = t.objectStore(store);
      let out; try { out = fn(os); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  const getAll = os => new Promise((res, rej) => { const r = os.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
  const getOne = (os, id) => new Promise((res, rej) => { const r = os.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
  const uid = p => (p || 'x') + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

  const API = {
    ready: open().then(() => true),

    // ---- rigged models (base characters) ----
    async addModel({ name, skeleton, glb, thumb }) {
      const blob = (glb instanceof Blob) ? glb : new Blob([glb], { type: 'model/gltf-binary' });
      const rec = { id: uid('mdl'), name: name || 'character', skeleton: skeleton || 'biped', glb: blob, size: blob.size, thumb: thumb || null, createdAt: Date.now() };
      await tx('models', 'readwrite', os => os.put(rec));
      notify('models'); return rec.id;
    },
    async listModels() {
      const rows = await tx('models', 'readonly', getAll);
      return rows.map(({ id, name, skeleton, size, createdAt, thumb }) => ({ id, name, skeleton, size, createdAt, thumb }))
                 .sort((a, b) => b.createdAt - a.createdAt);
    },
    getModel(id) { return tx('models', 'readonly', os => getOne(os, id)); },
    async deleteModel(id) { await tx('models', 'readwrite', os => os.delete(id)); notify('models'); },

    // ---- baked motions (feed the Stitcher's retarget library) ----
    async addMotion({ id, name, sig, skeleton, entry, clip, pose }) {
      const rec = { id: id || uid('mot'), name: name || 'motion', sig: sig || '', skeleton: skeleton || null, entry: entry || null, clip: clip || null, pose: pose || null, createdAt: Date.now() };
      await tx('motions', 'readwrite', os => os.put(rec));
      notify('motions'); return rec.id;
    },
    async listMotions() {
      const rows = await tx('motions', 'readonly', getAll);
      return rows.map(({ id, name, sig, createdAt }) => ({ id, name, sig, createdAt })).sort((a, b) => b.createdAt - a.createdAt);
    },
    getMotion(id) { return tx('motions', 'readonly', os => getOne(os, id)); },
    getAllMotions() { return tx('motions', 'readonly', getAll); },
    async deleteMotion(id) { await tx('motions', 'readwrite', os => os.delete(id)); notify('motions'); },

    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
  };

  global.StudioLib = API;
})(window);


// ---- KSOL Designs credit badge (standalone tool pages only) ----
(function(){ try{
  if(window.top!==window.self) return;              // iframed under the Studio shell → shell menu brands it
  if(document.getElementById('frame')) return;      // this IS the Studio shell
  function add(){ if(document.getElementById('__ksolCredit')||!document.body) return;
    var d=document.createElement('div'); d.id='__ksolCredit';
    d.style.cssText='position:fixed;right:10px;bottom:8px;z-index:99999;font:11px/1.3 system-ui,sans-serif;color:#8b97a8;background:rgba(10,14,20,.6);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:4px 9px';
    d.innerHTML='◆ <b style="color:#c9d3e0">KSOL Designs</b> · <a href="https://www.ksoldesigns.com" target="_blank" rel="noopener" style="color:#5b8cff;text-decoration:none">ksoldesigns.com</a>';
    document.body.appendChild(d);
  }
  if(document.body) add(); else document.addEventListener('DOMContentLoaded', add);
}catch(e){} })();
