"use strict";
/* Factures BO : app de gestion des factures, tickets et remboursements de frais.
   Données : Supabase (Postgres + stockage privé). Lecture des tickets : fonction serveur « read-receipt ». */

/* ---------- constantes ---------- */
const CFG = window.BO_CONFIG;
const METHODS = [
  {id:"cb_pro", label:"CB pro", perso:false},
  {id:"virement", label:"Virement pro", perso:false},
  {id:"prelevement", label:"Prélèvement", perso:false},
  {id:"cheque", label:"Chèque pro", perso:false},
  {id:"especes_pro", label:"Espèces (caisse)", perso:false},
  {id:"cb_perso", label:"CB perso", perso:true},
  {id:"especes_perso", label:"Espèces perso", perso:true},
  {id:"virement_perso", label:"Virement ou chèque perso", perso:true},
];
const DEFAULT_CATS = ["Fournitures & petit matériel","Matériel & équipement","Logiciels & abonnements","Déplacements & transport","Carburant & péage","Repas & réceptions","Hébergement","Marchandises & stock","Sous-traitance & prestations","Télécom & internet","Loyer & charges","Assurances","Frais bancaires","Marketing & publicité","Formation","Autre"];
const DEFAULT_SETTINGS = {partners:[{id:"a1",name:"Associé 1",email:""},{id:"a2",name:"Associé 2",email:""}], categories:DEFAULT_CATS, cards:[]};
const COMPANY = "societe";
const MONTHS = ["janv.","févr.","mars","avr.","mai","juin","juil.","août","sept.","oct.","nov.","déc."];

/* ---------- état ---------- */
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
const S = {
  user:null, email:"", ready:false, invoices:[], settings:structuredClone(DEFAULT_SETTINGS),
  filter:{q:"", month:"", cat:"", payer:"", state:"all"},
  queue:[], formOpen:false, reimbSel:new Set(), year:new Date().getFullYear(),
  urls:new Map(), channel:null,
};

/* ---------- utilitaires ---------- */
const $ = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const eurF = new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"});
const eur = n => (n == null || isNaN(n)) ? "—" : eurF.format(n);
const fdate = d => d ? new Date(d + "T12:00:00").toLocaleDateString("fr-FR",{day:"2-digit",month:"short",year:"numeric"}) : "Sans date";
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const num = v => { if (v == null || v === "") return null; const n = parseFloat(String(v).replace(/\s/g,"").replace(",",".")); return isNaN(n) ? null : Math.round(n*100)/100; };
const method = id => METHODS.find(m => m.id === id);
const isPerso = inv => !!method(inv.method)?.perso;
const reimbState = inv => !isPerso(inv) ? null : (inv.reimb?.status === "rembourse" ? "rembourse" : "du");
const partnerName = id => id === COMPANY ? "Société" : (S.settings.partners.find(p => p.id === id)?.name || "—");
const myPartner = () => S.settings.partners.find(p => p.email && p.email.toLowerCase() === S.email.toLowerCase());
const sum = arr => Math.round(arr.reduce((a,b) => a + (b.ttc || 0), 0)*100)/100;
const newId = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const fmtNum = n => n == null ? "" : String(n).replace(".",",");

function toast(msg){
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role","status");
  document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
}

/* ---------- conversion base de données <-> app ---------- */
function fromRow(r){
  const n = v => v == null ? null : Number(v);
  return {
    id:r.id, supplier:r.supplier || "", date:r.date || "", ttc:n(r.ttc), tva:n(r.tva), ht:n(r.ht),
    category:r.category || "", description:r.description || "", payer:r.payer || "", method:r.method || "cb_pro",
    paid:r.paid !== false, dueDate:r.due_date || "", number:r.number || "", notes:r.notes || "",
    reimb: r.reimb_status ? {status:r.reimb_status, date:r.reimb_date || ""} : null,
    file: r.file_path ? {path:r.file_path, type:r.file_type, name:r.file_name || "", thumb:r.thumb_path || null} : null,
    createdAt:r.created_at,
  };
}
function toRow(d){
  return {
    supplier:d.supplier, date:d.date || null, ttc:d.ttc, tva:d.tva, ht:d.ht, category:d.category, description:d.description,
    payer:d.payer, method:d.method, paid:d.paid, due_date:d.dueDate || null, number:d.number, notes:d.notes,
    reimb_status:d.reimb ? d.reimb.status : null, reimb_date:d.reimb?.date || null,
    file_path:d.file?.path || null, file_type:d.file?.type || null, file_name:d.file?.name || null, thumb_path:d.file?.thumb || null,
    updated_at:new Date().toISOString(),
  };
}

/* ---------- liens signés vers les justificatifs (stockage privé) ---------- */
async function ensureUrls(paths){
  const now = Date.now();
  const need = [...new Set(paths.filter(p => p && !(S.urls.get(p)?.exp > now + 6e4)))];
  if (!need.length) return false;
  for (let i = 0; i < need.length; i += 100){
    const {data} = await sb.storage.from(CFG.bucket).createSignedUrls(need.slice(i, i+100), 3600);
    (data || []).forEach(x => { if (x.signedUrl) S.urls.set(x.path, {url:x.signedUrl, exp:now + 3500e3}); });
  }
  return true;
}
const urlFor = p => S.urls.get(p)?.url || "";
async function refreshThumbs(){
  const changed = await ensureUrls(S.invoices.map(i => i.file?.thumb || (i.file?.type === "image" ? i.file.path : null)));
  if (changed && !S.formOpen) render();
}

/* ---------- connexion ---------- */
function showAuth(mode, note){
  $("#app").hidden = true; const a = $("#auth"); a.hidden = false;
  if (mode === "denied"){
    a.innerHTML = `<div class="auth"><div class="auth-card"><h1>Factures BO</h1>
      <p>Le compte <b>${esc(S.email)}</b> n'est pas autorisé à voir les factures.</p>
      <p>Ajoutez cette adresse dans la table « members » de Supabase (voir le guide), puis reconnectez-vous.</p>
      <button class="btn" type="button" id="aOut">Se déconnecter</button></div></div>`;
    $("#aOut").onclick = () => sb.auth.signOut();
    return;
  }
  if (mode === "newpass"){
    a.innerHTML = `<div class="auth"><form class="auth-card" id="aForm"><h1>Nouveau mot de passe</h1>
      <label>Mot de passe<input class="field" type="password" id="aPass" autocomplete="new-password" minlength="8" required></label>
      <div class="err" id="aErr"></div>
      <button class="btn primary" type="submit">Enregistrer</button></form></div>`;
    $("#aForm").onsubmit = async e => {
      e.preventDefault();
      const {error} = await sb.auth.updateUser({password:$("#aPass").value});
      if (error) $("#aErr").textContent = "Mot de passe refusé : 8 caractères minimum.";
      else { toast("Mot de passe modifié"); start(); }
    };
    return;
  }
  a.innerHTML = `<div class="auth"><form class="auth-card" id="aForm" novalidate><h1>Factures BO</h1>
    <p>Connectez-vous pour voir et ajouter les factures.</p>
    <label>E-mail<input class="field" type="email" id="aMail" autocomplete="username" required></label>
    <label>Mot de passe<input class="field" type="password" id="aPass" autocomplete="current-password" required></label>
    <div class="${note?.ok ? "ok" : "err"}" id="aErr">${esc(note?.text || "")}</div>
    <button class="btn primary" type="submit" id="aBtn">Se connecter</button>
    <button class="linkbtn" type="button" id="aForgot">Mot de passe oublié ?</button></form></div>`;
  $("#aForm").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#aBtn"); btn.disabled = true; btn.textContent = "Connexion…";
    const {error} = await sb.auth.signInWithPassword({email:$("#aMail").value.trim(), password:$("#aPass").value});
    if (error){ btn.disabled = false; btn.textContent = "Se connecter"; $("#aErr").className = "err"; $("#aErr").textContent = /invalid/i.test(error.message) ? "E-mail ou mot de passe incorrect." : "Connexion impossible. Vérifiez votre réseau."; }
  };
  $("#aForgot").onclick = async () => {
    const email = $("#aMail").value.trim();
    if (!email){ $("#aErr").className = "err"; $("#aErr").textContent = "Indiquez d'abord votre e-mail."; return; }
    const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
    $("#aErr").className = error ? "err" : "ok";
    $("#aErr").textContent = error ? "Envoi impossible, réessayez dans une minute." : "Un lien pour choisir un nouveau mot de passe vient de vous être envoyé.";
  };
}

