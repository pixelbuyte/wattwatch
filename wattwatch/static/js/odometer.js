// Mechanical odometer: each digit is a strip of 0-9 0-9 that rolls forward.
// Rolling past 9 animates into the second set, then silently snaps back.

export class Odometer {
  constructor(el, { decimals = 4, prefix = "$" } = {}) {
    this.el = el;
    this.decimals = decimals;
    this.prefix = prefix;
    this.value = null;
    this.cols = [];
    this.layout = "";
    el.classList.add("odo");
    el.setAttribute("role", "text");
  }

  _format(v) {
    return Math.max(0, v).toFixed(this.decimals);
  }

  _build(text) {
    this.el.innerHTML = "";
    this.cols = [];
    const pre = document.createElement("span");
    pre.className = "odo-prefix";
    pre.textContent = this.prefix;
    this.el.appendChild(pre);
    for (const ch of text) {
      if (ch === ".") {
        const sep = document.createElement("span");
        sep.className = "odo-sep";
        sep.textContent = ".";
        this.el.appendChild(sep);
        continue;
      }
      const cell = document.createElement("span");
      cell.className = "odo-digit";
      const strip = document.createElement("span");
      strip.className = "odo-strip";
      for (let i = 0; i < 20; i++) {
        const d = document.createElement("span");
        d.textContent = String(i % 10);
        strip.appendChild(d);
      }
      cell.appendChild(strip);
      this.el.appendChild(cell);
      const col = { strip, digit: Number(ch) };
      strip.style.transform = `translateY(${-col.digit * 5}%)`;
      strip.addEventListener("transitionend", () => {
        if (col.pos >= 10) {
          strip.style.transition = "none";
          strip.style.transform = `translateY(${-(col.pos - 10) * 5}%)`;
          col.pos -= 10;
          strip.offsetHeight; // reflow so the next change animates again
          strip.style.transition = "";
        }
      });
      col.pos = col.digit;
      this.cols.push(col);
    }
    this.layout = text.replace(/\d/g, "0");
  }

  set(value, prefix) {
    if (prefix !== undefined && prefix !== this.prefix) {
      this.prefix = prefix;
      this.layout = "";
    }
    const text = this._format(value);
    const forward = this.value === null || value >= this.value;
    if (text.replace(/\d/g, "0") !== this.layout) this._build(text);
    const digits = text.replace(".", "");
    digits.split("").forEach((ch, i) => {
      const col = this.cols[i];
      const d = Number(ch);
      if (d === col.digit) return;
      let target = d;
      if (forward && d < col.digit) target = d + 10; // roll forward through the wrap
      col.pos = target;
      col.digit = d;
      col.strip.style.transform = `translateY(${-target * 5}%)`;
    });
    this.value = value;
    this.el.setAttribute("aria-label", `${this.prefix}${text}`);
  }
}
