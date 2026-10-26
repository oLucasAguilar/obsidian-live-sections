// Drives a throwaway Obsidian (own profile and vault) over CDP and turns screenshots into a GIF.
// Each frame carries its own duration, so typing can be fast and real waits (a hover delay) stay real.
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open({ id, pluginDir, files, notes, theme = 'dark', width = 820, height = 460, openNote, css = '', port = 9341 }) {
  // a run that crashed leaves its Obsidian on the port; connecting to it would record the wrong vault
  try { execFileSync('pkill', ['-f', `remote-debugging-port=${port}`]); await sleep(1500); } catch {}
  const root = path.join(os.homedir(), 'snap/obsidian/common', `demo-${id}`); // the snap cannot see /tmp
  fs.rmSync(root, { recursive: true, force: true });
  const vault = path.join(root, 'vault'), profile = path.join(root, 'profile');
  const plug = path.join(vault, '.obsidian/plugins', id);
  fs.mkdirSync(plug, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(pluginDir, f), path.join(plug, f));
  for (const [name, text] of Object.entries(notes)) { fs.mkdirSync(path.dirname(path.join(vault, name)), { recursive: true }); fs.writeFileSync(path.join(vault, name), text); }
  fs.writeFileSync(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify([id]));
  fs.writeFileSync(path.join(vault, '.obsidian/app.json'), JSON.stringify({ livePreview: true, showInlineTitle: true, promptDelete: false, autoPairBrackets: false, autoPairMarkdown: false }));
  fs.writeFileSync(path.join(vault, '.obsidian/appearance.json'), JSON.stringify({ theme: theme == 'dark' ? 'obsidian' : 'moonstone', baseFontSize: 16 }));
  fs.writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({ vaults: { demo: { path: vault, ts: 1, open: true } } }));
  const proc = spawn('obsidian', [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { await sleep(500); browser = await chromium.connectOverCDP(`http://localhost:${port}`).catch(() => null); }
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html')); if (!page) await sleep(500); }
  await page.waitForFunction(() => window.app && app.workspace && app.workspace.layoutReady, null, { timeout: 30000 });
  await page.setViewportSize({ width, height });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // keys land even when the window is not focused
  // first open of a vault with plugins asks whether to trust it
  const trust = page.locator('button', { hasText: 'Trust author' });
  await trust.waitFor({ timeout: 8000 }).then(() => trust.click()).catch(() => {});
  await sleep(500);
  await page.evaluate(async ({ id, openNote, css }) => {
    document.querySelectorAll('.modal-close-button').forEach(b => b.click());
    await app.plugins.setEnable(true); await app.plugins.loadManifests(); await app.plugins.enablePluginAndSave(id);
    app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
    const st = document.createElement('style');
    st.textContent = `.workspace-ribbon,.status-bar,.titlebar,.workspace-tab-header-container,.view-header,.side-dock-ribbon{display:none!important}
      .workspace{padding-top:0!important}body{--titlebar-height:0px} ${css}`;
    document.head.appendChild(st);
    await app.workspace.openLinkText(openNote, '', false);
  }, { id, openNote, css });
  await sleep(800);
  return new Demo(browser, page, proc, root);
}

class Demo {
  constructor(browser, page, proc, root) { Object.assign(this, { browser, page, proc, root, frames: [], dir: fs.mkdtempSync(path.join(os.tmpdir(), 'obs-demo-')) }); }
  async snap(ms) { const f = path.join(this.dir, `${String(this.frames.length).padStart(4, '0')}.png`); await this.page.screenshot({ path: f }); this.frames.push([f, ms]); }
  hold(ms) { return this.snap(ms); }
  // key events do not reach an unfocused Electron window; inserted text does
  async type(text, ms = 55) { for (const ch of text) { await this.js(c => { const e = app.workspace.activeEditor.editor; e.replaceSelection(c); }, ch); await sleep(15); await this.snap(ms); } await this.js(() => app.workspace.activeEditor.editor.focus()); }
  async focusEnd() { await this.js(() => { const e = app.workspace.activeEditor.editor; e.setCursor(e.lastLine(), e.getLine(e.lastLine()).length); e.focus(); }); }
  async cursor(line, ch = 0) { await this.js(({ line, ch }) => { const e = app.workspace.activeEditor.editor; e.setCursor(line, ch); e.focus(); }, { line, ch }); await sleep(250); }
  // at = { x, y } puts the key next to what it acts on, so the eye does not have to travel to a corner
  async badge(text, at) { await this.js(({ t, at }) => { let b = document.getElementById('demo-key'); if (!b) { b = document.createElement('div'); b.id = 'demo-key'; document.body.appendChild(b); }
    const where = at ? `left:${at.x}px;top:${at.y}px;` : 'right:16px;bottom:14px;';
    b.textContent = t; b.style.cssText = 'position:fixed;' + where + 'padding:4px 10px;border-radius:6px;font:13px var(--font-monospace);background:var(--interactive-accent);color:var(--text-on-accent);z-index:99999;display:' + (t ? 'block' : 'none'); }, { t: text, at }); }
  // an unfocused window draws no text cursor, so one is drawn at the editor's real cursor position
  async caret(show = true) { return this.js(show => { const v = app.workspace.activeEditor.editor.cm, r = v.coordsAtPos(v.state.selection.main.head);
    let c = document.getElementById('demo-caret'); if (!c) { c = document.createElement('div'); c.id = 'demo-caret'; document.body.appendChild(c); }
    c.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;height:${r.bottom - r.top}px;border-left:2px solid var(--text-normal);z-index:99998;pointer-events:none;display:${show ? 'block' : 'none'}`;
    return { x: r.left, y: (r.top + r.bottom) / 2 }; }, show); }
  async cmd(id, label, ms = 900) { if (label) { await this.badge(label); await this.snap(350); } await this.js(id => app.commands.executeCommandById(id), id); await sleep(300); await this.snap(ms); if (label) await this.badge(''); }
  async live(total) { // real time: each frame lasts as long as it really took
    const end = Date.now() + total; let t = Date.now();
    while (Date.now() < end) { await this.snap(0); const now = Date.now(); this.frames[this.frames.length - 1][1] = now - t; t = now; }
  }
  js(fn, arg) { return this.page.evaluate(fn, arg); }
  // screenshots do not show the OS pointer, so one is drawn where the mouse is
  async pointer(x, y, { steps = 10, ms = 40 } = {}) {
    const from = this.at || { x: x + 120, y: y + 80 };
    for (let i = 1; i <= steps; i++) {
      const px = from.x + (x - from.x) * i / steps, py = from.y + (y - from.y) * i / steps;
      await this.page.mouse.move(px, py);
      await this.js(({ px, py }) => { let p = document.getElementById('demo-pointer');
        if (!p) { p = document.createElement('div'); p.id = 'demo-pointer'; p.innerHTML = '<svg width="18" height="26" viewBox="0 0 18 26"><path d="M1 1 L1 20 L6 15 L10 24 L13 23 L9 14 L16 14 Z" fill="white" stroke="black" stroke-width="1.5"/></svg>';
          p.style.cssText = 'position:fixed;pointer-events:none;z-index:999999'; document.body.appendChild(p); }
        p.style.left = px + 'px'; p.style.top = py + 'px'; }, { px, py });
      await this.snap(ms);
    }
    this.at = { x, y };
  }
  async click(ms = 500) { await this.page.mouse.down(); await this.page.mouse.up(); await sleep(250); await this.snap(ms); }
  async textEnd(selector, text) { return this.js(({ selector, text }) => { const l = [...document.querySelectorAll(selector)].find(x => x.textContent.includes(text));
    const r = document.createRange(); r.selectNodeContents(l); const rc = r.getBoundingClientRect(); return { x: rc.right - 1, y: rc.top + rc.height / 2 }; }, { selector, text }); }
  async textStart(selector, text) { return this.js(({ selector, text }) => { const l = [...document.querySelectorAll(selector)].find(x => x.textContent.includes(text));
    const r = document.createRange(); r.selectNodeContents(l); const rc = r.getBoundingClientRect(); return { x: rc.left + 1, y: rc.top + rc.height / 2 }; }, { selector, text }); }
  async keys(text, ms = 70) { for (const ch of text) { await this.page.keyboard.insertText(ch); await sleep(15); await this.snap(ms); } }
  async lineOf(text) { return this.js(t => app.workspace.activeEditor.editor.getValue().split('\n').findIndex(l => l.includes(t)), text); }
  async box(selector, nth = 0) { return this.page.locator(selector).nth(nth).boundingBox(); }
  async split(note) { await this.js(async n => { const f = app.vault.getAbstractFileByPath(n); const leaf = app.workspace.getLeaf('split', 'vertical'); await leaf.openFile(f); }, note); await sleep(600); }
  async focusLeaf(i) { await this.js(i => { const leaves = app.workspace.getLeavesOfType('markdown'); app.workspace.setActiveLeaf(leaves[i], { focus: true }); }, i); await sleep(200); }
  async gif(out) {
    const list = this.frames.map(([f, ms]) => `file '${f}'\nduration ${(Math.max(ms, 20) / 1000).toFixed(3)}`).join('\n') + `\nfile '${this.frames.at(-1)[0]}'\n`;
    fs.writeFileSync(path.join(this.dir, 'list.txt'), list);
    const pal = path.join(this.dir, 'pal.png'), lst = path.join(this.dir, 'list.txt');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', 'palettegen=stats_mode=full', pal]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-i', pal, '-lavfi', 'paletteuse=dither=none', '-loop', '0', out]);
    return { out, frames: this.frames.length, seconds: this.frames.reduce((a, [, ms]) => a + ms, 0) / 1000, kb: Math.round(fs.statSync(out).size / 1024) };
  }
  async close() {
    await this.browser.close().catch(() => {});
    try { process.kill(-this.proc.pid); } catch {} await sleep(800);
    fs.rmSync(this.dir, { recursive: true, force: true }); fs.rmSync(this.root, { recursive: true, force: true });
  }
}
module.exports = { open, sleep };