let started = false, startP = null;
function start(){ if (!startP) startP = doStart().finally(() => { startP = null; }); return startP; }
async function doStart(){
  const {data:{session}} = await sb.auth.getSession();
  if (!session){ started = false; showAuth("login"); return; }
  S.user = session.user; S.email = session.user.email || "";
  const {data:ok, error} = await sb.rpc("is_member");
  if (!error && !ok){ showAuth("denied"); return; }
  $("#auth").hidden = true; $("#app").hidden = false;
  if (started) return; started = true;
  render();
  await Promise.all([loadSettings(), loadInvoices()]);
  subscribe();
}
sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") { started = false; showAuth("newpass"); return; }
  if (event === "SIGNED_OUT"){ started = false; S.invoices = []; S.channel?.unsubscribe(); S.channel = null; showAuth("login"); return; }
  if (event === "SIGNED_IN" && !started) setTimeout(start, 0);
});
$("#logout").onclick = () => sb.auth.signOut();

async function loadSettings(){
  const {data} = await sb.from("settings").select("data").eq("id",1).maybeSingle();
  applySettings(data?.data);
}
function applySettings(d){
  S.settings = d && Object.keys(d).length ? {
    partners: d.partners?.length ? d.partners : DEFAULT_SETTINGS.partners,
    categories: d.categories?.length ? d.categories : DEFAULT_CATS,
    cards: d.cards || [],
  } : structuredClone(DEFAULT_SETTINGS);
  if (!S.formOpen) render();
}
async function loadInvoices(){
  const all = [];
  for (let from = 0; ; from += 1000){
    const {data, error} = await sb.from("invoices").select("*").order("date", {ascending:false}).range(from, from + 999);
    if (error){ toast("Chargement impossible. Vérifiez votre connexion."); break; }
    all.push(...data); if (data.length < 1000) break;
  }
  S.invoices = all.map(fromRow); S.ready = true;
  render(); refreshThumbs();
}
function subscribe(){
  S.channel = sb.channel("bo-db")
    .on("postgres_changes", {event:"*", schema:"public", table:"invoices"}, p => {
      if (p.eventType === "DELETE") S.invoices = S.invoices.filter(i => i.id !== p.old.id);
      else { const inv = fromRow(p.new); const ix = S.invoices.findIndex(i => i.id === inv.id); if (ix >= 0) S.invoices[ix] = inv; else S.invoices.push(inv); }
      if (!S.formOpen) render(); refreshThumbs();
    })
    .on("postgres_changes", {event:"*", schema:"public", table:"settings"}, p => applySettings(p.new?.data))
    .subscribe();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && started){ loadInvoices(); loadSettings(); } });
addEventListener("online", () => { $(".offline")?.remove(); if (started) loadInvoices(); });
addEventListener("offline", () => { if (!$(".offline")){ const o = document.createElement("div"); o.className = "offline"; o.textContent = "Hors connexion"; document.body.appendChild(o); } });

/* ---------- navigation ---------- */
const TABS = ["factures","remboursements","synthese","reglages"];
const tab = () => { const h = location.hash.slice(1); return TABS.includes(h) ? h : "factures"; };
addEventListener("hashchange", () => { if (started) render(); });

