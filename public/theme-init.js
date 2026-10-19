// Runs before the app loads, so the chosen colour theme is applied without a flash of the wrong one.
(function () {
  try {
    const saved = localStorage.getItem("lanternpdf-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch {
    // Storage can be blocked; the system preference applies.
  }
})();
