const header = document.querySelector("[data-header]");
const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");

function updateHeader() {
  header?.classList.toggle("is-scrolled", window.scrollY > 18);
}

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

navToggle?.addEventListener("click", () => {
  const open = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!open));
  nav?.classList.toggle("is-open", !open);
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navToggle?.setAttribute("aria-expanded", "false");
    nav?.classList.remove("is-open");
  });
});

document.addEventListener("click", (event) => {
  if (!nav?.classList.contains("is-open")) return;
  if (nav.contains(event.target) || navToggle?.contains(event.target)) return;
  navToggle?.setAttribute("aria-expanded", "false");
  nav.classList.remove("is-open");
});

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealItems = document.querySelectorAll("[data-reveal]");

if (reduceMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.12 });

  revealItems.forEach((item) => revealObserver.observe(item));
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const label = button.querySelector("span");
    const initial = label?.textContent || "Copy";

    try {
      await navigator.clipboard.writeText(button.dataset.copy || "");
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Select and copy";
    }

    window.setTimeout(() => {
      if (label) label.textContent = initial;
    }, 1800);
  });
});

const installTabs = document.querySelectorAll("[data-install-tab]");
const installPanels = document.querySelectorAll("[data-install-panel]");

function selectInstallTab(name) {
  installTabs.forEach((tab) => {
    const selected = tab.dataset.installTab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });

  installPanels.forEach((panel) => {
    panel.hidden = panel.dataset.installPanel !== name;
  });
}

installTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectInstallTab(tab.dataset.installTab));
  tab.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = installTabs[(index + direction + installTabs.length) % installTabs.length];
    selectInstallTab(next.dataset.installTab);
    next.focus();
  });
});

document.querySelectorAll("[data-year]").forEach((year) => {
  year.textContent = String(new Date().getFullYear());
});
