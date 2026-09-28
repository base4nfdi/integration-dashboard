(function () {
  const storageKey = "base4nfdi-theme";
  const prefs = ["dark", "system", "light"];
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function getSystemTheme() {
    return media.matches ? "dark" : "light";
  }

  function getPref() {
    const stored = localStorage.getItem(storageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  }

  function applyPref(pref) {
    const theme = pref === "system" ? getSystemTheme() : pref;
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-pref", pref);
    root.style.colorScheme = theme;

    document.querySelectorAll("#theme-switch [data-theme-value]").forEach((option) => {
      const active = option.dataset.themeValue === pref;
      option.setAttribute("aria-checked", String(active));
      option.tabIndex = active ? 0 : -1;
    });
  }

  function setPref(pref) {
    if (pref === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, pref);
    applyPref(pref);
  }

  media.addEventListener("change", () => {
    if (getPref() === "system") applyPref("system");
  });

  document.addEventListener("DOMContentLoaded", () => {
    applyPref(getPref());

    const group = document.getElementById("theme-switch");
    if (!group) return;

    group.addEventListener("click", (event) => {
      const option = event.target.closest("[data-theme-value]");
      if (option) setPref(option.dataset.themeValue);
    });

    group.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = prefs[(prefs.indexOf(getPref()) + step + prefs.length) % prefs.length];
      setPref(next);
      group.querySelector(`[data-theme-value="${next}"]`).focus();
    });

    requestAnimationFrame(() => group.classList.add("is-ready"));
  });
})();
