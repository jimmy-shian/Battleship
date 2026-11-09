/*!
 * 海戰棋 — 自訂下拉選單（含過度動畫）
 *
 * 把原生 <select> 換成會「動」的選單：
 *   - 觸發器 hover 變色、展開時陰影加深
 *   - 選項面板由上而下 scaleY 延展（transform-origin: top）
 *   - 箭頭旋轉 180°
 *   - 選項逐項淡入（stagger），關閉時反向收合
 *   - 點擊外部 / Esc 關閉，↑↓ 切換、Enter 選取
 *
 * 原生 <select> 仍留在 DOM 內並同步 value，既有程式（讀 .value、監聽 change）完全不受影響。
 */
export function enhanceSelect(sel, opts = {}) {
  if (!sel) return null;
  if (sel._cselect) return sel._cselect;

  const wrap = document.createElement("div");
  wrap.className = "cselect" + (opts.block ? " block" : "") + (opts.compact ? " compact" : "");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "sel-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const label = document.createElement("span");
  label.className = "sel-label";
  const arrow = document.createElement("span");
  arrow.className = "sel-arrow";
  arrow.setAttribute("aria-hidden", "true");
  trigger.append(label, arrow);

  const panel = document.createElement("div");
  panel.className = "sel-options";
  panel.setAttribute("role", "listbox");

  const items = [];
  let group = null;
  buildItems();

  sel.parentNode.insertBefore(wrap, sel);
  wrap.append(trigger, panel);
  sel.classList.add("cselect-native");
  sel.setAttribute("tabindex", "-1");

  const api = {
    el: wrap,
    trigger,
    panel,
    items,
    value: () => sel.value,
    refresh,
    open,
    close,
    destroy
  };
  sel._cselect = api;

  /** 依 sel.options 重建選項清單（原生 <option> 動態變更用） */
  function buildItems() {
    items.splice(0).forEach((it) => it.remove());
    let g = null;
    for (const o of Array.from(sel.options)) {
      if (o.parentElement && o.parentElement.tagName === "OPTGROUP") {
        if (g !== o.parentElement) {
          g = o.parentElement;
          const gg = document.createElement("div");
          gg.className = "sel-group";
          gg.textContent = g.label;
          panel.appendChild(gg);
        }
      }
      const item = document.createElement("div");
      item.className = "sel-option";
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.dataset.value = o.value;
      item.textContent = o.textContent;
      item.addEventListener("click", () => choose(item.dataset.value));
      panel.appendChild(item);
      items.push(item);
    }
  }

  function syncItems() {
    const opts = Array.from(sel.options);
    const stale =
      opts.length !== items.length ||
      opts.some((o, i) => !items[i] || items[i].dataset.value !== o.value);
    if (stale) buildItems();
  }

  /* ---------- 狀態同步 ---------- */

  function refresh() {
    syncItems();
    const cur = sel.value;
    const opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : "";
    items.forEach((it) => {
      const on = it.dataset.value === cur;
      it.classList.toggle("on", on);
      it.setAttribute("aria-selected", on ? "true" : "false");
    });
    trigger.disabled = !!sel.disabled;
    wrap.classList.toggle("disabled", !!sel.disabled);
  }

  function open() {
    if (sel.disabled) return;
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    const idx = Math.max(0, items.findIndex((it) => it.dataset.value === sel.value));
    const cur = items[idx];
    if (cur) {
      cur.focus({ preventScroll: true });
      const r = cur.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      if (r.bottom > pr.bottom) panel.scrollTop += r.bottom - pr.bottom;
      if (r.top < pr.top) panel.scrollTop -= pr.top - r.top;
    }
  }

  function close() {
    if (!wrap.classList.contains("open")) return;
    wrap.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
  }

  function toggle() {
    wrap.classList.contains("open") ? close() : open();
  }

  function choose(value) {
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    refresh();
    close();
    trigger.focus({ preventScroll: true });
  }

  function destroy() {
    close();
    wrap.remove();
    sel.classList.remove("cselect-native");
    sel.removeAttribute("tabindex");
    delete sel._cselect;
  }

  /* ---------- 事件 ---------- */

  // 任何方式改動原生 select 的值（含程式設定 / 自訂點選）都同步外觀
  sel.addEventListener("change", () => { refresh(); });

  trigger.addEventListener("click", (e) => {
    e.preventDefault(); // 避免 label 轉發原生 select 的焦點
    toggle();
  });

  items.forEach((it) => {
    it.addEventListener("click", () => choose(it.dataset.value));
  });

  panel.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (items[Math.min(items.length - 1, i + 1)] || items[0]).focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (items[Math.max(0, i - 1)] || items[0]).focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0] && items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1] && items[items.length - 1].focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (i >= 0) choose(items[i].dataset.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      trigger.focus({ preventScroll: true });
    } else if (e.key === "Tab") {
      close();
    }
  });

  document.addEventListener("pointerdown", (e) => {
    if (!wrap.classList.contains("open")) return;
    if (wrap.contains(e.target)) return;
    close();
  });

  // 原生 select 的 disabled 屬性變動時同步
  if (window.MutationObserver) {
    new MutationObserver(() => {
      trigger.disabled = !!sel.disabled;
      wrap.classList.toggle("disabled", !!sel.disabled);
      if (sel.disabled) close();
    }).observe(sel, { attributes: true, attributeFilter: ["disabled"] });
  }

  refresh();
  return api;
}

/** 批次增強頁面上的所有 select */
export function enhanceAll(root = document, opts = {}) {
  const out = [];
  root.querySelectorAll("select").forEach((s) => out.push(enhanceSelect(s, opts)));
  return out;
}