/* ---------- affichage ---------- */
function render(){
  if ($("#app").hidden) return;
  const t = tab();
  document.querySelectorAll("nav.tabs a").forEach(a => { if (a.dataset.tab === t) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current"); });
  const me = myPartner();
  $("#who").textContent = me ? me.name : S.email;
  $("#sub").textContent = !S.ready ? "Chargement…" : `${S.invoices.length} justificatif${S.invoices.length > 1 ? "s" : ""}`;
  const v = $("#view");
  if (t === "factures") v.innerHTML = viewList();
  else if (t === "remboursements") v.innerHTML = viewReimb();
  else if (t === "synthese") v.innerHTML = viewStats();
  else v.innerHTML = viewSettings();
  bindView(t);
}

function filtered(){
  const f = S.filter, q = f.q.trim().toLowerCase();
  return S.invoices.filter(i => {
    if (f.month && (i.date || "").slice(0,7) !== f.month) return false;
    if (f.cat && i.category !== f.cat) return false;
    if (f.payer && i.payer !== f.payer) return false;
    if (f.state === "du" && reimbState(i) !== "du") return false;
    if (f.state === "apayer" && i.paid !== false) return false;
    if (f.state === "perso" && !isPerso(i)) return false;
    if (q && !`${i.supplier} ${i.description} ${i.category} ${i.number} ${i.notes} ${partnerName(i.payer)}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function thumbHtml(i){
  const p = i.file?.thumb || (i.file?.type === "image" ? i.file.path : null);
  if (p && urlFor(p)) return `<img class="thumb" alt="" loading="lazy" src="${esc(urlFor(p))}">`;
  if (i.file?.type === "pdf") return `<div class="thumb">PDF</div>`;
  return `<div class="thumb">${i.file ? "…" : "—"}</div>`;
}

function rowHtml(i){
  const r = reimbState(i), pills = [];
  if (r === "du") pills.push(`<span class="pill warn">À rembourser</span>`);
  if (r === "rembourse") pills.push(`<span class="pill ok">Remboursé</span>`);
  if (i.paid === false) pills.push(`<span class="pill danger">À payer${i.dueDate ? " · " + esc(fdate(i.dueDate).replace(/ \d{4}$/,"")) : ""}</span>`);
  if (!pills.length) pills.push(`<span class="pill neutral">${esc(method(i.method)?.label || "—")}</span>`);
  return `<button class="row" type="button" data-open="${esc(i.id)}">
    ${thumbHtml(i)}
    <span class="t"><b>${esc(i.supplier || "Fournisseur inconnu")}</b>
      <small>${esc(fdate(i.date))} · ${esc(i.category || "Sans catégorie")}</small>
      <small>${esc(partnerName(i.payer))} · ${esc(method(i.method)?.label || "")}${i.description ? " · " + esc(i.description) : ""}</small></span>
    <span class="r"><span class="amt">${eur(i.ttc)}</span><span class="tags">${pills.join("")}</span></span>
  </button>`;
}

const spinner = `<div class="empty"><div class="spin" style="margin:0 auto"></div></div>`;
const monthLabel = m => { const [y,mm] = m.split("-"); return `${MONTHS[+mm-1]} ${y}`; };

function viewList(){
  if (!S.ready) return spinner;
  const all = S.invoices, list = filtered(), f = S.filter;
  const due = all.filter(i => reimbState(i) === "du"), unpaid = all.filter(i => i.paid === false);
  const months = [...new Set(all.map(i => (i.date || "").slice(0,7)).filter(Boolean))].sort().reverse();
  let out = `<div class="summary">
    <div class="stat"><small>${f.month ? esc(monthLabel(f.month)) : "Affiché"}</small><b>${eur(sum(list))}</b></div>
    <div class="stat warn"><small>À rembourser</small><b>${eur(sum(due))}</b></div>
    <div class="stat danger"><small>À payer</small><b>${eur(sum(unpaid))}</b></div>
  </div>
  <div class="filters">
    <input type="search" id="fq" placeholder="Rechercher un fournisseur, une note…" value="${esc(f.q)}" aria-label="Rechercher">
    <select id="fmonth" aria-label="Mois"><option value="">Tous les mois</option>${months.map(m => `<option value="${m}" ${f.month === m ? "selected" : ""}>${monthLabel(m)}</option>`).join("")}</select>
    <select id="fcat" aria-label="Catégorie"><option value="">Toutes catégories</option>${S.settings.categories.map(c => `<option ${f.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
    <select id="fpayer" aria-label="Payé par"><option value="">Tous payeurs</option>${S.settings.partners.map(p => `<option value="${esc(p.id)}" ${f.payer === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}<option value="${COMPANY}" ${f.payer === COMPANY ? "selected" : ""}>Société</option></select>
  </div>
  <div class="chips" role="group" aria-label="État">
    ${[["all","Toutes"],["du","À rembourser"],["apayer","À payer"],["perso","Payées perso"]].map(([k,l]) => `<button class="chip" type="button" data-state="${k}" aria-pressed="${f.state === k}">${l}</button>`).join("")}
    <button class="chip" type="button" id="exportCsv">Exporter en CSV</button>
  </div>`;
  if (!all.length){
    return out + `<div class="empty"><div class="receipt"></div><h3>Aucune facture pour l'instant</h3>
      <p>Touchez le bouton appareil photo en bas pour photographier un ticket de caisse. Montant, date, fournisseur et catégorie sont remplis automatiquement. Sur ordinateur, glissez un PDF ou une image n'importe où sur la page.</p>
      <button class="btn primary" type="button" data-add>Ajouter une facture</button></div>`;
  }
  if (!list.length) return out + `<div class="empty"><h3>Rien ne correspond</h3><p>Changez les filtres ou la recherche.</p></div>`;
  let cur = null; out += `<div class="list">`;
  for (const i of list){
    const m = (i.date || "").slice(0,7) || "sans-date";
    if (m !== cur){
      cur = m;
      const inMonth = list.filter(x => ((x.date || "").slice(0,7) || "sans-date") === m);
      out += `<div class="month-h"><span>${m === "sans-date" ? "Sans date" : esc(monthLabel(m))}</span><span class="mono">${eur(sum(inMonth))}</span></div>`;
    }
    out += rowHtml(i);
  }
  return out + `</div>`;
}

function viewReimb(){
  if (!S.ready) return spinner;
  const perso = S.invoices.filter(isPerso);
  let out = `<div class="toolbar"><h2>Remboursements de frais</h2></div><div class="cards">`;
  for (const p of S.settings.partners){
    const mine = perso.filter(i => i.payer === p.id);
    const due = mine.filter(i => reimbState(i) === "du"), done = mine.filter(i => reimbState(i) === "rembourse");
    const d = sum(due);
    out += `<div class="pcard"><span class="n">${esc(p.name)}</span><small>La société lui doit</small>
      <span class="big ${d === 0 ? "zero" : ""}">${eur(d)}</span>
      <small>${due.length} dépense${due.length > 1 ? "s" : ""} en attente · ${eur(sum(done))} déjà remboursés</small></div>`;
  }
  out += `</div>`;
  const dueAll = perso.filter(i => reimbState(i) === "du").sort((a,b) => (a.date || "").localeCompare(b.date || ""));
  for (const id of [...S.reimbSel]) if (!dueAll.some(i => i.id === id)) S.reimbSel.delete(id);
  out += `<div class="block"><h2>En attente de remboursement</h2>`;
  if (!dueAll.length) out += `<p class="muted">Rien à rembourser. Les dépenses payées avec une carte ou des espèces personnelles apparaîtront ici.</p>`;
  else {
    for (const p of [...S.settings.partners, {id:COMPANY,name:"Autre"}]){
      const items = dueAll.filter(i => p.id === COMPANY ? !S.settings.partners.some(x => x.id === i.payer) : i.payer === p.id);
      if (!items.length) continue;
      out += `<div class="month-h"><span>${esc(p.name)}</span><span class="mono">${eur(sum(items))}</span></div>`;
      for (const i of items) out += `<label class="checkrow"><input type="checkbox" data-sel="${esc(i.id)}" ${S.reimbSel.has(i.id) ? "checked" : ""}>
        <span class="t"><b>${esc(i.supplier || "Fournisseur inconnu")}</b><small>${esc(fdate(i.date))} · ${esc(method(i.method)?.label)} · ${esc(i.category || "")}</small></span>
        <span class="amt">${eur(i.ttc)}</span></label>`;
    }
    const selSum = sum(dueAll.filter(i => S.reimbSel.has(i.id)));
    out += `<div class="actionbar">
      <button class="btn" type="button" id="selAll">${S.reimbSel.size === dueAll.length ? "Tout désélectionner" : "Tout sélectionner"}</button>
      <span class="grow">${S.reimbSel.size} sélectionnée${S.reimbSel.size > 1 ? "s" : ""} · <b class="mono">${eur(selSum)}</b></span>
      <input type="date" class="field" id="reimbDate" value="${today()}" aria-label="Date du remboursement">
      <button class="btn primary" type="button" id="markReimb" ${!S.reimbSel.size ? "disabled" : ""}>Marquer remboursé</button>
    </div>`;
  }
  out += `</div>`;
  const done = perso.filter(i => reimbState(i) === "rembourse");
  out += `<div class="block"><h2>Historique des remboursements</h2>`;
  if (!done.length) out += `<p class="muted">Aucun remboursement enregistré.</p>`;
  else {
    const groups = {};
    for (const i of done){ const k = (i.reimb?.date || "Sans date") + "|" + i.payer; (groups[k] ||= []).push(i); }
    for (const k of Object.keys(groups).sort().reverse()){
      const [d, p] = k.split("|"), items = groups[k];
      out += `<details class="hist"><summary><span>${esc(d === "Sans date" ? d : fdate(d))} · ${esc(partnerName(p))}</span><span class="amt mono">${eur(sum(items))}</span></summary>
        <ul>${items.map(i => `<li><span>${esc(i.supplier || "—")} · ${esc(fdate(i.date))}</span><span class="mono">${eur(i.ttc)}</span></li>`).join("")}</ul></details>`;
    }
  }
  return out + `</div>`;
}

function barRows(entries){
  const max = Math.max(1, ...entries.map(e => e[1]));
  return `<div class="bars">${entries.map(([l,v]) => `<div class="bar"><span class="lab" title="${esc(l)}">${esc(l)}</span><span class="track"><span class="fill" style="display:block;width:${(v/max*100).toFixed(1)}%"></span></span><span class="v">${eur(v)}</span></div>`).join("")}</div>`;
}

function viewStats(){
  if (!S.ready) return spinner;
  const years = [...new Set(S.invoices.map(i => +(i.date || "").slice(0,4)).filter(Boolean))];
  if (!years.includes(S.year)) years.push(S.year);
  years.sort((a,b) => b - a);
  const inYear = S.invoices.filter(i => (i.date || "").startsWith(String(S.year)));
  const byMonth = Array.from({length:12}, (_, m) => sum(inYear.filter(i => +i.date.slice(5,7) === m+1)));
  const maxM = Math.max(1, ...byMonth);
  const byCat = {}; for (const i of inYear){ const k = i.category || "Sans catégorie"; byCat[k] = (byCat[k] || 0) + (i.ttc || 0); }
  const byPayer = {}; for (const i of inYear){ const k = partnerName(i.payer) + " · " + (isPerso(i) ? "perso" : "pro"); byPayer[k] = (byPayer[k] || 0) + (i.ttc || 0); }
  const tva = Math.round(inYear.reduce((a,i) => a + (i.tva || 0), 0)*100)/100;
  let out = `<div class="toolbar"><h2>Synthèse ${S.year}</h2>
    <select class="field" id="yearSel" aria-label="Année">${years.map(y => `<option ${y === S.year ? "selected" : ""}>${y}</option>`).join("")}</select></div>
    <div class="summary">
      <div class="stat"><small>Total TTC</small><b>${eur(sum(inYear))}</b></div>
      <div class="stat"><small>TVA récupérable</small><b>${eur(tva)}</b></div>
      <div class="stat"><small>Justificatifs</small><b>${inYear.length}</b></div>
    </div>`;
  if (!inYear.length) return out + `<div class="empty"><h3>Pas encore de dépenses en ${S.year}</h3><p>La répartition par mois et par catégorie s'affichera ici.</p></div>`;
  out += `<div class="block"><h2>Par mois</h2><div class="months">${byMonth.map((v,m) => `<div class="m" title="${MONTHS[m]} : ${eur(v)}"><div class="col ${v ? "" : "zero"}" style="height:${(v/maxM*100).toFixed(1)}%"></div><small>${MONTHS[m].slice(0,3)}</small></div>`).join("")}</div></div>`;
  out += `<div class="block"><h2>Par catégorie</h2>${barRows(Object.entries(byCat).sort((a,b) => b[1]-a[1]))}</div>`;
  out += `<div class="block"><h2>Par payeur</h2>${barRows(Object.entries(byPayer).sort((a,b) => b[1]-a[1]))}</div>`;
  return out;
}

function viewSettings(){
  const s = S.settings;
  const partnerOpts = sel => s.partners.map(p => `<option value="${esc(p.id)}" ${sel === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  return `<div class="toolbar"><h2>Réglages</h2></div>
  <div class="block"><h2>Associés</h2><div class="set-grid">
    ${s.partners.map((p,ix) => `<div class="prow"><input class="field" id="pn-${ix}" value="${esc(p.name)}" aria-label="Nom de l'associé ${ix+1}">
      ${p.email && p.email.toLowerCase() === S.email.toLowerCase() ? `<span class="pill ok">C'est vous</span>` : `<button class="btn" type="button" data-me="${ix}">C'est moi</button>`}</div>`).join("")}
    <p class="hint">« C'est moi » relie votre compte (${esc(S.email)}) à un associé : vous serez proposé par défaut comme payeur quand vous ajoutez une facture.</p>
  </div></div>
  <div class="block"><h2>Cartes bancaires</h2><div class="set-grid">
    <p class="hint">Indiquez les 4 derniers chiffres de chaque carte. Quand ils apparaissent sur un ticket, l'app remplit automatiquement qui a payé et si c'est une carte pro ou perso.</p>
    ${s.cards.map((c,ix) => `<div class="cardrow">
      <input class="field mono" id="c4-${ix}" value="${esc(c.last4)}" inputmode="numeric" maxlength="4" placeholder="1234" aria-label="4 derniers chiffres">
      <select class="field who-sel" id="cp-${ix}" aria-label="Titulaire">${partnerOpts(c.partnerId)}</select>
      <select class="field type-sel" id="ct-${ix}" aria-label="Type de carte"><option value="cb_pro" ${c.method === "cb_pro" ? "selected" : ""}>Carte pro</option><option value="cb_perso" ${c.method === "cb_perso" ? "selected" : ""}>Carte perso</option></select>
      <button class="btn ghost" type="button" data-delcard="${ix}" aria-label="Retirer la carte">✕</button></div>`).join("")}
    <div><button class="btn" type="button" id="addCard">Ajouter une carte</button></div>
  </div></div>
  <div class="block"><h2>Catégories</h2>
    <label class="hint" for="catsTa">Une catégorie par ligne. La lecture automatique choisit parmi cette liste.</label>
    <textarea class="field" id="catsTa">${esc(s.categories.join("\n"))}</textarea>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
    <button class="btn" type="button" id="exportCsv2">Exporter toutes les factures (CSV)</button>
    <button class="btn primary" type="button" id="saveSettings">Enregistrer les réglages</button>
  </div>`;
}

/* ---------- événements des vues ---------- */
function bindView(t){
  const v = $("#view");
  v.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openForm(S.invoices.find(i => i.id === b.dataset.open)));
  v.querySelectorAll("[data-add]").forEach(b => b.onclick = openAddSheet);
  const ex = $("#exportCsv"); if (ex) ex.onclick = () => exportCsv(filtered());
  const ex2 = $("#exportCsv2"); if (ex2) ex2.onclick = () => exportCsv([...S.invoices].sort((a,b) => (a.date || "").localeCompare(b.date || "")));
  if (t === "factures"){
    const fq = $("#fq");
    if (fq){
      fq.oninput = () => { S.filter.q = fq.value; const pos = fq.selectionStart; render(); const n = $("#fq"); n.focus(); try{ n.setSelectionRange(pos,pos); }catch{} };
      $("#fmonth").onchange = e => { S.filter.month = e.target.value; render(); };
      $("#fcat").onchange = e => { S.filter.cat = e.target.value; render(); };
      $("#fpayer").onchange = e => { S.filter.payer = e.target.value; render(); };
      v.querySelectorAll("[data-state]").forEach(b => b.onclick = () => { S.filter.state = b.dataset.state; render(); });
    }
  }
  if (t === "remboursements"){
    v.querySelectorAll("[data-sel]").forEach(c => c.onchange = () => { c.checked ? S.reimbSel.add(c.dataset.sel) : S.reimbSel.delete(c.dataset.sel); render(); });
    const sa = $("#selAll"); if (sa) sa.onclick = () => {
      const due = S.invoices.filter(i => reimbState(i) === "du");
      if (S.reimbSel.size === due.length) S.reimbSel.clear(); else due.forEach(i => S.reimbSel.add(i.id));
      render();
    };
    const mk = $("#markReimb"); if (mk) mk.onclick = markReimbursed;
  }
  if (t === "synthese"){ const y = $("#yearSel"); if (y) y.onchange = () => { S.year = +y.value; render(); }; }
  if (t === "reglages"){
    v.querySelectorAll("[data-me]").forEach(b => b.onclick = () => {
      const s = readSettingsForm();
      s.partners.forEach((p,ix) => { if ((p.email || "").toLowerCase() === S.email.toLowerCase()) p.email = ""; if (ix === +b.dataset.me) p.email = S.email; });
      saveSettings(s);
    });
    v.querySelectorAll("[data-delcard]").forEach(b => b.onclick = () => { const s = readSettingsForm(); s.cards.splice(+b.dataset.delcard,1); S.settings = s; render(); });
    $("#addCard").onclick = () => { const s = readSettingsForm(); s.cards.push({last4:"",partnerId:s.partners[0].id,method:"cb_perso"}); S.settings = s; render(); };
    $("#saveSettings").onclick = () => saveSettings(readSettingsForm());
  }
}

function readSettingsForm(){
  const s = structuredClone(S.settings);
  s.partners.forEach((p,ix) => { const el = $("#pn-" + ix); if (el) p.name = el.value.trim() || `Associé ${ix+1}`; });
  s.cards = s.cards.map((c,ix) => ({last4:($("#c4-"+ix)?.value || "").replace(/\D/g,"").slice(-4), partnerId:$("#cp-"+ix)?.value || c.partnerId, method:$("#ct-"+ix)?.value || c.method}));
  const ta = $("#catsTa"); if (ta){ const cats = ta.value.split("\n").map(x => x.trim()).filter(Boolean); s.categories = cats.length ? [...new Set(cats)] : DEFAULT_CATS; }
  return s;
}
async function saveSettings(s){
  s.cards = s.cards.filter(c => c.last4.length === 4);
  const {error} = await sb.from("settings").upsert({id:1, data:s, updated_at:new Date().toISOString()});
  if (error) toast("Enregistrement impossible, réessayez.");
  else { S.settings = s; render(); toast("Réglages enregistrés"); }
}

async function markReimbursed(){
  const date = $("#reimbDate").value || today(), ids = [...S.reimbSel];
  const btn = $("#markReimb"); btn.disabled = true; btn.textContent = "Enregistrement…";
  const {error} = await sb.from("invoices").update({reimb_status:"rembourse", reimb_date:date, updated_at:new Date().toISOString()}).in("id", ids);
  if (error){ toast("Enregistrement impossible, réessayez."); btn.disabled = false; btn.textContent = "Marquer remboursé"; return; }
  S.invoices.forEach(i => { if (ids.includes(i.id)) i.reimb = {status:"rembourse", date}; });
  S.reimbSel.clear(); render();
  toast(`${ids.length} dépense${ids.length > 1 ? "s" : ""} marquée${ids.length > 1 ? "s" : ""} remboursée${ids.length > 1 ? "s" : ""}`);
}

/* ---------- ajout : photo, fichiers ---------- */
function closeLayer(){ $("#layer").innerHTML = ""; }
function openAddSheet(){
  $("#layer").innerHTML = `<div class="overlay" id="ov"><div class="sheet" role="dialog" aria-label="Ajouter une facture">
    <h3>Ajouter une facture</h3>
    <button class="opt" type="button" id="oCam"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span><b>Prendre en photo</b><small>Ticket de caisse ou facture papier</small></span></button>
    <button class="opt" type="button" id="oPick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M12 11v6M9 14l3 3 3-3"/></svg><span><b>Importer des fichiers</b><small>PDF ou images, plusieurs à la fois</small></span></button>
    <button class="opt" type="button" id="oMan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg><span><b>Saisir à la main</b><small>Sans justificatif</small></span></button>
    <button class="btn ghost" type="button" id="oCancel">Annuler</button>
  </div></div>`;
  $("#ov").onclick = e => { if (e.target.id === "ov") closeLayer(); };
  $("#oCancel").onclick = closeLayer;
  $("#oCam").onclick = () => { closeLayer(); $("#camInput").click(); };
  $("#oPick").onclick = () => { closeLayer(); $("#pickInput").click(); };
  $("#oMan").onclick = () => { closeLayer(); openForm(null); };
}
$("#scanBtn").onclick = openAddSheet;
for (const id of ["camInput","pickInput"]) $("#" + id).onchange = e => { const fs = [...e.target.files]; e.target.value = ""; queueFiles(fs); };

function queueFiles(files){
  files = files.filter(f => f.type === "application/pdf" || f.type.startsWith("image/") || /\.(pdf|jpe?g|png|webp|heic)$/i.test(f.name));
  if (!files.length) return toast("Formats acceptés : photo (JPEG, PNG) ou PDF.");
  S.queue.push(...files);
  if (!S.formOpen) nextInQueue();
}
function nextInQueue(){ const f = S.queue.shift(); if (f) openForm(null, f); }

let dragDepth = 0;
addEventListener("dragenter", e => { if (!started || ![...(e.dataTransfer?.types || [])].includes("Files")) return; dragDepth++; if (!$(".dropzone")){ const d = document.createElement("div"); d.className = "dropzone"; d.textContent = "Déposez vos factures ici"; document.body.appendChild(d); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0){ dragDepth = 0; $(".dropzone")?.remove(); } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; $(".dropzone")?.remove(); if (started && e.dataTransfer?.files?.length) queueFiles([...e.dataTransfer.files]); });

/* préparation des images et PDF */
async function loadImage(file){
  try { return await createImageBitmap(file, {imageOrientation:"from-image"}); } catch {}
  return await new Promise((res, rej) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("image")); im.src = u; });
}
async function toJpeg(src, maxSide, q){
  const w = src.width, h = src.height, k = Math.min(1, maxSide / Math.max(w, h)), cw = Math.round(w*k), ch = Math.round(h*k);
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0,0,cw,ch); x.drawImage(src, 0, 0, cw, ch);
  return await new Promise(r => c.toBlob(r, "image/jpeg", q));
}
let pdfjsP = null;
function loadPdfJs(){
  if (pdfjsP) return pdfjsP;
  pdfjsP = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/pdf-3.11.174.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); })
    .then(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker-3.11.174.min.js"; return window.pdfjsLib; });
  pdfjsP.catch(() => { pdfjsP = null; });
  return pdfjsP;
}
async function pdfPages(file, maxPages){
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const out = [];
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++){
    const page = await pdf.getPage(n), vp0 = page.getViewport({scale:1}), scale = Math.min(2.2, 1800 / Math.max(vp0.width, vp0.height));
    const vp = page.getViewport({scale}), c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0,0,c.width,c.height);
    await page.render({canvasContext:ctx, viewport:vp}).promise;
    out.push(await new Promise(r => c.toBlob(r, "image/jpeg", .85)));
  }
  return out;
}
async function prepareFile(file){
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf){
    let pages = []; try { pages = await pdfPages(file, 3); } catch {}
    let thumb = null; if (pages[0]) thumb = await toJpeg(await loadImage(pages[0]), 400, .75);
    return {kind:"pdf", upload:file, uploadType:"application/pdf", ext:"pdf", previews:pages, thumb, name:file.name};
  }
  const img = await loadImage(file);
  const jpg = await toJpeg(img, 2000, .85), thumb = await toJpeg(img, 400, .75);
  return {kind:"image", upload:jpg, uploadType:"image/jpeg", ext:"jpg", previews:[jpg], thumb, name:file.name};
}
async function uploadPrepared(p, id){
  const base = `${new Date().getFullYear()}/${id}`;
  const path = `${base}.${p.ext}`, thumbPath = p.thumb ? `${base}-mini.jpg` : null;
  const up = await sb.storage.from(CFG.bucket).upload(path, p.upload, {contentType:p.uploadType, upsert:true});
  if (up.error) throw up.error;
  if (thumbPath){ const t = await sb.storage.from(CFG.bucket).upload(thumbPath, p.thumb, {contentType:"image/jpeg", upsert:true}); if (t.error) console.warn(t.error); }
  return {path, type:p.kind, name:p.name, thumb:thumbPath};
}
const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(b); });

/* ---------- lecture automatique ---------- */
async function readReceipt(previews){
  const images = await Promise.all(previews.slice(0,3).map(async b => ({media_type:"image/jpeg", data:await blobToB64(b)})));
  const {data, error} = await sb.functions.invoke("read-receipt", {body:{images, categories:S.settings.categories}});
  if (error){
    const status = error.context?.status || 0;
    let body = null;
    try { body = await error.context?.json(); } catch {}
    let code = body?.error || (status === 404 || body?.code === "NOT_FOUND" ? "not_deployed" : status === 401 ? "session" : "error");
    if (error.name === "FunctionsFetchError" || error.name === "FunctionsRelayError") code = "unreachable";
    throw {code, status, detail:body?.detail || body?.message || error.message || ""};
  }
  return data;
}
function ocrErrorText(e){
  const c = e?.code, d = String(e?.detail || "");
  if (c === "not_deployed") return "La fonction de lecture n'est pas installée dans Supabase (étape 3 du guide : Edge Functions, nom « read-receipt »).";
  if (c === "unreachable") return "Le service de lecture ne répond pas : vérifiez votre réseau, et que la fonction « read-receipt » est bien déployée dans Supabase.";
  if (c === "session") return "Session expirée : déconnectez-vous puis reconnectez-vous.";
  if (c === "not_allowed") return "Votre compte n'est pas dans la liste des membres autorisés (table « members »).";
  if (c === "missing_api_key") return "La clé API Anthropic n'est pas configurée : ajoutez le secret ANTHROPIC_API_KEY dans Supabase (Edge Functions > Secrets).";
  if (c === "bad_api_key") return "La clé API Anthropic est refusée : vérifiez le secret ANTHROPIC_API_KEY dans Supabase.";
  if (c === "rate_limited") return "Trop de lectures d'affilée. Réessayez dans un moment.";
  if (c === "api_error" && /credit|balance|billing/i.test(d)) return "Plus de crédit sur le compte API Anthropic : ajoutez du crédit dans console.anthropic.com (Billing).";
  if (c === "api_error") return "Le service de lecture a renvoyé une erreur" + (d ? " : " + d.slice(0, 160) : ".");
  if (c === "refused" || c === "unreadable" || c === "no_image") return "La photo n'a pas pu être lue. Reprenez-la bien à plat, nette et éclairée.";
  return `Le ticket n'a pas pu être lu (${c || "erreur"}${e?.status ? " " + e.status : ""}${d ? " : " + d.slice(0, 120) : ""}).`;
}

/* ---------- fiche facture ---------- */
function openForm(inv, file){
  const isNew = !inv, me = myPartner();
  const d = inv ? structuredClone(inv) : {
    id:newId(), supplier:"", date:today(), ttc:null, ht:null, tva:null, category:"", description:"",
    payer: me ? me.id : S.settings.partners[0].id, method:"cb_pro", paid:true, dueDate:"", number:"", notes:"", reimb:null, file:null,
  };
  S.formOpen = true;
  const touched = new Set();
  let uploadP = null, dupConfirmed = false;
  const partnerSeg = () => [...S.settings.partners.map(p => [p.id, p.name]), [COMPANY,"Société"]].map(([id,n]) => `<button type="button" data-payer="${esc(id)}" aria-pressed="${d.payer === id}">${esc(n)}</button>`).join("");
  const cats = S.settings.categories.includes(d.category) || !d.category ? S.settings.categories : [...S.settings.categories, d.category];

  $("#layer").innerHTML = `<div class="overlay center" id="fov"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="ftitle">
    <div class="modal-h"><h2 id="ftitle">${isNew ? "Nouvelle facture" : esc(d.supplier || "Facture")}</h2><button class="btn ghost" type="button" id="fClose" aria-label="Fermer">✕</button></div>
    <div class="modal-b">
      <div>
        <div class="preview" id="fPrev">${d.file ? `<div class="ph"><span class="spin" style="display:inline-block"></span></div>` : `<div class="ph">Pas de justificatif</div>`}</div>
        <div id="fOcr"></div>
        ${S.queue.length ? `<p class="hint" style="margin-top:8px">${S.queue.length} autre${S.queue.length > 1 ? "s" : ""} fichier${S.queue.length > 1 ? "s" : ""} en attente après celui-ci.</p>` : ""}
      </div>
      <div class="form">
        <div class="dup" id="fDup" hidden></div>
        <label class="full">Fournisseur<input class="field" id="f-supplier" value="${esc(d.supplier)}" placeholder="Ex. Leroy Merlin" autocomplete="off"></label>
        <label>Date<input class="field" type="date" id="f-date" value="${esc(d.date)}"></label>
        <label>Montant TTC (€)<input class="field amt" id="f-ttc" inputmode="decimal" value="${fmtNum(d.ttc)}" placeholder="0,00"></label>
        <label>TVA (€)<input class="field amt" id="f-tva" inputmode="decimal" value="${fmtNum(d.tva)}" placeholder="0,00"></label>
        <label>Montant HT (€)<input class="field amt" id="f-ht" inputmode="decimal" value="${fmtNum(d.ht)}" placeholder="0,00"></label>
        <label class="full">Catégorie<select class="field" id="f-category"><option value="">Choisir…</option>${cats.map(c => `<option ${d.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label class="full">Description<input class="field" id="f-description" value="${esc(d.description)}" placeholder="Ce qui a été acheté"></label>
        <div class="section-t">Paiement</div>
        <label class="full">Payé par<div class="seg" id="f-payer">${partnerSeg()}</div></label>
        <label class="full">Moyen de paiement<select class="field" id="f-method">${METHODS.map(m => `<option value="${m.id}" ${d.method === m.id ? "selected" : ""}>${m.label}</option>`).join("")}</select></label>
        <label>Statut de la facture<select class="field" id="f-paid"><option value="1" ${d.paid !== false ? "selected" : ""}>Payée</option><option value="0" ${d.paid === false ? "selected" : ""}>À payer</option></select></label>
        <label id="dueWrap">Échéance<input class="field" type="date" id="f-due" value="${esc(d.dueDate || "")}"></label>
        <div class="full" id="reimbWrap" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
          <label>Remboursement<select class="field" id="f-reimb"><option value="du">À rembourser</option><option value="rembourse" ${d.reimb?.status === "rembourse" ? "selected" : ""}>Remboursé</option></select></label>
          <label id="rdWrap">Remboursé le<input class="field" type="date" id="f-rdate" value="${esc(d.reimb?.date || today())}"></label>
          <p class="hint" style="grid-column:1/-1;margin:0">Payée avec un moyen personnel : la société doit rembourser cette dépense à l'associé.</p>
        </div>
        <div class="section-t">Détails</div>
        <label>N° de facture<input class="field mono" id="f-number" value="${esc(d.number)}"></label>
        <label>Justificatif<span class="hint" style="padding-top:10px" id="fFileState">${d.file ? (d.file.type === "pdf" ? "PDF joint" : "Photo jointe") : (file ? "Envoi en cours…" : "Aucun")}</span></label>
        <label class="full">Notes<textarea class="field" id="f-notes" style="min-height:70px">${esc(d.notes)}</textarea></label>
      </div>
    </div>
    <div class="modal-f">
      <span class="msg" id="fMsg"></span>
      ${!isNew ? `<button class="btn danger" type="button" id="fDel">Supprimer</button>` : ""}
      <button class="btn" type="button" id="fCancel">Annuler</button>
      <button class="btn primary" type="button" id="fSave">${isNew ? "Enregistrer" : "Enregistrer les modifications"}</button>
    </div>
  </div></div>`;

  // aperçu d'un justificatif existant
  if (d.file){
    const showP = d.file.type === "pdf" ? d.file.thumb : d.file.path;
    ensureUrls([d.file.path, d.file.thumb]).then(() => {
      const prev = $("#fPrev"); if (!prev) return;
      const big = urlFor(d.file.path), small = showP ? urlFor(showP) : "";
      prev.innerHTML = d.file.type === "image"
        ? `<a href="${esc(big)}" target="_blank" rel="noopener"><img alt="Justificatif" src="${esc(big)}"></a>`
        : `<div class="ph">${small ? `<img alt="Première page" src="${esc(small)}" style="margin-bottom:10px">` : ""}<a class="btn" href="${esc(big)}" target="_blank" rel="noopener">Ouvrir le PDF</a></div>`;
    });
  }

  const F = id => $("#f-" + id);
  ["supplier","date","ttc","tva","ht","category","description","method","paid","due","number","notes"].forEach(k => { const el = F(k); if (el) el.addEventListener("input", () => touched.add(k)); });
  const syncVis = () => {
    const perso = !!method(F("method").value)?.perso;
    $("#reimbWrap").style.display = perso ? "grid" : "none";
    $("#rdWrap").style.visibility = F("reimb").value === "rembourse" ? "visible" : "hidden";
    $("#dueWrap").style.visibility = F("paid").value === "0" ? "visible" : "hidden";
  };
  const setPayer = id => { d.payer = id; $("#f-payer").querySelectorAll("[data-payer]").forEach(x => x.setAttribute("aria-pressed", x.dataset.payer === id)); };
  F("method").addEventListener("change", () => { touched.add("method"); syncVis(); });
  F("reimb").addEventListener("change", syncVis);
  F("paid").addEventListener("change", syncVis);
  syncVis();
  $("#f-payer").querySelectorAll("[data-payer]").forEach(b => b.onclick = () => {
    touched.add("payer"); setPayer(b.dataset.payer);
    if (d.payer === COMPANY && method(F("method").value)?.perso){ F("method").value = "prelevement"; syncVis(); }
  });
  const autoHt = () => { const t = num(F("ttc").value), v = num(F("tva").value); if (t != null && v != null && !touched.has("ht")) F("ht").value = fmtNum(Math.round((t-v)*100)/100); };
  F("ttc").addEventListener("change", autoHt); F("tva").addEventListener("change", autoHt);

  const msg = (t, err) => { const m = $("#fMsg"); if (m){ m.textContent = t || ""; m.classList.toggle("err", !!err); } };
  const close = () => { S.formOpen = false; closeLayer(); render(); setTimeout(nextInQueue, 50); };
  const cancel = () => {
    if (isNew && uploadP) uploadP.then(f => { if (f) sb.storage.from(CFG.bucket).remove([f.path, f.thumb].filter(Boolean)); }).catch(() => {});
    close();
  };
  $("#fClose").onclick = cancel; $("#fCancel").onclick = cancel;

  const ocrBox = (state, text) => { const o = $("#fOcr"); if (o) o.innerHTML = `<div class="ocr ${state}">${state === "" ? `<span class="spin"></span>` : ""}<span>${esc(text)}</span></div>`; };

  if (file){
    ocrBox("", "Préparation du justificatif…");
    const prepP = prepareFile(file);
    uploadP = prepP.then(async p => {
      const prev = $("#fPrev");
      if (prev) prev.innerHTML = p.previews[0] ? `<img alt="Aperçu du justificatif" src="${URL.createObjectURL(p.previews[0])}">` : `<div class="ph">PDF : ${esc(p.name)}</div>`;
      const f = await uploadPrepared(p, d.id);
      d.file = f; const st = $("#fFileState"); if (st) st.textContent = f.type === "pdf" ? "PDF joint" : "Photo jointe";
      return f;
    });
    uploadP.catch(() => { msg("Le justificatif n'a pas pu être envoyé. Vérifiez votre connexion, ou enregistrez sans.", true); const st = $("#fFileState"); if (st) st.textContent = "Échec de l'envoi"; });
    prepP.then(async p => {
      if (!p.previews.length){ ocrBox("fail", "Lecture automatique impossible pour ce fichier. Remplissez les champs."); return; }
      ocrBox("", "Lecture automatique en cours…");
      try {
        applyOcr(await readReceipt(p.previews));
        ocrBox("done", "Champs remplis automatiquement. Vérifiez avant d'enregistrer.");
      } catch (e) {
        const c = e?.code;
        ocrBox("fail", ocrErrorText(e) + " Remplissez les champs à la main.");
      }
    }).catch(() => ocrBox("fail", "Ce fichier n'a pas pu être ouvert. Essayez une photo JPEG ou un PDF."));
  }

  function applyOcr(r){
    if (!r || typeof r !== "object" || !$("#fov")) return;
    const setIf = (k, v) => { if (v == null || v === "" || touched.has(k)) return; const el = F(k); if (el) el.value = v; };
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    setIf("supplier", r.fournisseur);
    if (isDate(r.date)) setIf("date", r.date);
    const n = v => typeof v === "number" ? fmtNum(v) : null;
    setIf("ttc", n(r.montant_ttc)); setIf("tva", n(r.tva)); setIf("ht", n(r.montant_ht));
    if (r.montant_ht == null && typeof r.montant_ttc === "number" && typeof r.tva === "number" && !touched.has("ht")) F("ht").value = fmtNum(Math.round((r.montant_ttc - r.tva)*100)/100);
    if (S.settings.categories.includes(r.categorie)) setIf("category", r.categorie);
    setIf("description", r.description);
    setIf("number", r.numero);
    if (r.a_payer === true && !touched.has("paid")){ F("paid").value = "0"; if (isDate(r.echeance)) setIf("due", r.echeance); }
    const last4 = String(r.carte_4_derniers || "").replace(/\D/g,"").slice(-4);
    const card = last4.length === 4 && S.settings.cards.find(c => c.last4 === last4);
    if (card){
      if (!touched.has("method")) F("method").value = card.method;
      if (!touched.has("payer")) setPayer(card.partnerId);
    } else if (!touched.has("method")){
      const map = {virement:"virement", prelevement:"prelevement", cheque:"cheque"};
      if (map[r.moyen_paiement]) F("method").value = map[r.moyen_paiement];
      if (r.moyen_paiement === "prelevement" && !touched.has("payer")) setPayer(COMPANY);
    }
    syncVis();
  }

  const del = $("#fDel");
  if (del) del.onclick = async () => {
    if (del.dataset.armed !== "1"){ del.dataset.armed = "1"; del.textContent = "Confirmer la suppression"; msg("La facture et son justificatif seront supprimés définitivement.", true); return; }
    del.disabled = true;
    const {error} = await sb.from("invoices").delete().eq("id", d.id);
    if (error){ msg("Suppression impossible, réessayez.", true); del.disabled = false; return; }
    if (d.file) sb.storage.from(CFG.bucket).remove([d.file.path, d.file.thumb].filter(Boolean));
    S.invoices = S.invoices.filter(i => i.id !== d.id);
    toast("Facture supprimée"); close();
  };

  const save = $("#fSave");
  save.onclick = async () => {
    const data = {
      supplier:F("supplier").value.trim(), date:F("date").value || "", ttc:num(F("ttc").value), tva:num(F("tva").value), ht:num(F("ht").value),
      category:F("category").value, description:F("description").value.trim(), payer:d.payer, method:F("method").value,
      paid:F("paid").value !== "0", dueDate:F("paid").value === "0" ? (F("due").value || "") : "",
      number:F("number").value.trim(), notes:F("notes").value.trim(),
    };
    if (data.ttc == null){ msg("Indiquez le montant TTC.", true); F("ttc").focus(); return; }
    if (method(data.method)?.perso && data.payer === COMPANY){ msg("Une dépense payée avec un moyen perso doit être rattachée à un associé.", true); return; }
    data.reimb = method(data.method)?.perso ? {status:F("reimb").value, date:F("reimb").value === "rembourse" ? (F("rdate").value || today()) : ""} : null;
    if (isNew && !dupConfirmed){
      const dup = S.invoices.find(i => i.ttc === data.ttc && i.date === data.date && (!data.supplier || !i.supplier || i.supplier.toLowerCase().slice(0,5) === data.supplier.toLowerCase().slice(0,5)));
      if (dup){ const b = $("#fDup"); b.hidden = false; b.textContent = `Une facture identique existe peut-être déjà : ${dup.supplier || "sans fournisseur"}, ${eur(dup.ttc)} le ${fdate(dup.date)}. Touchez à nouveau Enregistrer pour l'ajouter quand même.`; dupConfirmed = true; return; }
    }
    save.disabled = true; save.textContent = "Enregistrement…";
    if (uploadP){ msg("Envoi du justificatif…"); try { await uploadP; } catch {} }
    data.file = d.file || null;
    const row = toRow(data);
    const res = isNew ? await sb.from("invoices").insert({id:d.id, ...row}).select().single()
                      : await sb.from("invoices").update(row).eq("id", d.id).select().single();
    if (res.error){
      save.disabled = false; save.textContent = "Enregistrer";
      msg(navigator.onLine ? "Enregistrement impossible, réessayez." : "Pas de connexion : réessayez quand le réseau revient.", true);
      return;
    }
    const saved = fromRow(res.data), ix = S.invoices.findIndex(i => i.id === saved.id);
    if (ix >= 0) S.invoices[ix] = saved; else S.invoices.push(saved);
    toast(isNew ? "Facture enregistrée" : "Modifications enregistrées");
    close(); refreshThumbs();
  };
}

/* ---------- export CSV (pour le comptable) ---------- */
async function exportCsv(list){
  if (!list.length) return toast("Aucune facture à exporter.");
  const n = v => v == null ? "" : String(v).replace(".",",");
  const cell = v => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const head = ["Date","Fournisseur","Description","Catégorie","Montant TTC","TVA","Montant HT","Payé par","Moyen de paiement","Statut","Échéance","Remboursement","Remboursé le","N° facture","Justificatif","Notes"];
  const rows = list.map(i => [i.date, i.supplier, i.description, i.category, n(i.ttc), n(i.tva), n(i.ht), partnerName(i.payer), method(i.method)?.label || "", i.paid === false ? "À payer" : "Payée", i.dueDate || "",
    reimbState(i) === "du" ? "À rembourser" : reimbState(i) === "rembourse" ? "Remboursé" : "", i.reimb?.date || "", i.number, i.file ? (i.file.type === "pdf" ? "PDF" : "Photo") : "Non", i.notes].map(cell).join(";"));
  const csv = "﻿" + [head.join(";"), ...rows].join("\r\n");
  const name = `factures-bo-${today()}.csv`;
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const fileObj = new File([blob], name, {type:"text/csv"});
  if (navigator.canShare?.({files:[fileObj]}) && /iPhone|iPad|Android/i.test(navigator.userAgent)){
    try { await navigator.share({files:[fileObj], title:name}); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- démarrage ---------- */
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
start();
