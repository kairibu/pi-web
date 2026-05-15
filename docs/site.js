const copyButtons = document.querySelectorAll("[data-copy]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const targetSelector = button.getAttribute("data-copy");
    const target = targetSelector === null ? null : document.querySelector(targetSelector);
    const text = target?.textContent?.replace(/^\s*\$ /gm, "").trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1400);
    } catch {
      button.textContent = "Select code";
    }
  });
}
