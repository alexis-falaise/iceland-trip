export const DEFAULT_PACK_ITEMS = [
  "Thermals (merino wool base layers)",
  "Warm mid-layer (fleece/wool sweater)",
  "Waterproof jacket (windproof)",
  "Waterproof pants (essential for waterfalls)",
  "Waterproof hiking boots",
  "Microspikes/Crampons",
  "Warm beanie hat & scarf/buff",
  "Waterproof gloves",
  "Swimsuit & quick-dry towel",
  "Power bank for phones",
  "Lip balm & moisturizer",
  "Headlamp (for campsites)"
];

export function sanitizePackItems(rawItems, fallbackItems = DEFAULT_PACK_ITEMS) {
  if (!Array.isArray(rawItems)) {
    return fallbackItems.map((text, index) => ({
      id: index + 1,
      text,
      done: false
    }));
  }

  let fallbackId = 1;
  const items = rawItems
    .filter((item) => item && (typeof item.text === "string" || typeof item.label === "string"))
    .map((item) => {
      const text = String(item.text ?? item.label).trim().slice(0, 100);
      const rawId = Number(item.id);
      const id = Number.isFinite(rawId) && rawId > 0 ? rawId : fallbackId++;
      return {
        id,
        text,
        done: Boolean(item.done ?? item.checked)
      };
    })
    .filter((item) => item.text.length > 0);

  if (items.length) {
    return items;
  }

  return fallbackItems.map((text, index) => ({
    id: index + 1,
    text,
    done: false
  }));
}

function computeNextPackId(items) {
  return Array.isArray(items) && items.length
    ? Math.max(...items.map((item) => Number(item.id) || 0)) + 1
    : 1;
}

export function createPackingFeature(options) {
  const {
    listEl,
    progressEl,
    progressLabelEl,
    progressPctEl,
    addItemFormEl,
    newItemInputEl,
    getItems,
    actions,
    onPersist
  } = options;

  const getCurrentItems =
    typeof getItems === "function" ? getItems : () => [];

  const persist = typeof onPersist === "function" ? onPersist : () => {};
  let nextPackId = computeNextPackId(getCurrentItems());

  function refreshNextPackId() {
    nextPackId = computeNextPackId(getCurrentItems());
  }

  function updatePackProgress() {
    if (!progressEl || !progressLabelEl || !progressPctEl) {
      return;
    }

    const items = getCurrentItems();
    const total = items.length;
    const checked = items.filter((item) => item.done).length;
    const ratio = total === 0 ? 0 : (checked / total) * 100;
    progressEl.style.width = ratio + "%";
    progressLabelEl.textContent = checked + " / " + total + " packed";
    progressPctEl.textContent = Math.round(ratio) + "%";
  }

  function renderPackList() {
    if (!listEl) {
      return;
    }
    listEl.innerHTML = "";

    const items = getCurrentItems();
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "pack-item";
      row.dataset.id = String(item.id);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(item.done);
      checkbox.setAttribute("aria-label", "Mark item packed");

      const label = document.createElement("span");
      label.className = "pack-label" + (item.done ? " done" : "");
      label.textContent = item.text;

      const actionsEl = document.createElement("div");
      actionsEl.className = "item-actions";

      const editBtn = document.createElement("button");
      editBtn.className = "act-btn";
      editBtn.type = "button";
      editBtn.title = "Edit item";
      editBtn.setAttribute("aria-label", "Edit item");
      editBtn.innerHTML = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7\"/><path d=\"M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z\"/></svg>";

      const removeBtn = document.createElement("button");
      removeBtn.className = "act-btn del";
      removeBtn.type = "button";
      removeBtn.title = "Remove item";
      removeBtn.setAttribute("aria-label", "Remove item");
      removeBtn.innerHTML = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"3 6 5 6 21 6\"/><path d=\"M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\"/><path d=\"M10 11v6M14 11v6\"/><path d=\"M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2\"/></svg>";

      checkbox.addEventListener("change", () => {
        actions.togglePackItem(item.id);
        persist();
        renderPackList();
      });

      editBtn.addEventListener("click", () => {
        startPackItemEdit(item.id);
      });

      removeBtn.addEventListener("click", () => {
        actions.removePackItem(item.id);
        refreshNextPackId();
        persist();
        renderPackList();
      });

      label.addEventListener("dblclick", () => {
        startPackItemEdit(item.id);
      });

      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(removeBtn);

      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(actionsEl);
      listEl.appendChild(row);
    });

    updatePackProgress();
  }

  function startPackItemEdit(id) {
    if (!listEl) {
      return;
    }

    const item = getCurrentItems().find((entry) => entry.id === id);
    const row = listEl.querySelector('[data-id="' + id + '"]');
    if (!item || !row) {
      return;
    }

    const label = row.querySelector(".pack-label");
    const actionsEl = row.querySelector(".item-actions");
    if (!label || !actionsEl) {
      return;
    }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "pack-edit-input";
    input.value = item.text;
    input.maxLength = 100;

    label.replaceWith(input);
    actionsEl.style.visibility = "hidden";
    input.focus();
    input.select();

    const commit = () => {
      const value = input.value.trim();
      if (value) {
        actions.updatePackItemText(id, value);
        persist();
      }
      renderPackList();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
      if (event.key === "Escape") {
        renderPackList();
      }
    });
  }

  if (addItemFormEl) {
    addItemFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = newItemInputEl ? newItemInputEl.value.trim().slice(0, 100) : "";
      if (!value) {
        return;
      }

      actions.addPackItem({
        id: nextPackId++,
        text: value,
        done: false
      });
      persist();
      renderPackList();

      if (newItemInputEl) {
        newItemInputEl.value = "";
        newItemInputEl.focus();
      }
    });
  }

  function setItems(items, options = {}) {
    actions.setPackItems(items);
    refreshNextPackId();
    persist(options);
    renderPackList();
  }

  return {
    render: renderPackList,
    setItems,
    getItems: getCurrentItems,
    refreshNextPackId,
    startEdit: startPackItemEdit
  };
}

