function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.round(numeric);
}

function sanitizeTripCode(value) {
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

function sanitizePackItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  let fallbackId = 1;
  return rawItems
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
}

function sanitizeBudgetState(rawBudget) {
  const parsed = rawBudget && typeof rawBudget === "object" ? rawBudget : {};
  const maxBudgetISK = toNonNegativeInteger(parsed.maxBudgetISK);
  const expenses = Array.isArray(parsed.expenses)
    ? parsed.expenses
        .filter((item) => item && typeof item.name === "string")
        .map((item, index) => ({
          id: Number.isFinite(Number(item.id)) ? Number(item.id) : index + 1,
          name: String(item.name).trim().slice(0, 100),
          amountISK: toNonNegativeInteger(item.amountISK),
          createdAt: Number.isFinite(Number(item.createdAt))
            ? Number(item.createdAt)
            : null
        }))
        .filter((item) => item.name.length > 0)
    : [];

  return {
    maxBudgetISK,
    expenses
  };
}

function sanitizeActiveTab(value) {
  const allowedTabs = new Set(["home", "itinerary", "tools"]);
  return allowedTabs.has(value) ? value : "home";
}

export function createActions(store) {
  const { getState, setState } = store;

  return {
    hydrate(partialState) {
      return setState(partialState);
    },

    setPackItems(items) {
      return setState({
        packItems: sanitizePackItems(items)
      });
    },

    togglePackItem(id) {
      const numericId = Number(id);
      return setState((state) => ({
        packItems: (state.packItems || []).map((item) =>
          item.id === numericId
            ? { ...item, done: !Boolean(item.done) }
            : item
        )
      }));
    },

    addPackItem(payload) {
      const nextItem = payload && typeof payload === "object" ? payload : {};
      const id = Number(nextItem.id);
      const text = String(nextItem.text || "").trim().slice(0, 100);
      if (!Number.isFinite(id) || id <= 0 || !text) {
        return getState();
      }

      return setState((state) => ({
        packItems: [
          ...(state.packItems || []),
          {
            id,
            text,
            done: Boolean(nextItem.done)
          }
        ]
      }));
    },

    updatePackItemText(id, text) {
      const numericId = Number(id);
      const nextText = String(text || "").trim().slice(0, 100);
      if (!nextText) {
        return getState();
      }

      return setState((state) => ({
        packItems: (state.packItems || []).map((item) =>
          item.id === numericId
            ? { ...item, text: nextText }
            : item
        )
      }));
    },

    removePackItem(id) {
      const numericId = Number(id);
      return setState((state) => ({
        packItems: (state.packItems || []).filter((item) => item.id !== numericId)
      }));
    },

    setBudget(nextBudget) {
      return setState({
        budget: sanitizeBudgetState(nextBudget)
      });
    },

    setBudgetMaxISK(maxBudgetISK) {
      return setState((state) => ({
        budget: {
          ...(state.budget || { maxBudgetISK: 0, expenses: [] }),
          maxBudgetISK: toNonNegativeInteger(maxBudgetISK)
        }
      }));
    },

    addExpense(expense) {
      const nextExpense = expense && typeof expense === "object" ? expense : {};
      const id = Number(nextExpense.id);
      const name = String(nextExpense.name || "").trim().slice(0, 100);
      const amountISK = toNonNegativeInteger(nextExpense.amountISK);
      const createdAt = Number.isFinite(Number(nextExpense.createdAt))
        ? Number(nextExpense.createdAt)
        : Date.now();

      if (!Number.isFinite(id) || id <= 0 || !name || !amountISK) {
        return getState();
      }

      return setState((state) => ({
        budget: {
          ...(state.budget || { maxBudgetISK: 0, expenses: [] }),
          expenses: [
            ...((state.budget && state.budget.expenses) || []),
            {
              id,
              name,
              amountISK,
              createdAt
            }
          ]
        }
      }));
    },

    updateExpense(id, patch) {
      const numericId = Number(id);
      const patchObject = patch && typeof patch === "object" ? patch : {};

      return setState((state) => ({
        budget: {
          ...(state.budget || { maxBudgetISK: 0, expenses: [] }),
          expenses: ((state.budget && state.budget.expenses) || []).map((expense) => {
            if (expense.id !== numericId) {
              return expense;
            }

            const nextName =
              typeof patchObject.name === "string"
                ? patchObject.name.trim().slice(0, 100)
                : expense.name;
            const nextAmount =
              patchObject.amountISK === undefined
                ? expense.amountISK
                : toNonNegativeInteger(patchObject.amountISK);

            return {
              ...expense,
              name: nextName || expense.name,
              amountISK: nextAmount
            };
          })
        }
      }));
    },

    removeExpense(id) {
      const numericId = Number(id);
      return setState((state) => ({
        budget: {
          ...(state.budget || { maxBudgetISK: 0, expenses: [] }),
          expenses: ((state.budget && state.budget.expenses) || []).filter(
            (expense) => expense.id !== numericId
          )
        }
      }));
    },

    setActiveTab(tab) {
      return setState({
        activeTab: sanitizeActiveTab(tab)
      });
    },

    setModuleCollapseState(moduleCollapse) {
      const nextState =
        moduleCollapse && typeof moduleCollapse === "object"
          ? moduleCollapse
          : {};
      return setState({
        moduleCollapse: { ...nextState }
      });
    },

    setModuleCollapsed(moduleKey, collapsed) {
      return setState((state) => ({
        moduleCollapse: {
          ...(state.moduleCollapse || {}),
          [moduleKey]: Boolean(collapsed)
        }
      }));
    },

    setSyncSettings(nextSettingsOrUpdater) {
      return setState((state) => {
        const current = state.syncSettings || {
          tripId: "",
          autoSync: true
        };
        const next =
          typeof nextSettingsOrUpdater === "function"
            ? nextSettingsOrUpdater(current)
            : nextSettingsOrUpdater;
        const parsed = next && typeof next === "object" ? next : {};
        return {
          syncSettings: {
            tripId: sanitizeTripCode(parsed.tripId),
            autoSync: parsed.autoSync !== false
          }
        };
      });
    },

    setTodayOverview(nextOverviewOrUpdater) {
      return setState((state) => {
        const current = state.todayOverview || {};
        const next =
          typeof nextOverviewOrUpdater === "function"
            ? nextOverviewOrUpdater(current)
            : nextOverviewOrUpdater;
        if (!next || typeof next !== "object") {
          return {};
        }
        return {
          todayOverview: {
            ...current,
            ...next
          }
        };
      });
    }
  };
}

export const stateSanitizers = {
  sanitizePackItems,
  sanitizeBudgetState
};

