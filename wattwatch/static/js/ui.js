// Shared UI helpers: toasts and a promise-based confirm modal.
const $ = (id) => document.getElementById(id);

export function toast(title, message = "", kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const b = document.createElement("b");
  b.textContent = title;
  const span = document.createElement("span");
  span.textContent = message;
  el.append(b, span);
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .4s, transform .4s";
    el.style.opacity = "0";
    el.style.transform = "translateY(10px)";
    setTimeout(() => el.remove(), 450);
  }, kind === "warn" ? 12000 : 7000);
}

export function confirmModal(title, html, okLabel = "OK") {
  return new Promise((resolve) => {
    const m = $("modal");
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = html;
    $("modalOk").textContent = okLabel;
    m.classList.remove("hidden");
    const done = (v) => {
      m.classList.add("hidden");
      $("modalOk").onclick = $("modalCancel").onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    $("modalOk").onclick = () => done(true);
    $("modalCancel").onclick = () => done(false);
    $("modalOk").focus();
  });
}
