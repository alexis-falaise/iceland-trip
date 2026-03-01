export function createStore(initialState = {}) {
  let state = { ...initialState };
  const listeners = new Set();

  function getState() {
    return state;
  }

  function setState(partialOrUpdater) {
    const partial =
      typeof partialOrUpdater === "function"
        ? partialOrUpdater(state)
        : partialOrUpdater;

    if (!partial || typeof partial !== "object") {
      return state;
    }

    const previousState = state;
    state = {
      ...state,
      ...partial
    };

    listeners.forEach((listener) => {
      listener(state, previousState);
    });

    return state;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    getState,
    setState,
    subscribe
  };
}

