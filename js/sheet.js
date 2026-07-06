// ============================================================================
//  sheet.js — reusable bottom-sheet edit form, driven by a field schema.
//  Header: Cancel · title · Save.  Quiet delete at the foot (edits only).
//  A `typeField` segmented control reshapes which fields show.
//  A live-impact slot re-renders on every edit.
// ============================================================================
import { saveRow, deleteRow } from "./store.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const fmtGBP = (n) =>
  "£" + Math.round(Number(n) || 0).toLocaleString("en-GB");
export const fmtMonth = (ym) => {
  if (!ym) return "—";
  const [y, m] = ym.split("-");
  return `${MONTHS[(+m || 1) - 1]} ${y}`;
};

let host = null;
function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "sheet-host";
  document.body.appendChild(host);
  return host;
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

// ---- one field → DOM, wired to the draft object ---------------------------
function renderField(f, draft, onChange) {
  const wrap = el("label", "fld");
  if (f.type !== "toggle") wrap.appendChild(el("span", "fld-label", f.label));
  let input;

  const setVal = (v) => { draft[f.key] = v; onChange(); };

  switch (f.type) {
    case "textarea":
      input = el("textarea", "field");
      input.rows = 2;
      input.value = draft[f.key] ?? "";
      input.oninput = () => setVal(input.value || null);
      break;

    case "money":
    case "number":
    case "percent": {
      input = el("input", "field");
      input.type = "number";
      input.inputMode = "decimal";
      if (f.step) input.step = f.step;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      const scale = f.type === "percent" ? 100 : 1;
      const cur = draft[f.key];
      input.value = cur == null || cur === "" ? "" : +(cur * scale).toFixed(6);
      input.oninput = () => {
        const raw = input.value;
        setVal(raw === "" ? (f.type === "percent" ? null : 0) : Number(raw) / scale);
      };
      break;
    }

    case "month":
      input = el("input", "field");
      input.type = "month";
      input.value = draft[f.key] ?? "";
      input.oninput = () => setVal(input.value || null);
      break;

    case "select": {
      input = el("select", "field");
      const opts = typeof f.options === "function" ? f.options() : f.options;
      if (f.placeholder) input.appendChild(new Option(f.placeholder, ""));
      for (const o of opts) input.appendChild(new Option(o.label, o.value));
      input.value = draft[f.key] ?? "";
      input.onchange = () => setVal(input.value || null);
      break;
    }

    case "segmented": {
      input = el("div", "segmented");
      const opts = typeof f.options === "function" ? f.options() : f.options;
      for (const o of opts) {
        const b = el("button", "seg" + (draft[f.key] === o.value ? " on" : ""), o.label);
        b.type = "button";
        b.onclick = () => {
          draft[f.key] = o.value;
          input.querySelectorAll(".seg").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          onChange();
        };
        input.appendChild(b);
      }
      break;
    }

    case "toggle": {
      wrap.className = "fld fld-row";
      wrap.appendChild(el("span", "fld-label", f.label));
      input = el("button", "toggle" + (draft[f.key] ? " on" : ""));
      input.type = "button";
      input.innerHTML = "<span class='knob'></span>";
      input.onclick = () => {
        draft[f.key] = !draft[f.key];
        input.classList.toggle("on", draft[f.key]);
        onChange();
      };
      break;
    }

    default: // text
      input = el("input", "field");
      input.type = "text";
      input.value = draft[f.key] ?? "";
      if (f.placeholder) input.placeholder = f.placeholder;
      input.oninput = () => setVal(input.value || null);
  }

  wrap.appendChild(input);
  if (f.help) wrap.appendChild(el("span", "fld-help", f.help));
  return wrap;
}

// ---- open a sheet ----------------------------------------------------------
// cfg: { title, table, fields, record, typeField?, impact?(draft), onDone() }
export function openSheet(cfg) {
  const h = ensureHost();
  const draft = { ...cfg.record };
  const isEdit = !!draft.id;

  const overlay = el("div", "sheet-overlay");
  const panel = el("div", "sheet glass");
  overlay.appendChild(panel);

  const close = () => {
    overlay.classList.remove("in");
    setTimeout(() => overlay.remove(), 240);
  };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  // header
  const head = el("div", "sheet-head");
  const cancel = el("button", "sheet-txtbtn", "Cancel");
  cancel.onclick = close;
  const save = el("button", "sheet-txtbtn primary", isEdit ? "Save" : "Add");
  head.append(cancel, el("div", "sheet-title", cfg.title), save);
  panel.appendChild(head);

  // body (fields re-render when a typeField changes)
  const body = el("div", "sheet-body");
  const impactBox = el("div", "impact");
  panel.append(body, impactBox);

  const refreshImpact = () => {
    const txt = cfg.impact ? cfg.impact(draft) : null;
    impactBox.innerHTML = txt
      ? `<i data-lucide="activity"></i><span>${txt}</span>`
      : "";
    impactBox.style.display = txt ? "flex" : "none";
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
  };

  const renderBody = () => {
    body.innerHTML = "";
    for (const f of cfg.fields) {
      if (f.showIf && !f.showIf(draft)) continue;
      const node = renderField(f, draft, () => {
        if (cfg.typeField && f.key === cfg.typeField) renderBody();
        refreshImpact();
      });
      body.appendChild(node);
    }
    if (isEdit) {
      const del = el("button", "sheet-delete", "Delete");
      del.onclick = async () => {
        if (!confirm("Delete this? This can't be undone.")) return;
        try { await deleteRow(cfg.table, draft.id); close(); cfg.onDone && cfg.onDone(); }
        catch (err) { alert("Delete failed: " + err.message); }
      };
      body.appendChild(del);
    }
    refreshImpact();
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
  };
  renderBody();

  save.onclick = async () => {
    // strip fields hidden by the current type before writing
    const clean = {};
    if (isEdit) clean.id = draft.id;
    for (const f of cfg.fields) {
      if (f.showIf && !f.showIf(draft)) continue;
      clean[f.key] = draft[f.key] ?? null;
    }
    if (cfg.derive) Object.assign(clean, cfg.derive(clean));
    save.disabled = true; save.textContent = "Saving…";
    try {
      await saveRow(cfg.table, clean);
      close(); cfg.onDone && cfg.onDone();
    } catch (err) {
      save.disabled = false; save.textContent = isEdit ? "Save" : "Add";
      alert("Save failed: " + err.message);
    }
  };

  h.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("in"));
}
