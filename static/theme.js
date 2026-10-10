(function () {
  const storageKey = "base4nfdi-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function getSystemTheme() {
    return media.matches ? "dark" : "light";
  }

  function getPref() {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch (error) {
      return "system";
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  }

  /** Pick light-theme artwork vs dark-theme artwork from `data-theme`. */
  function themedLogoSrc(lightSrc, darkSrc) {
    const light = lightSrc || darkSrc || "";
    const dark = darkSrc || lightSrc || "";
    return currentTheme() === "dark" ? dark : light;
  }

  window.base4nfdiTheme = { currentTheme, themedLogoSrc };

  function applyPref(pref) {
    const theme = pref === "system" ? getSystemTheme() : pref;
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-pref", pref);
    root.style.colorScheme = theme;

    document.querySelectorAll("#theme-switch .theme-switch-input").forEach((input) => {
      input.checked = input.value === pref;
    });
  }

  function setPref(pref) {
    try {
      if (pref === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, pref);
    } catch (error) {
      /* Private mode and locked-down Firefox can throw on storage access. */
    }
    applyPref(pref);
  }

  media.addEventListener("change", () => {
    if (getPref() === "system") applyPref("system");
  });

  function init() {
    applyPref(getPref());

    const group = document.getElementById("theme-switch");
    if (!group) return;

    group.addEventListener("change", (event) => {
      const input = event.target;
      if (!input || !input.classList || !input.classList.contains("theme-switch-input")) return;
      setPref(input.value);
    });

    requestAnimationFrame(() => group.classList.add("is-ready"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
